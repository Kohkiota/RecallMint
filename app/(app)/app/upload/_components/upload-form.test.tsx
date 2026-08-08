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
//
// Task S-4: server は sync tx 直後に `accepted` を返し、本処理は after() で走る。
// ゆえに `accepted` 単体では result page へ遷移せず、/api/exams/status の
// `docStatuses` を 5 秒 poll して `completed` を見てから遷移する。 poll の縮退
// (連続 fetch 失敗 / 絶対上限)と離脱ガード撤去もここで pin する。
//
// ②-4b Task 6(2026-08-07): client 側の PDF page count 判定(pdfPageCount)を廃止し、
// PDF は reserve(presign)→ 直 PUT(R2)→ finalize(完了通知・pageCount 確定)の
// batch flow に置き換えた(spec D5)。 `pdf-page-count.ts` 削除に伴い、旧
// per-file 上限(MAX_PDF_PAGES)の client pre-check テストは全廃した(**保証減**:
// 「PDF 単体 40 ページ超をブラウザ側だけで弾く」という保証は落ちた — spec D3/D4 の
// とおり、単体 >40 は finalizePdfSource(server)が弾く。合計 40 ページ 1 本の上限は
// 不変で、本 file 内に引き続き pin する)。

import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'

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

// ②-4b T6: PDF batch flow の 2 action(reserve/finalize)をモックする。
// client 判定(pdfPageCount)は廃止済 — page count の正本は finalize の応答。
type ReserveResult =
  | { ok: true; data: { fileId: string; uploadUrl: string }[] }
  | { ok: false; error: string }
type FinalizeResult = { ok: true; data: { pageCount: number } } | { ok: false; error: string }

const mockReservePdfUploadUrls = vi.fn<
  (input: {
    uploadSessionId: string
    files: { fileId: string; declaredBytes: number }[]
  }) => Promise<ReserveResult>
>()
vi.mock('../_actions/reserve-pdf-upload', () => ({
  reservePdfUploadUrls: (input: unknown) =>
    mockReservePdfUploadUrls(
      input as { uploadSessionId: string; files: { fileId: string; declaredBytes: number }[] },
    ),
}))

const mockFinalizePdfSource = vi.fn<
  (input: {
    uploadSessionId: string
    fileId: string
    declaredBytes: number
  }) => Promise<FinalizeResult>
>()
vi.mock('../_actions/finalize-pdf-source', () => ({
  finalizePdfSource: (input: unknown) =>
    mockFinalizePdfSource(
      input as { uploadSessionId: string; fileId: string; declaredBytes: number },
    ),
}))

// PDF の直 PUT(browser → R2)先。 global fetch を差し替える(docStatuses poll の
// describe は自前で別の mock に差し替えるため衝突しない — 後勝ちで local が勝つ)。
const mockFetchPut = vi.fn()

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

// デフォルト props (Pro: 上限なし、残量制限なし)
const DEFAULT_PROPS = {
  existingExams: [] as ActiveExam[],
  currentMonthPages: 0,
  monthlyLimit: null as number | null,
  remaining: null as number | null,
  plan: 'pro' as 'free' | 'standard' | 'pro',
}

/** PDF File を生成するヘルパー(中身は判定に使わない — page count は finalize の
 * mock 応答が唯一の情報源)。 */
function makePdf(name: string): File {
  return new File(['%PDF-1.4'], name, { type: 'application/pdf' })
}

/** declaredBytes(file.size)を明示指定できる PDF File(Σ declaredBytes 検証用)。 */
function makePdfWithSize(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
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
 * reserve/PUT/finalize は既定で即成功する(beforeEach のデフォルト mock)ため、
 * 実時間 50ms の待機で 3 段の await chain がすべて片付く(すべて即時解決の
 * Promise ゆえ、 real timer を跨がずに microtask queue が先に drain される)。
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

/** pending な Promise を外部から resolve できるようにする helper。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** action(resolve)を発火し、その後の microtask/state 更新を act 内で flush する。 */
async function resolveAndFlush(action: () => void) {
  await act(async () => {
    action()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', mockFetchPut)
  // デフォルト: PDF batch flow は即成功する(reserve → PUT → finalize、10 ページ)。
  mockReservePdfUploadUrls.mockImplementation(async (input) => ({
    ok: true,
    data: input.files.map((f) => ({
      fileId: f.fileId,
      uploadUrl: `https://r2.example.test/${f.fileId}`,
    })),
  }))
  mockFetchPut.mockResolvedValue({ ok: true } as unknown as Response)
  mockFinalizePdfSource.mockResolvedValue({ ok: true, data: { pageCount: 10 } })
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
  vi.unstubAllGlobals()
})

// ─── submit button disabled テスト ───────────────────────────────────────────

describe('overPageCap: submit button の disable 判定', () => {
  it('totalRequestedPages > OCR_MAX_PAGES (45 pages) で submit disabled', async () => {
    // 25p + 20p = 45p > 40
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 25 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 20 } })
    await renderWithFiles([makePdf('a.pdf'), makePdf('b.pdf')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })

  it('totalRequestedPages === OCR_MAX_PAGES (境界 40 pages) は page cap で disabled にならない', async () => {
    // 20p + 20p = 40p = OCR_MAX_PAGES
    mockFinalizePdfSource.mockResolvedValue({ ok: true, data: { pageCount: 20 } })
    await renderWithFiles([makePdf('a.pdf'), makePdf('b.pdf')])

    // overPageCap は false のはず (40 > 40 は偽)
    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeEnabled()
  })

  it('画像 + PDF の合計が 41 pages で disabled', async () => {
    // PDF 40 ページ + 画像 1 枚 = 41 pages
    mockFinalizePdfSource.mockResolvedValueOnce({ ok: true, data: { pageCount: 40 } })
    const files = [makePdf('doc.pdf'), makeImage('img.jpg')]
    await renderWithFiles(files)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })
})

// ─── UI 文言 テスト ────────────────────────────────────────────────────────────

describe('overPageCap: UI 文言表示', () => {
  it('totalRequestedPages > OCR_MAX_PAGES で超過 banner が表示される', async () => {
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 25 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 20 } })
    const files = [makePdf('a.pdf'), makePdf('b.pdf')] // 25+20=45 > 40
    await renderWithFiles(files)

    const alerts = screen.getAllByRole('alert')
    const capAlert = alerts.find((el) =>
      el.textContent?.includes(`合計 ${OCR_MAX_PAGES} ページまでアップロード可能です`),
    )
    expect(capAlert).toBeTruthy()
  })

  it('totalRequestedPages === 40 では page cap banner が表示されない', async () => {
    mockFinalizePdfSource.mockResolvedValue({ ok: true, data: { pageCount: 20 } })
    await renderWithFiles([makePdf('a.pdf'), makePdf('b.pdf')])

    expect(
      screen.queryByText(/合計 40 ページまでアップロード可能です/),
    ).not.toBeInTheDocument()
  })

  it('overPageCap banner は overQuota banner と同時に表示できる (独立した上限)', async () => {
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 25 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 20 } })
    const files = [makePdf('a.pdf'), makePdf('b.pdf')] // 45 > 40、かつ remaining=30 超過
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
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 25 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 20 } })
    await renderWithFiles([makePdf('x.pdf'), makePdf('y.pdf')])

    const bannerText = screen.getByText(/合計 \d+ ページまでアップロード可能です/)
    expect(bannerText.textContent).toContain(String(OCR_MAX_PAGES))
  })
})

