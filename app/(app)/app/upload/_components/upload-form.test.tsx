// @vitest-environment jsdom
// upload-form.tsx の client-side 制限ロジックテスト。
//
// 検証観点 (Task 7):
// - totalRequestedPages > OCR_MAX_PAGES (40) で submit button が disabled
// - totalRequestedPages === 40 (境界) は page cap では disabled にならない
// - overPageCap 超過時に 40 page 上限文言が表示される
// - 既存の overQuota / alreadyAtQuota banner との併存
//
// ②-4a-cutover(2026-08-02): submit 時の呼出列を legacy processUpload(fd) から
// 新 flow(prepareUpload → reserveSource/PUT/finalizeSource → claimOperation →
// stagePrepared → publishPreparedUpload)へ差し替えたため、 submit を実際に fire する
// テスト群は新 action group をモックする。 entries 管理 / page-cap 判定 (submit を
// fire しない範囲)は runProcess 変更の影響を受けないため無改修。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// --- モック ---

// next/navigation: useRouter を stub(安定した push spy で遷移先を検証する)
const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

// ②-4a-cutover: 新 flow の 5 action をモックする(legacy processUpload はもう
// upload-form.tsx から呼ばれないため vi.mock 対象から除去)。
vi.mock('../_actions/prepare-upload', () => ({
  prepareUpload: vi.fn(),
}))
vi.mock('../_actions/source-asset-actions', () => ({
  reserveSource: vi.fn(),
  finalizeSource: vi.fn(),
}))
vi.mock('../_actions/claim-operation', () => ({
  claimOperation: vi.fn(),
}))
vi.mock('../_actions/stage-prepared', () => ({
  stagePrepared: vi.fn(),
}))
vi.mock('../_actions/publish-prepared', () => ({
  publishPreparedUpload: vi.fn(),
}))
// ②-4a-cutover 案 D: operation 作成後の失敗表示時に abandon を await する。
vi.mock('../_actions/abandon-operation', () => ({
  abandonUploadOperation: vi.fn(),
}))

// browser-image-compression: input file をそのまま返す no-op(spy で呼出 options を検証)。
const { mockImageCompression } = vi.hoisted(() => ({
  mockImageCompression: vi.fn(async (file: File) => file),
}))
vi.mock('browser-image-compression', () => ({
  default: mockImageCompression,
}))

// pdfPageCount: テストごとに制御するため factory mock
const mockPdfPageCount = vi.fn<(f: File) => Promise<number>>()
vi.mock('../_lib/pdf-page-count', () => ({
  pdfPageCount: (f: File) => mockPdfPageCount(f),
}))

// ocr-poll-signal: requestOcrPoll が submit 時に呼ばれることを検証するためにモック
vi.mock('@/lib/exams/ocr-poll-signal', () => ({
  requestOcrPoll: vi.fn(),
  subscribeOcrPoll: vi.fn(() => () => {}),
}))

// URL.createObjectURL / revokeObjectURL: jsdom に未実装のため stub
Object.defineProperty(globalThis, 'URL', {
  value: {
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  },
  writable: true,
})

// crypto.randomUUID: jsdom で利用可能だが念のため
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => `uuid-${Math.random()}` },
    writable: true,
  })
}

// ②-4a-cutover: upload-form.tsx の getImageDimensions が使う Image.decode() stub
// (WebKit-safe pattern。 card-image-gallery.test.tsx の stub と同型)。 画像 source の
// width/height は固定値を返せば十分(prepareUpload はモックのため実値は無関係)。
class StubImage {
  src = ''
  decode(): Promise<void> {
    return Promise.resolve()
  }
  get naturalWidth(): number {
    return 800
  }
  get naturalHeight(): number {
    return 600
  }
}
vi.stubGlobal('Image', StubImage)

