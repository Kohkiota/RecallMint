// @vitest-environment jsdom
// upload-form.tsx の client-side 制限ロジックテスト。
//
// 検証観点 (Task 7):
// - totalRequestedPages > OCR_MAX_PAGES (40) で submit button が disabled
// - totalRequestedPages === 40 (境界) は page cap では disabled にならない
// - overPageCap 超過時に 40 page 上限文言が表示される
// - 既存の overQuota / alreadyAtQuota banner との併存
//
// ②-4a 単一 invocation Sprint Task S-3(2026-08-05): submit 時の呼出列を
// prepare→reserve→PUT→finalize→claim→stage→publish から **submitUpload 1 本**へ
// 差し替えたため、 submit を実際に fire するテスト群は submitUpload だけをモックする。
// entries 管理 / page-cap 判定 (submit を fire しない範囲)は runProcess 変更の影響を
// 受けないため無改修。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// --- モック ---

// next/navigation: useRouter を stub(安定した push spy で遷移先を検証する)
const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

// S-3: upload の入口は submitUpload 1 本(旧 action 群は呼ばれない)。
vi.mock('../_actions/submit-upload', () => ({
  submitUpload: vi.fn(),
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

import { UploadForm } from './upload-form'
import { submitUpload } from '../_actions/submit-upload'
import { requestOcrPoll } from '@/lib/exams/ocr-poll-signal'
import { type ActiveExam } from '@/lib/exams/format'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { MAX_PDF_PAGES } from '../_lib/constants'

// デフォルト props (Pro: 上限なし、残量制限なし)
const DEFAULT_PROPS = {
  existingExams: [] as ActiveExam[],
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
  // デフォルト: submit は成功(publish 済みの operation を返す)。
  vi.mocked(submitUpload).mockResolvedValue({
    outcome: 'accepted',
    operationId: 'op-1',
    examId: 'exam-1',
    sourceDocumentId: 'doc-123',
    replayed: false,
  })
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
// S-3: submitUpload の outcome 集合(accepted / in_progress / daily_limit_exceeded /
// exam_not_found / invalid_input / unauthenticated)から、 旧 flow と同じ
// hideRetryHint 導出規則(setError 内で code==='UPLOAD_IN_PROGRESS' の時だけ隠す)を
// 検証する。 加えて ②-4a は画像入稿のみ(PDF は ②-4b)であるため、 PDF 1 件でも
// 混在すると送信前に明示ブロックされることを検証する(silent partial exclusion 防止)。

describe('hideRetryHint: submitUpload の outcome から retry hint 表示/非表示を検証', () => {
  it('PDF が混在した submit は送信前にブロックされ、 retry hint は表示される(ファイル変更で解決可能なため)', async () => {
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
    expect(vi.mocked(submitUpload)).not.toHaveBeenCalled()
  })

  it('in_progress(UPLOAD_IN_PROGRESS)は retry hint 非表示', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

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

  it('invalid_input は server 文言をそのまま出し retry hint も表示する', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'invalid_input',
      error: '1 ファイルのサイズ上限を超えています',
    })

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.getAllByText(/1 ファイルのサイズ上限を超えています/).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText(/ファイルを変更して再度お試しください/),
    ).toBeInTheDocument()
  })

  it('daily_limit_exceeded は上限文言 + current/limit を出す', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'daily_limit_exceeded',
      current: 50,
      limit: 50,
    })

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.getAllByText(/本日の AI 利用上限に達しました/).length,
    ).toBeGreaterThanOrEqual(1)
    // 開発表示(NEXT_PUBLIC_VERCEL_ENV !== 'production')の詳細に current/limit が載る。
    expect(screen.getByText('GEMINI_DAILY_LIMIT_EXCEEDED')).toBeInTheDocument()
  })

  it('exam_not_found(archived)はアーカイブ文言、 unauthenticated は認証文言', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'exam_not_found',
      archived: true,
    })
    await renderWithFiles([makeImage('test.jpg')])
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    expect(
      screen.getAllByText(/選択した試験はアーカイブされています/).length,
    ).toBeGreaterThanOrEqual(1)

    cleanup()
    vi.mocked(submitUpload).mockResolvedValueOnce({ outcome: 'unauthenticated' })
    await renderWithFiles([makeImage('test2.jpg')])
    const btn2 = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn2)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    expect(screen.getAllByText(/認証が必要です/).length).toBeGreaterThanOrEqual(1)
  })
})