// ─── PDF entry の状態遷移(spec D5) ────────────────────────────────────────────

describe('PDF entry の状態遷移(spec D5)', () => {
  it('uploading → counting → ready の順に遷移し、pageCount を表示する', async () => {
    const reserveDeferred = deferred<ReserveResult>()
    const putDeferred = deferred<{ ok: boolean }>()
    const finalizeDeferred = deferred<FinalizeResult>()
    mockReservePdfUploadUrls.mockReturnValueOnce(reserveDeferred.promise)
    mockFetchPut.mockReturnValueOnce(putDeferred.promise)
    mockFinalizePdfSource.mockReturnValueOnce(finalizeDeferred.promise)

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('a.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
    })

    // 初期状態: uploading(presign → PUT 中)。
    expect(screen.getAllByText('アップロード中…').length).toBeGreaterThanOrEqual(1)

    const reserveInput = mockReservePdfUploadUrls.mock.calls[0][0]
    const fileId = reserveInput.files[0].fileId

    // reserve 解決 → PUT 待ち。 まだ uploading のまま(PUT はまだ pending)。
    await resolveAndFlush(() =>
      reserveDeferred.resolve({
        ok: true,
        data: [{ fileId, uploadUrl: 'https://r2.example.test/put' }],
      }),
    )
    expect(screen.getAllByText('アップロード中…').length).toBeGreaterThanOrEqual(1)

    // PUT 解決 → counting(完了通知往復中)へ。
    await resolveAndFlush(() => putDeferred.resolve({ ok: true }))
    expect(screen.getAllByText('ページ数確認中…').length).toBeGreaterThanOrEqual(1)

    // finalize 解決 → ready(pageCount 確定)。
    await resolveAndFlush(() => finalizeDeferred.resolve({ ok: true, data: { pageCount: 12 } }))
    expect(screen.getAllByText('12 ページ').length).toBeGreaterThanOrEqual(1)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeEnabled()
  })

  it('PUT 失敗で error になり、finalize は呼ばれない', async () => {
    mockFetchPut.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response)
    await renderWithFiles([makePdf('bad.pdf')])

    expect(
      screen.getAllByText(/PDF のアップロードに失敗しました/).length,
    ).toBeGreaterThanOrEqual(1)
    expect(mockFinalizePdfSource).not.toHaveBeenCalled()

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })

  it('finalize reject(0 ページ / 40 超過 / parse 失敗)で error になり server 文言を表示する', async () => {
    mockFinalizePdfSource.mockResolvedValueOnce({
      ok: false,
      error: 'ページ数が上限(40)を超えています',
    })
    await renderWithFiles([makePdf('big.pdf')])

    expect(
      screen.getAllByText('ページ数が上限(40)を超えています').length,
    ).toBeGreaterThanOrEqual(1)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn).toBeDisabled()
  })

  it('reserve 失敗(presign 発行失敗)で error になる', async () => {
    mockReservePdfUploadUrls.mockResolvedValueOnce({
      ok: false,
      error: '合計サイズが上限を超えています',
    })
    await renderWithFiles([makePdf('huge.pdf')])

    expect(
      screen.getAllByText('合計サイズが上限を超えています').length,
    ).toBeGreaterThanOrEqual(1)
    expect(mockFetchPut).not.toHaveBeenCalled()
  })
})

// ─── 合計ページの 3 状態表示(spec D5) ─────────────────────────────────────────
// 数値でなく「確定 / 未確定」を表示する: ① uploading/counting が 1 つでもあれば
// 「合計未確定」 ② 全確定なら「合計 N ページ」 ③ 確定かつ N>40 なら「超過」も添える。

describe('合計ページの 3 状態表示(spec D5)', () => {
  it('PDF が counting の間は「合計未確定」を表示し、部分和の数値を出さない', async () => {
    const finalizeDeferred = deferred<FinalizeResult>()
    mockFinalizePdfSource.mockReturnValueOnce(finalizeDeferred.promise)

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makeImage('a.jpg'), makePdf('b.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })

    // 画像は ready(1 ページ)、 PDF は finalize 待ちで counting のまま。
    expect(screen.getByText(/合計未確定/)).toBeInTheDocument()
    // 「1 ページ」のような部分和(画像分だけ)を数値として出さない。
    expect(screen.queryByText(/合計 1 ページ/)).not.toBeInTheDocument()

    await resolveAndFlush(() =>
      finalizeDeferred.resolve({ ok: true, data: { pageCount: 3 } }),
    )
    expect(screen.queryByText(/合計未確定/)).not.toBeInTheDocument()
    expect(screen.getByText(/合計 4 ページ/)).toBeInTheDocument()
  })

  it('全 entry 確定後(超過でない)は「合計 N ページ」を表示する', async () => {
    mockFinalizePdfSource.mockResolvedValueOnce({ ok: true, data: { pageCount: 5 } })
    await renderWithFiles([makeImage('a.jpg'), makePdf('b.pdf')])

    expect(screen.getByText(/合計 6 ページ/)).toBeInTheDocument()
    expect(screen.queryByText(/合計未確定/)).not.toBeInTheDocument()
    expect(screen.queryByText(/超過/)).not.toBeInTheDocument()
  })

  it('確定かつ合計 > 40 では「超過」を併記する', async () => {
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 25 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 20 } })
    await renderWithFiles([makePdf('a.pdf'), makePdf('b.pdf')])

    expect(screen.getByText(/合計 45 ページ・超過/)).toBeInTheDocument()
    expect(screen.queryByText(/合計未確定/)).not.toBeInTheDocument()
  })
})