import { UploadForm } from './upload-form'
import { prepareUpload } from '../_actions/prepare-upload'
import { reserveSource, finalizeSource } from '../_actions/source-asset-actions'
import { claimOperation } from '../_actions/claim-operation'
import { stagePrepared } from '../_actions/stage-prepared'
import { publishPreparedUpload } from '../_actions/publish-prepared'
import { abandonUploadOperation } from '../_actions/abandon-operation'
import { requestOcrPoll } from '@/lib/exams/ocr-poll-signal'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { MAX_PDF_PAGES } from '../_lib/constants'

// デフォルト props (Pro: 上限なし、残量制限なし)
const DEFAULT_PROPS = {
  existingExams: [],
  currentMonthPages: 0,
  monthlyLimit: null as number | null,
  remaining: null as number | null,
  plan: 'pro' as 'free' | 'standard' | 'pro',
}

/** 指定 pageCount の PDF File を生成するヘルパー */
function makePdf(name: string): File {
  return new File(['%PDF-1.4'], name, { type: 'application/pdf' })
}

/** 画像 File を生成するヘルパー */
function makeImage(name: string): File {
  return new File(['fake-img'], name, { type: 'image/jpeg' })
}

/**
 * FileList の読み取り専用制約を回避して、任意の File 配列を file input に注入する。
 * jsdom には DataTransfer が未実装のため、 files getter を直接 defineProperty で上書く。
 */
function makeFileList(files: File[]): FileList {
  // FileList インターフェースを満たす最小限のオブジェクトを生成。
  // item() / 数値インデックス / length の 3 点のみ必要 (handleAdd は Array.from で展開)。
  const fileList = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () { yield* files },
  } as unknown as FileList
  files.forEach((f, i) => {
    Object.defineProperty(fileList, i, { value: f, enumerable: true })
  })
  return fileList
}

/**
 * UploadForm をレンダリングし、指定ファイルを追加した後の state が安定するまで待つ。
 * pdfPageCount は呼び出し前に mockPdfPageCount.mockResolvedValue(...) で設定する。
 */
async function renderWithFiles(
  files: File[],
  props: Partial<typeof DEFAULT_PROPS> = {},
) {
  const merged = { ...DEFAULT_PROPS, ...props }
  render(<UploadForm {...merged} />)

  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).toBeTruthy()

  await act(async () => {
    // jsdom は files プロパティが read-only のため defineProperty で上書く。
    const fileList = makeFileList(files)
    Object.defineProperty(input, 'files', { value: fileList, configurable: true })
    fireEvent.change(input)
    // pdfPageCount / imageCompression の非同期処理完了を待つ
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // デフォルト: PDF は 10 ページ
  mockPdfPageCount.mockResolvedValue(10)
  // デフォルト: abandon は terminalize 成功(completed でない)。
  vi.mocked(abandonUploadOperation).mockResolvedValue({ outcome: 'abandoned' })
})

afterEach(() => {
  cleanup()
})

// ─── submit button disabled テスト ───────────────────────────────────────────

describe('overPageCap: submit button の disable 判定', () => {
  it('totalRequestedPages > OCR_MAX_PAGES (41 pages) で submit disabled', async () => {
    // 5 ページ PDF × 9 = 45 pages > 40
    mockPdfPageCount.mockResolvedValue(5)
    const files = Array.from({ length: 9 }, (_, i) => makePdf(`doc${i}.pdf`))
    await renderWithFiles(files)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })

  it('totalRequestedPages === OCR_MAX_PAGES (境界 40 pages) は page cap で disabled にならない', async () => {
    // 10 ページ PDF × 4 = 40 pages = OCR_MAX_PAGES
    mockPdfPageCount.mockResolvedValue(10)
    const files = Array.from({ length: 4 }, (_, i) => makePdf(`doc${i}.pdf`))
    await renderWithFiles(files)

    // overPageCap は false のはず (40 > 40 は偽)
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeEnabled()
  })

  it('per-upload 合計が OCR_MAX_PAGES + 2 (42 pages) で overPageCap により disabled', async () => {
    // 21 ページ PDF × 2 = 42 pages > OCR_MAX_PAGES(40)。
    // 各 file は MAX_PDF_PAGES(40) 以下なので per-file エラーにはならず、
    // overPageCap(合計超過) パスのみが button を disable にする。
    mockPdfPageCount.mockResolvedValue(21)
    const files = [makePdf('a.pdf'), makePdf('b.pdf')]
    await renderWithFiles(files)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()

    // overPageCap banner (per-upload 超過メッセージ) が表示され、
    // per-file エラー alert は存在しない (disabled の原因が overPageCap であることを確認)
    const alerts = screen.getAllByRole('alert')
    const capAlert = alerts.find((el) =>
      el.textContent?.includes(`合計 ${OCR_MAX_PAGES} ページまでアップロード可能です`),
    )
    expect(capAlert).toBeTruthy()
  })

  it('画像 + PDF の合計が 41 pages で disabled', async () => {
    // PDF 40 ページ + 画像 1 枚 = 41 pages
    mockPdfPageCount.mockResolvedValue(40)
    const files = [makePdf('doc.pdf'), makeImage('img.jpg')]
    await renderWithFiles(files)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })
})

