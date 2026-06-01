// @vitest-environment jsdom
// upload-form.tsx の client-side 制限ロジックテスト。
//
// 検証観点 (Task 7):
// - totalRequestedPages > OCR_MAX_PAGES (40) で submit button が disabled
// - totalRequestedPages === 40 (境界) は page cap では disabled にならない
// - overPageCap 超過時に 40 page 上限文言が表示される
// - PAGE_LIMIT_EXCEEDED error result で retry hint が非表示 (hideRetryHint 経路)
// - 既存の overQuota / alreadyAtQuota banner との併存

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// --- モック ---

// next/navigation: useRouter を stub
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// server action: processUpload を spy (実際には呼ばれない想定だが型合わせ)
vi.mock('../_actions/process', () => ({
  processUpload: vi.fn(),
}))

// browser-image-compression: 常に input file をそのまま返す no-op
vi.mock('browser-image-compression', () => ({
  default: async (file: File) => file,
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
import { processUpload } from '../_actions/process'
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

describe('hideRetryHint: PAGE_LIMIT_EXCEEDED で retry hint が非表示', () => {
  it('PAGE_LIMIT_EXCEEDED の error result で retry hint が表示されない', async () => {
    const mockedProcessUpload = vi.mocked(processUpload)
    mockedProcessUpload.mockResolvedValueOnce({
      ok: false,
      error: '1 回の upload に含められる最大ページ数は 40 ページです。',
      code: 'PAGE_LIMIT_EXCEEDED',
    } as Awaited<ReturnType<typeof processUpload>>)

    // PDF 1 枚 (submit できるページ数で投入、 client 制限を回避するため 1 ページ)
    mockPdfPageCount.mockResolvedValue(1)
    await renderWithFiles([makePdf('test.pdf')])

    // submit を発火
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // error message は表示される (ErrorDetails <dd> にも同文言が出るため allByText で確認)
    expect(
      screen.getAllByText(/最大ページ数は 40 ページです/).length,
    ).toBeGreaterThanOrEqual(1)

    // retry hint (「ファイルを変更して再度お試しください」) は非表示
    expect(
      screen.queryByText(/ファイルを変更して再度お試しください/),
    ).not.toBeInTheDocument()
  })

  it('UPLOAD_IN_PROGRESS でも retry hint が非表示 (既存挙動の regression なし)', async () => {
    const mockedProcessUpload = vi.mocked(processUpload)
    mockedProcessUpload.mockResolvedValueOnce({
      ok: false,
      error: '現在 OCR を実行中です。',
      code: 'UPLOAD_IN_PROGRESS',
    } as Awaited<ReturnType<typeof processUpload>>)

    mockPdfPageCount.mockResolvedValue(1)
    await renderWithFiles([makePdf('test.pdf')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.queryByText(/ファイルを変更して再度お試しください/),
    ).not.toBeInTheDocument()
  })

  it('GEMINI_FAILED では retry hint が表示される (PAGE_LIMIT_EXCEEDED と異なる挙動)', async () => {
    const mockedProcessUpload = vi.mocked(processUpload)
    mockedProcessUpload.mockResolvedValueOnce({
      ok: false,
      error: 'AI による抽出に失敗しました。',
      code: 'GEMINI_FAILED',
    } as Awaited<ReturnType<typeof processUpload>>)

    mockPdfPageCount.mockResolvedValue(1)
    await renderWithFiles([makePdf('test.pdf')])

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
    const mockedProcessUpload = vi.mocked(processUpload)
    const mockedRequestOcrPoll = vi.mocked(requestOcrPoll)

    // processUpload が ok を返す正常ケース (router.push に進む前に検証できれば十分)
    // submit 後に longRunning タイマーが残らないよう resolved を即返す
    mockedProcessUpload.mockResolvedValueOnce({
      ok: true,
      data: { sourceDocumentId: 'doc-123' },
    } as Awaited<ReturnType<typeof processUpload>>)

    // 1 ページ PDF で submit 可能な状態にする
    mockPdfPageCount.mockResolvedValue(1)
    await renderWithFiles([makePdf('test.pdf')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      // allow processUpload async resolution + state settle
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
    const mockedProcessUpload = vi.mocked(processUpload)
    const mockedRequestOcrPoll = vi.mocked(requestOcrPoll)

    // processUpload がサーバー側エラーを返すケース
    mockedProcessUpload.mockResolvedValueOnce({
      ok: false,
      error: '現在 OCR を実行中です。',
      code: 'UPLOAD_IN_PROGRESS',
    } as Awaited<ReturnType<typeof processUpload>>)

    mockPdfPageCount.mockResolvedValue(1)
    await renderWithFiles([makePdf('test.pdf')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      // allow processUpload async resolution + state settle
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // エラー結果でも kick は 1 回発火している — success-gated でないことを証明
    // synchronous — fires before runProcess
    expect(mockedRequestOcrPoll).toHaveBeenCalledTimes(1)
  })
})