// ─── stale 応答排除(entry generation token・Codex I11) ────────────────────────

describe('stale 応答排除(entry generation token)', () => {
  it('削除後に届く stale finalize 応答は entry を復活させない', async () => {
    const finalizeDeferred = deferred<FinalizeResult>()
    mockFinalizePdfSource.mockReturnValueOnce(finalizeDeferred.promise)

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('stale.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })

    // reserve + PUT は既定で即成功、 finalize だけ pending = counting のはず。
    expect(screen.getAllByText('ページ数確認中…').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('stale.pdf')).toBeInTheDocument()

    // 削除(finalize はまだ未解決)。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除' }))
    })
    expect(screen.queryByText('stale.pdf')).not.toBeInTheDocument()

    // stale 応答: 削除後に finalize が今さら成功で解決する。
    await resolveAndFlush(() =>
      finalizeDeferred.resolve({ ok: true, data: { pageCount: 7 } }),
    )

    // entry は復活しない(一覧に戻ってこない・7 ページ表示も出ない)。
    expect(screen.queryByText('stale.pdf')).not.toBeInTheDocument()
    expect(screen.queryByText('7 ページ')).not.toBeInTheDocument()
    // 何も選択されていない状態に戻っている(合計 3 状態の describe と独立の観点)。
    expect(screen.queryByText(/件選択中/)).not.toBeInTheDocument()
  })
})

// ─── submit manifest 組立(orderManifest) ──────────────────────────────────────

describe('submit manifest 組立(orderManifest)', () => {
  it('画像のみなら orderManifest を送信しない(後方互換)', async () => {
    await renderWithFiles([makeImage('a.jpg'), makeImage('b.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    const fd = vi.mocked(submitUpload).mock.calls[0][0]
    expect(fd.get('orderManifest')).toBeNull()
  })

  it('画像 + PDF 混在で選択順を維持した orderManifest を送り、submit をブロックしない(spec D3: 混在可)', async () => {
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 3 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 2 } })
    await renderWithFiles([
      makeImage('img1.jpg'),
      makePdf('doc1.pdf'),
      makeImage('img2.jpg'),
      makePdf('doc2.pdf'),
    ])

    // 旧「PDF は現在このアップロードでは対応していません」block は撤去済み。
    expect(
      screen.queryByText(/PDF は現在このアップロードでは対応していません/),
    ).not.toBeInTheDocument()

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(1)
    const fd = vi.mocked(submitUpload).mock.calls[0][0]

    // 画像は選択順どおり FormData の files へ(PDF はここには載らない — 直 PUT 済)。
    const files = fd.getAll('files') as File[]
    expect(files.map((f) => f.name)).toEqual(['img1.jpg', 'img2.jpg'])

    const manifestRaw = fd.get('orderManifest')
    expect(typeof manifestRaw).toBe('string')
    const manifest = JSON.parse(manifestRaw as string) as unknown[]
    expect(manifest).toEqual([
      { kind: 'image', fileIndex: 0 },
      {
        kind: 'pdf',
        fileId: expect.any(String),
        filename: 'doc1.pdf',
        pageCount: 3,
        declaredBytes: expect.any(Number),
      },
      { kind: 'image', fileIndex: 1 },
      {
        kind: 'pdf',
        fileId: expect.any(String),
        filename: 'doc2.pdf',
        pageCount: 2,
        declaredBytes: expect.any(Number),
      },
    ])
  })

  // r5(spec §3.1)で uploadSessionId(R2 namespace)と idempotencyKey(submit 試行)
  // を分離した。 旧 test「PDF の reserve / finalize / submit が同一
  // idempotencyKey を使う」は r5 で主張が偽になった(session と submit key は
  // 別物)ため作り直す — **保証の減ではなく付け替え**: 「reserve/finalize/submit
  // が同じ 1 値を使う」という主張から、「reserve/finalize/submit の
  // uploadSessionId は一致するが、idempotencyKey はそれと独立な別値である」と
  // いう(r5 で正しくなった)主張へ置き換える。 根拠 = spec §3.1 の識別子分離
  // そのもの(retry で idempotencyKey は必ず新規 / uploadSessionId は維持したい
  // という逆向きの要求)。
  it('uploadSessionId は reserve/finalize/submit で一致するが、idempotencyKey はそれと独立な別値である(spec §3.1)', async () => {
    mockFinalizePdfSource.mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })
    await renderWithFiles([makePdf('a.pdf')])

    const reserveSessionId = mockReservePdfUploadUrls.mock.calls[0][0].uploadSessionId
    const finalizeSessionId = mockFinalizePdfSource.mock.calls[0][0].uploadSessionId
    expect(finalizeSessionId).toBe(reserveSessionId)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    const fd = vi.mocked(submitUpload).mock.calls[0][0]
    // uploadSessionId は top-level field として reserve/finalize と同じ値で送る。
    expect(fd.get('uploadSessionId')).toBe(reserveSessionId)
    // idempotencyKey は session とは独立な別値(同じ値を兼ねない)。
    const idempotencyKey = fd.get('idempotencyKey')
    expect(typeof idempotencyKey).toBe('string')
    expect((idempotencyKey as string).length).toBeGreaterThan(0)
    expect(idempotencyKey).not.toBe(reserveSessionId)
  })

  it('画像のみなら uploadSessionId を送らない(spec §3.4: PDF を含む場合のみ)', async () => {
    await renderWithFiles([makeImage('a.jpg')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    const fd = vi.mocked(submitUpload).mock.calls[0][0]
    expect(fd.get('uploadSessionId')).toBeNull()
  })
})

// ─── reserve のバッチ化(Important 2 fix・canonical review T6 fix round 1) ─────
// 1 file ずつ presign すると個々が必ず ≤ MAX_PDF_BYTES(50MB)以下になり、reserve
// 側の Σ declaredBytes ≤ MAX_PDF_TOTAL_BYTES(200MB)判定(spec D7)が構造的に
// 発火しない。 batch(= 1 回の handleAdd の新規 PDF + 既存のアクティブな PDF
// entry)をまとめて 1 回の reservePdfUploadUrls に渡すことを pin する。