// ─── UI 文言 テスト ────────────────────────────────────────────────────────────

describe('overPageCap: UI 文言表示', () => {
  it('totalRequestedPages > OCR_MAX_PAGES で超過 banner が表示される', async () => {
    // 各 file は per-file (MAX_PDF_PAGES=40) 以下、 合計 > OCR_MAX_PAGES=40 で overPageCap
    mockPdfPageCount.mockResolvedValue(21)
    const files = [makePdf('a.pdf'), makePdf('b.pdf')] // 21+21=42 > 40
    await renderWithFiles(files)

    // OCR_MAX_PAGES (40) が interpolation で含まれた文言が表示される
    const alerts = screen.getAllByRole('alert')
    const capAlert = alerts.find((el) =>
      el.textContent?.includes(`合計 ${OCR_MAX_PAGES} ページまでアップロード可能です`),
    )
    expect(capAlert).toBeTruthy()
  })

  it('totalRequestedPages === 40 では page cap banner が表示されない', async () => {
    mockPdfPageCount.mockResolvedValue(10)
    const files = Array.from({ length: 4 }, (_, i) => makePdf(`doc${i}.pdf`))
    await renderWithFiles(files)

    expect(
      screen.queryByText(/合計 40 ページまでアップロード可能です/),
    ).not.toBeInTheDocument()
  })

  it('overPageCap banner は overQuota banner と同時に表示できる (独立した上限)', async () => {
    // 各 file は per-file 以下だが合計 > OCR_MAX_PAGES=40、 かつ remaining=30 も超過
    mockPdfPageCount.mockResolvedValue(21)
    const files = [makePdf('a.pdf'), makePdf('b.pdf')] // 21+21=42 > 40
    await renderWithFiles(files, {
      plan: 'free',
      remaining: 30,
      monthlyLimit: 100,
    })

    // page cap banner
    expect(
      screen.getByText(/合計 40 ページまでアップロード可能です/),
    ).toBeInTheDocument()
    // overQuota banner
    expect(
      screen.getByText(/今月の残量.*を超過します/),
    ).toBeInTheDocument()
  })

  it('OCR_MAX_PAGES の値がハードコードされていない (interpolation)', async () => {
    // 各 file は per-file 以下だが合計 > OCR_MAX_PAGES=40 → banner に OCR_MAX_PAGES が含まれる
    mockPdfPageCount.mockResolvedValue(21)
    await renderWithFiles([makePdf('x.pdf'), makePdf('y.pdf')]) // 21+21=42 > 40

    const bannerText = screen.getByText(/合計 \d+ ページまでアップロード可能です/)
    expect(bannerText.textContent).toContain(String(OCR_MAX_PAGES))
  })
})