// ─── 予期しない throw → OTHER 経路 ─────────────────────────────────────────────
describe('予期しない throw → OTHER 経路', () => {
  it('submitUpload が無関係な Error を throw した場合、 既存 OTHER 経路 (試験一覧で確認を) に fall through', async () => {
    vi.mocked(submitUpload).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))

    await renderWithFiles([makeImage('test.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // 既存挙動: OTHER 経路、 「試験一覧で確認を」、 retry hint 非表示
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

    // submitUpload の既定 mock(accepted)がそのまま成功ケース。

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

    vi.mocked(submitUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

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

// ─── S-3: submitUpload へ渡す FormData の中身 pin ────────────────────────────
// 切替の本体は「何を 1 回で送るか」。 idempotencyKey / mode / examId / files 全件が
// 1 つの FormData に載ることを pin する(client 直 PUT が無くなったことの裏返し)。
describe('submitUpload に渡す FormData', () => {
  it('idempotencyKey + mode + files 全件を 1 回の呼出で送り、成功で result page へ遷移する', async () => {
    await renderWithFiles([makeImage('a.jpg'), makeImage('b.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(1)
    const fd = vi.mocked(submitUpload).mock.calls[0][0]
    expect(fd).toBeInstanceOf(FormData)
    expect(typeof fd.get('idempotencyKey')).toBe('string')
    expect((fd.get('idempotencyKey') as string).length).toBeGreaterThan(0)
    // existingExams=[] ゆえ destination は既定の { mode: 'new' }。
    expect(fd.get('mode')).toBe('new')
    expect(fd.get('examId')).toBeNull()
    const files = fd.getAll('files')
    expect(files).toHaveLength(2)
    expect(files.every((f) => f instanceof File)).toBe(true)
    expect((files as File[]).map((f) => f.name)).toEqual(['a.jpg', 'b.jpg'])

    // client 直 PUT は無くなった(fetch を一切使わない)。
    expect(mockRouterPush).toHaveBeenCalledWith('/app/upload/result/doc-123')
  })

  it('既存 exam を選ぶと mode=existing + examId が載る', async () => {
    await renderWithFiles([makeImage('a.jpg')], {
      existingExams: [
        { id: 'exam-9', name: '既存試験', updatedAt: new Date('2026-08-01T00:00:00Z') },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: /既存 exam に追加/ }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'exam-9' } })

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    const fd = vi.mocked(submitUpload).mock.calls[0][0]
    expect(fd.get('mode')).toBe('existing')
    expect(fd.get('examId')).toBe('exam-9')
  })

  // 冪等 replay は状態不問で既存 op の 3 ID を返す契約ゆえ、source_document が既に
  // 消えている op では sourceDocumentId が空文字で返りうる(submit-upload.ts の `?? ''`)。
  // 空 id で result page へ push すると 404 になるため一覧へ誘導する。
  it('sourceDocumentId が空で返った replay では result page へ push しない', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'accepted',
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: '',
      replayed: true,
    })

    await renderWithFiles([makeImage('a.jpg')])
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(mockRouterPush).not.toHaveBeenCalled()
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('submit のたびに新しい idempotencyKey を発行する(ユーザー再試行 = 別 operation)', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({ outcome: 'in_progress' })
    await renderWithFiles([makeImage('a.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(2)
    const first = vi.mocked(submitUpload).mock.calls[0][0].get('idempotencyKey')
    const second = vi.mocked(submitUpload).mock.calls[1][0].get('idempotencyKey')
    expect(first).not.toBe(second)
  })
})