describe('reserve のバッチ化(Important 2 fix)', () => {
  it('1 回の handleAdd で追加した複数 PDF は 1 回の reservePdfUploadUrls にまとめて渡す(1 file ずつ呼ばない)', async () => {
    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('a.pdf'), makePdf('b.pdf'), makePdf('c.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })

    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)
    expect(mockReservePdfUploadUrls.mock.calls[0][0].files).toHaveLength(3)
  })

  it('既存の active PDF entry の declaredBytes も Σ に含めて server へ渡す — 超過時は新規分だけ reject され、既存 entry・PUT は影響を受けない', async () => {
    // mock: Σ declaredBytes > 6000(test 用の閾値。実際の MAX_PDF_TOTAL_BYTES と
    // 同じロジックを小さい値で模する — 実バイト割当を避けるための単純化)なら
    // reject する reserve-pdf-upload.ts 相当の挙動。
    mockReservePdfUploadUrls.mockImplementation(async (input) => {
      const total = input.files.reduce((s, f) => s + f.declaredBytes, 0)
      if (total > 6000) return { ok: false, error: '合計サイズが上限を超えています' }
      return {
        ok: true,
        data: input.files.map((f) => ({
          fileId: f.fileId,
          uploadUrl: `https://r2.example.test/${f.fileId}`,
        })),
      }
    })

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    // 1 回目: 4000 bytes の PDF を追加 → 単独では閾値以下なので成功。
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdfWithSize('a.pdf', 4000)]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByText('a.pdf')).toBeInTheDocument()
    expect(screen.queryByText(/合計サイズが上限を超えています/)).not.toBeInTheDocument()
    expect(mockFetchPut).toHaveBeenCalledTimes(1)

    // 2 回目: さらに 4000 bytes の PDF を追加 → 既存(a.pdf)4000 + 新規(b.pdf)4000
    // = 8000 > 6000 で reject されるはず(Σ が既存分を含んでいれば)。
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdfWithSize('b.pdf', 4000)]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })

    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(2)
    const secondCallFiles = mockReservePdfUploadUrls.mock.calls[1][0].files
    expect(secondCallFiles).toHaveLength(2)
    expect(secondCallFiles.reduce((s, f) => s + f.declaredBytes, 0)).toBe(8000)

    // 新規(b.pdf)だけ error になり、PUT は発火しない(fetch 呼出は a.pdf の 1 回のまま)。
    expect(screen.getByText(/合計サイズが上限を超えています/)).toBeInTheDocument()
    expect(mockFetchPut).toHaveBeenCalledTimes(1)

    // 既存(a.pdf)はこの reject に巻き込まれない(引き続き表示されたまま)。
    expect(screen.getByText('a.pdf')).toBeInTheDocument()
  })
})

// ─── idempotencyKey: 複数回 submit(Critical fix round 1/2 → r5 で恒久化) ─────
// fix round 1/2 時点では idempotencyKey は「PDF が presign 済みなら batch 単位で
// 持続する値」だった(submit 解決直後に畳むことで次の submit だけ新規化)。
// r5(spec §3.1)で識別子を分離した後は、idempotencyKey は **常に無条件で
// submit ごとに新規発行**する(image-only 経路と同じ扱い・session の生死に
// 一切依存しない)ため、下のテストが検証する「2 回の submit で異なる
// idempotencyKey が使われる」という主張自体は不変(旧実装よりも単純な理由で
// 成立する)。 R2 namespace の持続/無効化は uploadSessionId 側の責務に分離され、
// 「uploadSessionId: client 状態機械」describe で別途 pin する。

describe('idempotencyKey: 複数回 submit', () => {
  it('1 回目 submit(in_progress で blocked)後、PDF を差し替えて 2 回目 submit すると異なる idempotencyKey を使う', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    // PDF + 画像を混在させる(idempotencyKey は session の状態に関わらず常に
    // 新規発行されることの確認が主眼・PDF 差し替え自体は副次的)。
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('a.pdf'), makeImage('img.jpg')]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(1)
    const key1 = vi.mocked(submitUpload).mock.calls[0][0].get('idempotencyKey')
    expect(typeof key1).toBe('string')

    // PDF を差し替える(失敗した a.pdf を削除して別の PDF を追加)。 画像は残す。
    const pdfCard = screen.getByText('a.pdf').closest('li')
    expect(pdfCard).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(pdfCard as HTMLElement).getByRole('button', { name: '削除' }))
    })
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument()
    // entries は空になっていない(画像が残っている) — removeEntry の空判定 reset は不発。
    expect(screen.getByText('img.jpg')).toBeInTheDocument()

    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('c.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })

    // 2 回目 submit(通常成功)。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(2)
    const key2 = vi.mocked(submitUpload).mock.calls[1][0].get('idempotencyKey')
    expect(key2).not.toBe(key1)
  })

  // `submitUpload` が throw(reject)した経路でも idempotencyKey は無条件で
  // 新規発行される(r5 以降は session の生死判定と無関係な単純な仕様)。
  it('1 回目 submit が throw(reject)した後、2 回目 submit(resolve)は異なる idempotencyKey を使う', async () => {
    vi.mocked(submitUpload).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))

    await renderWithFiles([makePdf('a.pdf')])

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(1)
    const key1 = vi.mocked(submitUpload).mock.calls[0][0].get('idempotencyKey')
    expect(typeof key1).toBe('string')
    // 既存 OTHER 経路(「試験一覧で確認を」)に落ちていること = throw が catch されている確認。
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)

    // PDF entry 自体は throw に巻き込まれず ready のまま残る(削除・差し替え不要)。
    expect(screen.getByText('a.pdf')).toBeInTheDocument()

    // 2 回目: 通常どおり resolve する。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(2)
    const key2 = vi.mocked(submitUpload).mock.calls[1][0].get('idempotencyKey')
    expect(key2).not.toBe(key1)
  })
})

// ─── uploadSessionId: client 状態機械(spec r5 §3.1/§3.2/D5 point 5・T6 fix round 3) ─
// r5 で idempotencyKey(submit 試行の同一性)と uploadSessionId(R2 namespace の
// 同一性)を分離した。 uploadSessionId の生存範囲(§3.2 の表):
//   維持 — 新規 operation を作らないことが確定した outcome(in_progress /
//     invalid_input / exam_not_found / daily_limit_exceeded / unauthenticated)。
//   無効化 — accepted(replayed 含む)/ throw・応答不明。
//   終了 — entries が空になった時点(removeEntry・別 describe で既に pin 済)。
// D5 point 5: accepted → 完了通知 failed の後は、ready な PDF entry を
// uploading へ戻し新 session で reserve→PUT→finalize をやり直す。