// ─── hideRetryHint テスト ────────────────────────────────────────────────────
// ②-4a-cutover: legacy processUpload の ProcessUploadErrorCode(PAGE_LIMIT_EXCEEDED /
// UPLOAD_IN_PROGRESS / GEMINI_FAILED)を返す server 結果はもう存在しないため、
// 同じ hideRetryHint 導出規則(setError 内で code==='UPLOAD_IN_PROGRESS' の時だけ
// 隠す)を新 flow の outcome から検証する。 加えて ②-4a は画像入稿のみ(PDF は
// ②-4b)であるため、 PDF 1 件でも混在すると送信前に明示ブロックされることを検証する
// (silent partial exclusion 防止・スコープ外の PDF pipeline を新設しない)。

describe('hideRetryHint: 新 flow の outcome から retry hint 表示/非表示を検証', () => {
  it('PDF が混在した submit は送信前にブロックされ、 retry hint は表示される(ファイル変更で解決可能なため)', async () => {
    // PDF 1 枚 (submit できるページ数で投入、 client 制限を回避するため 1 ページ)。
    // prepareUpload 等の action は一切呼ばれない(送信前ガードで return するため
    // モックの設定は不要)。
    mockPdfPageCount.mockResolvedValue(1)
    await renderWithFiles([makePdf('test.pdf')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.getAllByText(/PDF は現在このアップロードでは対応していません/).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText(/ファイルを変更して再度お試しください/),
    ).toBeInTheDocument()
    expect(vi.mocked(prepareUpload)).not.toHaveBeenCalled()
  })

  it('prepareUpload が in_progress(UPLOAD_IN_PROGRESS 相当)を返すと retry hint が非表示 (既存挙動の regression なし)', async () => {
    vi.mocked(prepareUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.queryByText(/ファイルを変更して再度お試しください/),
    ).not.toBeInTheDocument()
  })

  it('stagePrepared が retryable_failed(GEMINI_FAILED 相当)を返すと retry hint が表示される (UPLOAD_IN_PROGRESS と異なる挙動)', async () => {
    vi.mocked(prepareUpload).mockResolvedValueOnce({
      outcome: 'success',
      operationId: 'op-1',
      examId: 'exam-1',
      examName: 'Exam',
      sourceDocumentId: 'doc-123',
      reserved: [],
    })
    vi.mocked(claimOperation).mockResolvedValueOnce({ outcome: 'claimed', leaseVersion: 1 })
    vi.mocked(stagePrepared).mockResolvedValueOnce({
      outcome: 'retryable_failed',
      reason: 'gemini_call_failed',
    })

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.getByText(/ファイルを変更して再度お試しください/),
    ).toBeInTheDocument()
  })
})

// ─── 予期しない throw → OTHER 経路 ─────────────────────────────────────────────
// ②-4a-cutover: 新 flow の各 action は小さな JSON payload のみを運ぶ(file bytes は
// client → R2 presigned PUT で直送する)ため、 Next.js の server action
// body-size-limit(旧 413 検出ロジックが対象にしていた `Body exceeded ...`)はもはや
// 到達不能(構造的に発生し得ない)。 旧「413 文言マップ」テストのうち、 その分岐は
// 削除し、 catch-all(無関係な throw → OTHER + hideRetryHint)のみを維持する。
describe('予期しない throw → OTHER 経路', () => {
  it('prepareUpload が無関係な Error を throw した場合、 既存 OTHER 経路 (試験一覧で確認を) に fall through', async () => {
    vi.mocked(prepareUpload).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // 既存挙動: OTHER 経路、 「試験一覧で確認を」、 retry hint 非表示
    // ErrorDetails <dd> にも同文言が出るため getAllByText で確認
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.queryByText(/ファイルを変更して再度お試しください/),
    ).not.toBeInTheDocument()
  })
})

// ─── FIX1: per-file 上限 (MAX_PDF_PAGES) テスト ──────────────────────────────
// per-file 上限 (MAX_PDF_PAGES) と per-upload 合計上限 (OCR_MAX_PAGES) の 2 軸を
// 独立して検証する。

describe('per-file 上限 (MAX_PDF_PAGES)', () => {
  it('MAX_PDF_PAGES+1 (41p) 単一 PDF は per-file error になり anyError=true で submit disabled', async () => {
    // 41p > MAX_PDF_PAGES=40 → per-file error
    mockPdfPageCount.mockResolvedValue(MAX_PDF_PAGES + 1)
    await renderWithFiles([makePdf('big.pdf')])

    // per-file error 文言が表示される (1 ファイル上限 MAX_PDF_PAGES ページ)
    const errorText = screen.getByText(
      new RegExp(`1 ファイル上限 ${MAX_PDF_PAGES} ページ`),
    )
    expect(errorText).toBeInTheDocument()

    // anyError=true で submit は disabled
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })

  it('MAX_PDF_PAGES (40p) 単一 PDF は per-file を通過し per-file error にならない', async () => {
    // 40p === MAX_PDF_PAGES → per-file 通過
    mockPdfPageCount.mockResolvedValue(MAX_PDF_PAGES)
    await renderWithFiles([makePdf('ok.pdf')])

    // per-file error 文言は表示されない
    expect(
      screen.queryByText(new RegExp(`1 ファイル上限 ${MAX_PDF_PAGES} ページ`)),
    ).not.toBeInTheDocument()
  })

  it('40p × 2 = 合計 80p: 各 file は per-file 通過、 合計で overPageCap → submit disabled', async () => {
    // 各 40p は MAX_PDF_PAGES=40 以下で per-file 通過。
    // 合計 80p > OCR_MAX_PAGES=40 で overPageCap。
    mockPdfPageCount.mockResolvedValue(40)
    await renderWithFiles([makePdf('a.pdf'), makePdf('b.pdf')])

    // per-file error は出ない
    expect(
      screen.queryByText(new RegExp(`1 ファイル上限 ${MAX_PDF_PAGES} ページ`)),
    ).not.toBeInTheDocument()

    // overPageCap banner は出る
    const capAlert = screen.getByText(
      new RegExp(`合計 ${OCR_MAX_PAGES} ページまでアップロード可能です`),
    )
    expect(capAlert).toBeInTheDocument()

    // submit disabled
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })

  it('30p + 9p = 合計 39p: per-file も overPageCap も通過 → submit enabled', async () => {
    // 30p と 9p は共に MAX_PDF_PAGES=40 以下、 合計 39 ≤ OCR_MAX_PAGES=40
    mockPdfPageCount
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(9)
    await renderWithFiles([makePdf('a.pdf'), makePdf('b.pdf')])

    // per-file error なし
    expect(
      screen.queryByText(new RegExp(`1 ファイル上限 ${MAX_PDF_PAGES} ページ`)),
    ).not.toBeInTheDocument()

    // overPageCap banner なし
    expect(
      screen.queryByText(new RegExp(`合計 ${OCR_MAX_PAGES} ページまでアップロード可能です`)),
    ).not.toBeInTheDocument()

    // existingExams=[] のため destination は初期値 {mode:'new'} → destinationReady=true。
    // ページ制限も quota 超過もないため submit button は enabled になる。
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeEnabled()
  })
})

// ─── requestOcrPoll kick テスト ───────────────────────────────────────────────