describe('uploadSessionId: client 状態機械(spec r5)', () => {
  it('session は submit をまたいで維持される(operation 未作成 outcome の後、再 submit で同じ uploadSessionId を使い再 PUT は発生しない・idempotencyKey は独立に変わる)', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'invalid_input',
      error: '入力内容が正しくありません',
    })

    await renderWithFiles([makePdf('a.pdf')])
    const sessionId1 = mockReservePdfUploadUrls.mock.calls[0][0].uploadSessionId
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)
    expect(mockFetchPut).toHaveBeenCalledTimes(1)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    const key1 = vi.mocked(submitUpload).mock.calls[0][0].get('idempotencyKey')
    // invalid_input はエラー表示だが PDF entry 自体は影響を受けず ready のまま残る。
    expect(screen.getByText('a.pdf')).toBeInTheDocument()

    // 2 回目 submit(通常成功)。 PDF を追加し直していないので reserve/PUT は増えない
    // (= session が維持され、再 PUT が発生しない)。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)
    expect(mockFetchPut).toHaveBeenCalledTimes(1)
    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(2)
    const fd2 = vi.mocked(submitUpload).mock.calls[1][0]
    expect(fd2.get('uploadSessionId')).toBe(sessionId1)
    // idempotencyKey は session とは独立に必ず変わる。
    const key2 = fd2.get('idempotencyKey')
    expect(key2).not.toBe(key1)
  })

  // fix round 5(Codex P2-①)で `accepted` + `sourceDocumentId` 空の分岐も
  // setErrorAfterAccepted 経由で自動回復するようになったため、この test の
  // 3 つの assertion(① sessionId1 捕捉 ② 次の reserve 呼出が発生 ③ 新
  // session が旧と異なる)は「accepted 後の他の回復可能分岐(Codex fix round 5
  // P2-①)」describe の対応 test に**同一 assertion 単位でそのまま含まれる**
  // (相違点は②の trigger が「手動で PDF を追加する」から「submit 直後に自動で
  // 起きる」へ変わっただけ・保証としては強化: ユーザー操作を待たず回復する
  // ことを直接 pin できるようになった)。 旧 test 固有だった「回復後にさらに
  // PDF を追加しても壊れない」という観点は、round 3 の「session は submit を
  // またいで維持される」test が(理由を問わず non-null な session の再利用を
  // 汎用的に検証しているため)既にカバーしている。 ゆえに重複を避けて
  // 統合により削除した(保証減ではない・詳細は task-6-report.md 参照)。

  // fix round 4(Codex Important P2)で throw も terminal 失敗と同じ扱いで
  // retryPdfSession() を自動的に fire-and-forget 起動するようになった。
  // 「throw 後は session が無効化され、自動回復で新しい uploadSessionId が
  // 使われる」という主張は、下の「throw 後の自動回復(Codex fix round 4)」
  // describe の test がより詳細に(uploading→ready 復帰・再 submit で新
  // session を送ることまで含めて)pin しているため、ここでの重複 test は
  // 統合により削除した(保証不変の整理 — 同じ主張を 2 箇所で pin しない)。
})

// ─── terminal 失敗後の再試行(D5 point 5・spec §3.2 行 4) ─────────────────────
// accepted 後に完了通知が failed(terminal 失敗)を返すと、server 側の全出口
// DELETE(spec §6 本線 2)で旧 session の R2 object も削除される。 ready な PDF
// entry を uploading へ戻し、新 session で reserve→PUT→finalize をやり直して
// おかないと、次の submit クリックで新 namespace に object が存在しないまま
// 送信され T7 の HEAD 検証で落ちる。 poll の解決を待つ必要があるため fake timer
// を使う(docStatuses poll describe と同型)。

describe('terminal 失敗後の再試行(D5 point 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('failed 後、ready の PDF entry が uploading へ戻り、新 session で再 PUT・再 finalize が走る', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'accepted',
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-123',
      replayed: false,
    })
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })
    // mockFetchPut は PDF 直 PUT と docStatuses poll(/api/exams/status)の両方に
    // 使われる global fetch — URL で分岐する。
    mockFetchPut.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.startsWith('/api/exams/status')) {
        return {
          ok: true,
          json: async () => ({ statuses: {}, docStatuses: { 'doc-123': 'failed' } }),
        } as unknown as Response
      }
      return { ok: true } as unknown as Response
    })

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('a.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByText('4 ページ')).toBeInTheDocument()
    const sessionId1 = mockReservePdfUploadUrls.mock.calls[0][0].uploadSessionId
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await vi.advanceTimersByTimeAsync(0)
    })

    // poll 1 周期で failed を観測 → 失敗表示 + retryPdfSession(fire-and-forget)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOC_STATUS_POLL_INTERVAL_MS)
    })
    expect(screen.getAllByText(UPLOAD_INTERRUPTED_NOTICE).length).toBeGreaterThanOrEqual(1)

    // retryPdfSession の reserve→PUT→finalize チェーン(すべて即時解決 mock)を
    // 追加の timer advance で flush する。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(2)
    const sessionId2 = mockReservePdfUploadUrls.mock.calls[1][0].uploadSessionId
    expect(sessionId2).not.toBe(sessionId1)
    expect(mockFinalizePdfSource).toHaveBeenCalledTimes(2)
    // ready へ復帰(pageCount 再表示)。
    expect(screen.getAllByText('4 ページ').length).toBeGreaterThanOrEqual(1)

    // 新 submit が可能な状態(entries が error に落ちていない)。
    const btn2 = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    expect(btn2).toBeEnabled()
  })
})

// ─── throw 後の自動回復(Codex fix round 4・Important P2) ─────────────────────
// submitUpload が throw すると uploadSessionId は無効化されるが、round 3 まで
// では ready な PDF entry 自体は再アップロードされないまま残っていた —
// server 側は session を消費済みとみなせないため空 session を送るか、新規 PDF
// 追加時に旧 session の object と新 session の object が manifest に混在する
// (D5 point 5 の terminal 失敗経路と同じクラスの欠陥)。 throw も「応答不明」=
// 実質 terminal 失敗として retryPdfSession()(D5 point 5 と同じ回復)を自動起動
// するようにした。 fake timer 不要(throw は poll を経由しない)。