describe('requestOcrPoll: submit 時に layout poller へ kick', () => {
  it('submit 成功フローで requestOcrPoll が 1 回呼ばれる', async () => {
    const mockedRequestOcrPoll = vi.mocked(requestOcrPoll)

    // 新 flow 全体(prepareUpload → claimOperation → stagePrepared →
    // publishPreparedUpload)が成功する正常ケース(router.push に進む前に検証できれば
    // 十分)。 reserved:[] のため reserveSource/finalizeSource/fetch は呼ばれない。
    vi.mocked(prepareUpload).mockResolvedValueOnce({
      outcome: 'success',
      operationId: 'op-1',
      examId: 'exam-1',
      examName: 'Exam',
      sourceDocumentId: 'doc-123',
      reserved: [],
    })
    vi.mocked(claimOperation).mockResolvedValueOnce({ outcome: 'claimed', leaseVersion: 1 })
    vi.mocked(stagePrepared).mockResolvedValueOnce({
      outcome: 'staged',
      cardsTotal: 1,
      cardsExcluded: 0,
    })
    vi.mocked(publishPreparedUpload).mockResolvedValueOnce({
      outcome: 'published',
      cardsPublished: 1,
      figuresAttached: 0,
    })

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      // allow orchestration async resolution + state settle
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // handleSubmit 内で setPhase 直後に 1 回だけ呼ばれることを確認
    // synchronous — fires before runProcess
    expect(mockedRequestOcrPoll).toHaveBeenCalledTimes(1)
  })

  it('server がエラーを返しても requestOcrPoll が 1 回呼ばれる (unconditional kick)', async () => {
    // requestOcrPoll は setPhase({kind:'submitting'}) 直後、 runProcess の起動前に
    // 無条件で呼ばれる。 成功 / 失敗に関わらず kick されることを確認する。
    // (将来 success ブランチ内に移動したリファクタは本テストで検知される)
    // B3 grace period 内に kick されるため、 server 結果には依存しない。
    const mockedRequestOcrPoll = vi.mocked(requestOcrPoll)

    vi.mocked(prepareUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      // allow orchestration async resolution + state settle
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // エラー結果でも kick は 1 回発火している — success-gated でないことを証明
    // synchronous — fires before runProcess
    expect(mockedRequestOcrPoll).toHaveBeenCalledTimes(1)
  })
})

// ─── fileType pin(HEIC/GIF 後退の防止・canonical Important #1)──────────────────
describe('圧縮 fileType pin', () => {
  it('imageCompression は fileType image/webp を指定して呼ばれる(出力 mime を enum 内へ固定)', async () => {
    await renderWithFiles([makeImage('a.jpg')])
    expect(mockImageCompression).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ fileType: 'image/webp' }),
    )
  })
})

// ─── reserve→PUT→finalize ループ(直 R2 配線・canonical Important #3)──────────────
// 全 submit テストが reserved:[] だと最も novel な直 R2 配線が未カバーになるため、
// non-empty reserved で reserveSource/PUT/finalizeSource の引数と呼出順序を pin する。
describe('reserve→PUT→finalize ループ(非空 reserved)', () => {
  const SRC_ID = '00000000-0000-0000-0000-000000000001'

  it('各 source を reserveSource → PUT(uploadUrl) → finalizeSource の順に正しい引数で呼ぶ', async () => {
    // entry.id / idempotencyKey を固定して reserved.sourceId と一致させる。
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(SRC_ID)
    vi.mocked(prepareUpload).mockResolvedValueOnce({
      outcome: 'success',
      operationId: 'op-1',
      examId: 'exam-1',
      examName: 'Exam',
      sourceDocumentId: 'doc-123',
      reserved: [{ sourceId: SRC_ID, assetId: 'asset-1', objectKey: 'users/u/src/tmp/asset-1' }],
    })
    vi.mocked(reserveSource).mockResolvedValueOnce({
      ok: true,
      data: { uploadUrl: 'https://r2.example/put-target' },
    })
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(finalizeSource).mockResolvedValueOnce({ ok: true })
    vi.mocked(claimOperation).mockResolvedValueOnce({ outcome: 'claimed', leaseVersion: 1 })
    vi.mocked(stagePrepared).mockResolvedValueOnce({
      outcome: 'staged',
      cardsTotal: 1,
      cardsExcluded: 0,
    })
    vi.mocked(publishPreparedUpload).mockResolvedValueOnce({
      outcome: 'published',
      cardsPublished: 1,
      figuresAttached: 0,
    })

    await renderWithFiles([makeImage('a.jpg')])
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // reserveSource は assetId / mime / byteSize を渡す(mime は圧縮後 file.type)。
    expect(vi.mocked(reserveSource)).toHaveBeenCalledWith({
      assetId: 'asset-1',
      mime: 'image/jpeg',
      byteSize: expect.any(Number),
    })
    // PUT は uploadUrl 宛て・method PUT・body は File。
    expect(fetchMock).toHaveBeenCalledWith(
      'https://r2.example/put-target',
      expect.objectContaining({ method: 'PUT', body: expect.any(File) }),
    )
    // finalizeSource は assetId で呼ぶ。
    expect(vi.mocked(finalizeSource)).toHaveBeenCalledWith('asset-1')
    // 呼出順序 = reserve → PUT → finalize。
    const reserveOrder = vi.mocked(reserveSource).mock.invocationCallOrder[0]
    const fetchOrder = fetchMock.mock.invocationCallOrder[0]
    const finalizeOrder = vi.mocked(finalizeSource).mock.invocationCallOrder[0]
    expect(reserveOrder).toBeLessThan(fetchOrder)
    expect(fetchOrder).toBeLessThan(finalizeOrder)
    // 成功 → result page へ遷移。
    expect(mockRouterPush).toHaveBeenCalledWith('/app/upload/result/doc-123')
  })
})