describe('throw 後の自動回復(Codex fix round 4)', () => {
  it('submitUpload が throw した後、ready の PDF entry が uploading へ戻り新 session で再 PUT・再 finalize が走り、回復後の submit は null でない新 uploadSessionId を送る', async () => {
    vi.mocked(submitUpload).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))

    await renderWithFiles([makePdf('a.pdf')])
    expect(screen.getByText('10 ページ')).toBeInTheDocument()
    const sessionId1 = mockReservePdfUploadUrls.mock.calls[0][0].uploadSessionId
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)

    const btn = screen.getByRole('button', { name: /AI で問題を抽出する/ })
    await act(async () => {
      fireEvent.click(btn)
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
    })

    // throw → 既存 OTHER 経路のエラー表示(不変)。
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)

    // 自動回復: reserve が新 session で再度呼ばれ(= ready → uploading へ戻して
    // reserve→PUT→finalize をやり直した証跡)、finalize も再度呼ばれて
    // ready(pageCount 再表示)へ復帰する。
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(2)
    const sessionId2 = mockReservePdfUploadUrls.mock.calls[1][0].uploadSessionId
    expect(sessionId2).not.toBe(sessionId1)
    expect(mockFinalizePdfSource).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('10 ページ').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: /AI で問題を抽出する/ })).toBeEnabled()

    // 回復後に再 submit すると、null でない新 uploadSessionId(= 自動回復で
    // 発行された sessionId2)が送られる(= 空文字や旧 session が送られない)。
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'accepted',
      operationId: 'op-2',
      examId: 'exam-1',
      sourceDocumentId: '',
      replayed: true,
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    expect(vi.mocked(submitUpload)).toHaveBeenCalledTimes(2)
    const fd2 = vi.mocked(submitUpload).mock.calls[1][0]
    const sentSessionId = fd2.get('uploadSessionId')
    expect(sentSessionId).toBeTruthy()
    expect(sentSessionId).toBe(sessionId2)
  })
})

// ─── accepted 後の他の回復可能分岐(Codex fix round 5 P2-①) ──────────────────
// round 4 は `failed` と throw だけ回復させたが、`accepted` 後に form が
// 再操作可能に戻る出口は他にも 2 つある: ① poll が `degraded` を返す
// (fetch 連続失敗 / 絶対上限到達) ② `accepted` かつ `sourceDocumentId` が空
// (冪等 replay で元 doc が既に消えている)。 どちらも uploadSessionId は
// accepted 受信時に無効化済みなのに ready な PDF entry がそのまま残り、次の
// submit が空 uploadSessionId を送って必ず落ちる。 `setErrorAfterAccepted`
// helper(`accepted` 分岐内の表示 exit を集約)経由でどちらも
// `retryPdfSession()` を通すようにした。

describe('accepted 後の他の回復可能分岐(Codex fix round 5 P2-①)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepted かつ sourceDocumentId が空でも、ready の PDF entry が uploading へ戻り新 session で再 PUT・再 finalize が走る', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'accepted',
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: '',
      replayed: true,
    })
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('a.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByText('4 ページ')).toBeInTheDocument()
    const sessionId1 = mockReservePdfUploadUrls.mock.calls[0][0].uploadSessionId
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })

    // sourceDocumentId 空は poll に入らず即エラー表示(不変)。
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)

    // 自動回復: reserve/finalize が新 session で再度呼ばれ ready へ復帰する。
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(2)
    const sessionId2 = mockReservePdfUploadUrls.mock.calls[1][0].uploadSessionId
    expect(sessionId2).not.toBe(sessionId1)
    expect(mockFinalizePdfSource).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('4 ページ').length).toBeGreaterThanOrEqual(1)
  })

  it('degraded(poll 縮退)後も、ready の PDF entry が uploading へ戻り新 session で再 PUT・再 finalize が走る', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({
      outcome: 'accepted',
      operationId: 'op-1',
      examId: 'exam-1',
      sourceDocumentId: 'doc-123',
      replayed: false,
    })
    mockFinalizePdfSource
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })
      .mockResolvedValueOnce({ ok: true, data: { pageCount: 4 } })
    // status poll 用の fetch は常に失敗させ、連続失敗による degraded 縮退を誘発する
    // (PDF 直 PUT 用の呼出は URL で分岐して素通しする)。
    mockFetchPut.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.startsWith('/api/exams/status')) {
        throw new Error('offline')
      }
      return { ok: true } as unknown as Response
    })

    render(<UploadForm {...DEFAULT_PROPS} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList([makePdf('a.pdf')]),
        configurable: true,
      })
      fireEvent.change(input)
      await vi.advanceTimersByTimeAsync(50)
    })
    const sessionId1 = mockReservePdfUploadUrls.mock.calls[0][0].uploadSessionId
    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await vi.advanceTimersByTimeAsync(0)
    })

    // DOC_STATUS_POLL_MAX_FETCH_FAILURES 回連続失敗で degraded へ縮退する。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DOC_STATUS_POLL_INTERVAL_MS * DOC_STATUS_POLL_MAX_FETCH_FAILURES,
      )
    })
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)

    // retryPdfSession の reserve→PUT→finalize チェーンを flush する。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockReservePdfUploadUrls).toHaveBeenCalledTimes(2)
    const sessionId2 = mockReservePdfUploadUrls.mock.calls[1][0].uploadSessionId
    expect(sessionId2).not.toBe(sessionId1)
    expect(mockFinalizePdfSource).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('4 ページ').length).toBeGreaterThanOrEqual(1)
  })
})

// ─── hideRetryHint テスト ────────────────────────────────────────────────────
// S-3: submitUpload の outcome 集合(accepted / in_progress / daily_limit_exceeded /
// exam_not_found / invalid_input / unauthenticated)から、 旧 flow と同じ
// hideRetryHint 導出規則(setError 内で code==='UPLOAD_IN_PROGRESS' の時だけ隠す)を
// 検証する。 ②-4b: PDF 混在の事前 block は撤去済み(spec D3・混在可)なので、 その
// テストは無い(代わりに submit manifest 組立の describe で「混在してもブロック
// されない」ことを pin している)。

describe('hideRetryHint: submitUpload の outcome から retry hint 表示/非表示を検証', () => {
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

    // S-4: `accepted` を受け取っただけでは result page へ遷移しない(本処理は
    // after() で走っており、この時点では何も完了していない)。遷移は poll が
    // completed を返してから — 下の「docStatuses poll」describe で pin する。
    expect(mockRouterPush).not.toHaveBeenCalled()
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

  it('画像のみの batch は submit のたびに新しい idempotencyKey を発行する(ユーザー再試行 = 別 operation)', async () => {
    // PDF を presign していない batch は従来どおり submit ごとに新規発行する
    // (R2 の namespace 依存が無く、変える理由がない)。
    // 2 回とも in_progress にして poll に入らせない(この test の関心は key だけ)。
    vi.mocked(submitUpload).mockResolvedValue({ outcome: 'in_progress' })
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

// ─── S-4: docStatuses poll / 縮退 / 離脱ガード撤去 ─────────────────────────────

import {
  DOC_STATUS_POLL_INTERVAL_MS,
  DOC_STATUS_POLL_LIMIT_MS,
  DOC_STATUS_POLL_MAX_FETCH_FAILURES,
  UPLOAD_INTERRUPTED_NOTICE,
  UPLOAD_PENDING_NOTICE,
} from '../_lib/constants'

function statusOk(docStatuses: Record<string, string>) {
  return {
    ok: true,
    json: async () => ({ statuses: {}, docStatuses }),
  } as unknown as Response
}

describe('docStatuses poll(S-4)', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch = vi.fn().mockResolvedValue(statusOk({ 'doc-123': 'processing' }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** fake timer 下で file を追加して render する(renderWithFiles の fake 版)。 */
  async function renderAndSubmit(
    files: File[] = [makeImage('a.jpg')],
    opts: { strict?: boolean } = {},
  ) {
    const form = <UploadForm {...DEFAULT_PROPS} />
    render(opts.strict ? <StrictMode>{form}</StrictMode> : form)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: makeFileList(files),
        configurable: true,
      })
      fireEvent.change(input)
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('completed を観測してから result page へ遷移する(それまでは遷移しない)', async () => {
    await renderAndSubmit()

    // 受付直後: まだ 1 度も poll していない = 遷移もしない。
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockRouterPush).not.toHaveBeenCalled()

    // 1 周期目は processing → まだ遷移しない。
    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // fix round 2(Codex P2): 自分の doc を名指しする(endpoint の既定 map は
    // exam ごと最新 1 件に縮約されるため、名指ししないと自分の doc が落ちうる)。
    expect(mockFetch.mock.calls[0][0]).toBe('/api/exams/status?doc=doc-123')
    expect(mockRouterPush).not.toHaveBeenCalled()

    // 2 周期目で completed → 遷移。
    mockFetch.mockResolvedValue(statusOk({ 'doc-123': 'completed' }))
    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    expect(mockRouterPush).toHaveBeenCalledWith('/app/upload/result/doc-123')
  })

  // StrictMode(next.config.ts: reactStrictMode: true)の dev 二重実行
  // setup→cleanup→setup で mountedRef が false 固定になると、poll は最初の周期で
  // 'aborted' を返し、spinner が出たまま auto-nav も失敗表示も永久に起きない。
  // production build では二重実行しないため stg smoke には出ず、ローカル開発でだけ
  // 新 flow が丸ごと死ぬ — 素の render では検出できないのでここで張る。
  it('StrictMode の二重 mount 後も poll が動く(mountedRef が false 固定にならない)', async () => {
    await renderAndSubmit([makeImage('a.jpg')], { strict: true })

    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockResolvedValue(statusOk({ 'doc-123': 'completed' }))
    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    expect(mockRouterPush).toHaveBeenCalledWith('/app/upload/result/doc-123')
  })

  it('自分以外の doc が completed でも遷移しない(自 doc の key だけを見る)', async () => {
    mockFetch.mockResolvedValue(statusOk({ 'doc-other': 'completed' }))
    await renderAndSubmit()

    await advance(DOC_STATUS_POLL_INTERVAL_MS * 3)
    expect(mockRouterPush).not.toHaveBeenCalled()
  })

  it('failed を観測したら失敗面の文言を出す(I-3(b) 後も従来どおり)', async () => {
    mockFetch.mockResolvedValue(statusOk({ 'doc-123': 'failed' }))
    await renderAndSubmit()

    await advance(DOC_STATUS_POLL_INTERVAL_MS)

    expect(mockRouterPush).not.toHaveBeenCalled()
    // 開発用 ErrorDetails(staging/dev のみ)にも同文が出るため件数で見る。
    expect(screen.getAllByText(UPLOAD_INTERRUPTED_NOTICE).length).toBeGreaterThanOrEqual(1)
    // failed = terminal 化済み = 再試行が実行可能な面。ここでは再試行を勧める。
    expect(screen.getAllByText(/再度お試しください/).length).toBeGreaterThanOrEqual(1)
    // 中立文言(未確定面)を混ぜない。
    expect(screen.queryByText(UPLOAD_PENDING_NOTICE)).not.toBeInTheDocument()
    // 「ファイルを変更して再試行」は出さない(ファイルの問題ではない)。
    expect(
      screen.queryByText(/ファイルを変更して再度お試しください/),
    ).not.toBeInTheDocument()
    // poll は止まる(失敗確定後に叩き続けない)。
    const callsAtFailure = mockFetch.mock.calls.length
    await advance(DOC_STATUS_POLL_INTERVAL_MS * 3)
    expect(mockFetch.mock.calls.length).toBe(callsAtFailure)
  })

  it(`連続 ${DOC_STATUS_POLL_MAX_FETCH_FAILURES} 回の fetch 失敗で poll を止め「試験一覧で確認」へ縮退する`, async () => {
    mockFetch.mockRejectedValue(new Error('offline'))
    await renderAndSubmit()

    // 1 回手前(5 回)ではまだ縮退しない。
    await advance(DOC_STATUS_POLL_INTERVAL_MS * (DOC_STATUS_POLL_MAX_FETCH_FAILURES - 1))
    expect(
      screen.queryByText(/処理状況を確認できませんでした/),
    ).not.toBeInTheDocument()

    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)

    const callsAtDegrade = mockFetch.mock.calls.length
    await advance(DOC_STATUS_POLL_INTERVAL_MS * 3)
    expect(mockFetch.mock.calls.length).toBe(callsAtDegrade)
  })

  it('連続でない失敗(間に成功が挟まる)は縮退させない(連続カウンタが reset される)', async () => {
    await renderAndSubmit()

    for (let i = 0; i < DOC_STATUS_POLL_MAX_FETCH_FAILURES - 1; i++) {
      mockFetch.mockRejectedValueOnce(new Error('offline'))
      await advance(DOC_STATUS_POLL_INTERVAL_MS)
    }
    // 成功を 1 回挟む(既定 mock = processing)。
    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    for (let i = 0; i < DOC_STATUS_POLL_MAX_FETCH_FAILURES - 1; i++) {
      mockFetch.mockRejectedValueOnce(new Error('offline'))
      await advance(DOC_STATUS_POLL_INTERVAL_MS)
    }

    expect(
      screen.queryByText(/処理状況を確認できませんでした/),
    ).not.toBeInTheDocument()
  })

  it('endpoint が正常でも processing のままなら絶対上限で poll を止める(hard-death の無限 poll 防止)', async () => {
    await renderAndSubmit()

    // 上限の 1 周期手前まではまだ回り続ける。
    await advance(DOC_STATUS_POLL_LIMIT_MS - DOC_STATUS_POLL_INTERVAL_MS)
    expect(
      screen.queryByText(/処理状況を確認できませんでした/),
    ).not.toBeInTheDocument()

    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)

    const callsAtDegrade = mockFetch.mock.calls.length
    await advance(DOC_STATUS_POLL_INTERVAL_MS * 5)
    expect(mockFetch.mock.calls.length).toBe(callsAtDegrade)
  })

  it('!res.ok(5xx)は fetch 失敗として数える', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    } as unknown as Response)
    await renderAndSubmit()

    await advance(DOC_STATUS_POLL_INTERVAL_MS * DOC_STATUS_POLL_MAX_FETCH_FAILURES)
    expect(
      screen.getAllByText(/処理状況を確認できませんでした/).length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('unmount 後は poll を続けない(離脱後に fetch を撃ち続けない)', async () => {
    await renderAndSubmit()
    await advance(DOC_STATUS_POLL_INTERVAL_MS)
    const callsBefore = mockFetch.mock.calls.length

    cleanup()
    await advance(DOC_STATUS_POLL_INTERVAL_MS * 5)

    expect(mockFetch.mock.calls.length).toBe(callsBefore)
  })
})

// ─── S-4: 離脱ガードの撤去 + 処理中案内の文言 ─────────────────────────────────
describe('離脱ガード撤去(S-4)', () => {
  it('submitting 中に beforeunload / popstate を登録しない(閉じても処理は続く)', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const pushStateSpy = vi.spyOn(window.history, 'pushState')

    await renderWithFiles([makeImage('a.jpg')])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    const events = addSpy.mock.calls.map((c) => c[0])
    expect(events).not.toContain('beforeunload')
    expect(events).not.toContain('popstate')
    // popstate sentinel(history.pushState でダミー entry を積む)も撤去済み。
    expect(pushStateSpy).not.toHaveBeenCalled()

    addSpy.mockRestore()
    pushStateSpy.mockRestore()
  })

  it('処理中案内は「閉じても後で確認できる」旨(「閉じないでください」を出さない)', async () => {
    await renderWithFiles([makeImage('a.jpg')])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    expect(
      screen.getByText(/この画面を閉じても処理は続き/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/閉じたり戻ったりしないでください/),
    ).not.toBeInTheDocument()
  })

  // I-3(b): in_progress = 別 op が valid lease を保持 = 生きている面。 live-op gate が
  // submit を弾いている最中なので「再度お試しください」は実行不能な行動の案内になる。
  // 定数を 1 本に戻す(= この面にも failed 文言を当てる)と negative assert が落ちる。
  it('in_progress は中立文言を出す — 中断を主張しない / 再試行を勧めない', async () => {
    vi.mocked(submitUpload).mockResolvedValueOnce({ outcome: 'in_progress' })

    await renderWithFiles([makeImage('a.jpg')])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI で問題を抽出する/ }))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })

    // 開発用 ErrorDetails(staging/dev のみ)にも同文が出るため件数で見る。
    expect(screen.getAllByText(UPLOAD_PENDING_NOTICE).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/再度お試しください/)).not.toBeInTheDocument()
    expect(screen.queryByText(/中断された可能性があります/)).not.toBeInTheDocument()
    expect(screen.queryByText(UPLOAD_INTERRUPTED_NOTICE)).not.toBeInTheDocument()
  })
})