// ─── 案 D: 失敗表示時に abandon を await ─────────────────────────────────────────
describe('案 D: operation 作成後の失敗で abandon を await', () => {
  it('stage retryable_failed で abandonUploadOperation が operationId+leaseVersion 付きで呼ばれる', async () => {
    vi.mocked(prepareUpload).mockResolvedValueOnce({
      outcome: 'success',
      operationId: 'op-1',
      examId: 'exam-1',
      examName: 'Exam',
      sourceDocumentId: 'doc-123',
      reserved: [],
    })
    vi.mocked(claimOperation).mockResolvedValueOnce({ outcome: 'claimed', leaseVersion: 7 })
    vi.mocked(stagePrepared).mockResolvedValueOnce({
      outcome: 'retryable_failed',
      reason: 'gemini_call_failed',
    })

    await renderWithFiles([makeImage('a.jpg')])
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // claim 済みの lease_version を保持して abandon する(server 側の fencing 照合用)。
    expect(vi.mocked(abandonUploadOperation)).toHaveBeenCalledWith({
      operationId: 'op-1',
      leaseVersion: 7,
    })
    // エラー表示は維持される(abandon は掃除のみ)。
    expect(
      screen.getByText(/ファイルを変更して再度お試しください/),
    ).toBeInTheDocument()
  })

  it('operation 作成前の失敗(prepareUpload in_progress)では abandon を呼ばない', async () => {
    vi.mocked(prepareUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

    await renderWithFiles([makeImage('a.jpg')])
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(abandonUploadOperation)).not.toHaveBeenCalled()
  })

  it('throw 経路で abandon が completed を返すと result page へ遷移する(transport lost success)', async () => {
    vi.mocked(prepareUpload).mockResolvedValueOnce({
      outcome: 'success',
      operationId: 'op-1',
      examId: 'exam-1',
      examName: 'Exam',
      sourceDocumentId: 'doc-123',
      reserved: [],
    })
    vi.mocked(claimOperation).mockResolvedValueOnce({ outcome: 'claimed', leaseVersion: 1 })
    vi.mocked(stagePrepared).mockResolvedValueOnce({
      outcome: 'staged',
      cardsTotal: 1,
      cardsExcluded: 0,
    })
    // publish で throw(network 断等)→ catch → abandon。
    vi.mocked(publishPreparedUpload).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
    // abandon は operation が実際には完了していたと返す。
    vi.mocked(abandonUploadOperation).mockResolvedValueOnce({
      outcome: 'completed',
      sourceDocumentId: 'doc-completed',
    })

    await renderWithFiles([makeImage('a.jpg')])
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(mockRouterPush).toHaveBeenCalledWith('/app/upload/result/doc-completed')
    // 遷移したのでエラー表示は出さない。
    expect(
      screen.queryByText(/処理状況を確認できませんでした/),
    ).not.toBeInTheDocument()
  })
})