// ─── I-3(b): 公開文言 2 本に共通の規律(機械強制) ─────────────────────────────
describe('公開文言の規律(失敗面 / 中立面の両方)', () => {
  it('どちらも待ち時間の数値を書かない / 試験の削除を案内しない', () => {
    for (const notice of [UPLOAD_INTERRUPTED_NOTICE, UPLOAD_PENDING_NOTICE]) {
      expect(notice).not.toMatch(/\d+\s*(分|秒|時間)/)
      expect(notice).not.toContain('削除')
    }
  })

  it('2 本は別文言であり、中立面の文言は中断も再試行も言わない', () => {
    expect(UPLOAD_PENDING_NOTICE).not.toBe(UPLOAD_INTERRUPTED_NOTICE)
    expect(UPLOAD_PENDING_NOTICE).not.toContain('中断')
    expect(UPLOAD_PENDING_NOTICE).not.toContain('再度お試しください')
    // 失敗面は逆に、再試行が実行可能になった面なので勧める。
    expect(UPLOAD_INTERRUPTED_NOTICE).toContain('再度お試しください')
  })
})

// ─── generateId フォールバック(Codex fix round 5 P2-②) ────────────────────────
// crypto.randomUUID が使えない環境向けの fallback は、r5 以降 uploadSessionId /
// fileId が reserve/finalize で `z.uuid({ version: 'v4' })` 検証されるため、
// 実際に UUID v4 形式の文字列を生成しなければならない(旧
// `${Date.now()}-${Math.random()}` は形式不一致で常に invalid_input になって
// いた — idempotencyKey は server 側で「≤256 文字の文字列」としか検証されない
// ため r5 以前は無害だった)。

describe('generateId フォールバック(Codex fix round 5 P2-②)', () => {
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  it('crypto.randomUUID が無い環境でも、PDF の uploadSessionId / fileId は UUID v4 形式になる', async () => {
    const originalCrypto = globalThis.crypto
    // randomUUID だけを落とす(getRandomValues は残る環境を模す — 実ブラウザで
    // 起こりうる構成)。
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      },
      writable: true,
      configurable: true,
    })
    try {
      await renderWithFiles([makePdf('a.pdf')])
      const call = mockReservePdfUploadUrls.mock.calls[0][0]
      expect(call.uploadSessionId).toMatch(UUID_V4_RE)
      expect(call.files[0].fileId).toMatch(UUID_V4_RE)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      })
    }
  })

  it('crypto.getRandomValues も無い環境(Math.random 経路)でも UUID v4 形式になる', async () => {
    const originalCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      writable: true,
      configurable: true,
    })
    try {
      await renderWithFiles([makePdf('a.pdf')])
      const call = mockReservePdfUploadUrls.mock.calls[0][0]
      expect(call.uploadSessionId).toMatch(UUID_V4_RE)
      expect(call.files[0].fileId).toMatch(UUID_V4_RE)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      })
    }
  })
})
