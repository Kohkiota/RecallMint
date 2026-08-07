import { describe, it, expect, vi, beforeEach } from 'vitest'

// finalizePdfSource のテスト(②-4b design spec §2/§4 D4/§6 本線 1)。
// r2(headObject/getObject/deleteObject)と pdf-rasterize(loadPdf)は mock する。
// pdf-rasterize は importOriginal で実 PdfParseError class を保ったまま
// loadPdf だけを差し替える(instanceof チェックが実クラスと一致するようにする —
// upload-pipeline.test.ts の既存 importOriginal 様式に倣う)。

async function importUnauthenticatedError() {
  const mod = await import('@/lib/auth/errors')
  return mod.UnauthenticatedError
}

const { mockGetCurrentUser, mockHeadObject, mockGetObject, mockDeleteObject, mockLoadPdf } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockHeadObject: vi.fn(),
    mockGetObject: vi.fn(),
    mockDeleteObject: vi.fn(),
    mockLoadPdf: vi.fn(),
  }))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/storage/r2', () => ({
  headObject: mockHeadObject,
  getObject: mockGetObject,
  deleteObject: mockDeleteObject,
}))

vi.mock('@/lib/media/pdf-rasterize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/pdf-rasterize')>()
  return { ...actual, loadPdf: mockLoadPdf }
})

async function importAction() {
  return await import('./finalize-pdf-source')
}

const USER_ID = '11111111-1111-4111-8111-111111111111'
const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222'
const FILE_ID = '33333333-3333-4333-8333-333333333333'
const OBJECT_KEY = `src/${USER_ID}/${IDEMPOTENCY_KEY}/${FILE_ID}.pdf`
const DECLARED_BYTES = 1000

function makeHandle(pageCount: number) {
  return { pageCount, renderPageWebp: vi.fn(), destroy: vi.fn() }
}

const validInput = {
  idempotencyKey: IDEMPOTENCY_KEY,
  fileId: FILE_ID,
  declaredBytes: DECLARED_BYTES,
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockHeadObject.mockReset()
  mockGetObject.mockReset()
  mockDeleteObject.mockReset()
  mockLoadPdf.mockReset()
  mockGetCurrentUser.mockResolvedValue({
    id: USER_ID,
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
  mockHeadObject.mockResolvedValue({ exists: true, contentLength: DECLARED_BYTES })
  mockGetObject.mockResolvedValue({ bytes: Buffer.from('pdf-bytes') })
  mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })
  mockLoadPdf.mockResolvedValue(makeHandle(3))
})

describe('finalizePdfSource', () => {
  it('未認証(null)→ { ok: false }, headObject 呼出なし', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
    expect(mockHeadObject).not.toHaveBeenCalled()
  })

  it('未認証(UnauthenticatedError throw)→ { ok: false }, headObject 呼出なし', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockHeadObject).not.toHaveBeenCalled()
  })

  it('non-UnauthenticatedError は隠さず伝播する(握り潰さない)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('db down'))
    const { finalizePdfSource } = await importAction()
    await expect(finalizePdfSource(validInput)).rejects.toThrow('db down')
  })

  it('正常 → { ok: true, data: { pageCount } }、GET timeoutMs=60000、deleteObject 呼出なし', async () => {
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r).toEqual({ ok: true, data: { pageCount: 3 } })
    expect(mockHeadObject).toHaveBeenCalledWith(OBJECT_KEY)
    expect(mockGetObject).toHaveBeenCalledWith(OBJECT_KEY, { timeoutMs: 60_000 })
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('HEAD 不在(exists:false)→ { ok: false }, getObject/loadPdf/deleteObject 呼出なし', async () => {
    mockHeadObject.mockResolvedValueOnce({ exists: false, contentLength: null })
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(mockLoadPdf).not.toHaveBeenCalled()
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('HEAD contentLength ≠ declaredBytes → { ok: false }(presign 署名値との契約 pin・Codex I5)', async () => {
    mockHeadObject.mockResolvedValueOnce({
      exists: true,
      contentLength: DECLARED_BYTES - 1,
    })
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('HEAD contentLength = null(検証不能)→ { ok: false }', async () => {
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: null })
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
  })

  it('pageCount > OCR_MAX_PAGES(40)→ { ok: false } + deleteObject 呼出 pin', async () => {
    mockLoadPdf.mockResolvedValueOnce(makeHandle(41))
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).toHaveBeenCalledWith(OBJECT_KEY)
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
  })

  it('pageCount = OCR_MAX_PAGES(40)は valid(境界)、deleteObject 呼出なし', async () => {
    mockLoadPdf.mockResolvedValueOnce(makeHandle(40))
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r).toEqual({ ok: true, data: { pageCount: 40 } })
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('pageCount = 0 → { ok: false } + deleteObject 呼出 pin(spec D7 r4「pageCount ≥ 1」不変条件・Codex 独立レビュー Important 1)', async () => {
    mockLoadPdf.mockResolvedValueOnce(makeHandle(0))
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).toHaveBeenCalledWith(OBJECT_KEY)
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
  })

  it('pageCount = 1 は valid(下限境界)、deleteObject 呼出なし', async () => {
    mockLoadPdf.mockResolvedValueOnce(makeHandle(1))
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r).toEqual({ ok: true, data: { pageCount: 1 } })
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('PdfParseError(解析不能)→ { ok: false } + deleteObject 呼出 pin', async () => {
    const { PdfParseError } = await import('@/lib/media/pdf-rasterize')
    mockLoadPdf.mockRejectedValueOnce(new PdfParseError('corrupt or encrypted'))
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).toHaveBeenCalledWith(OBJECT_KEY)
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
  })

  it('deleteObject の成否は応答を変えない(best-effort・delete が失敗しても reject 応答は変わらない)', async () => {
    mockDeleteObject.mockResolvedValueOnce({ ok: false, status: 500 })
    mockLoadPdf.mockResolvedValueOnce(makeHandle(41))
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource(validInput)
    expect(r.ok).toBe(false)
  })

  it('loadPdf が PdfParseError 以外を throw したら伝播する(握り潰さない)', async () => {
    mockLoadPdf.mockRejectedValueOnce(new Error('unexpected wasm crash'))
    const { finalizePdfSource } = await importAction()
    await expect(finalizePdfSource(validInput)).rejects.toThrow('unexpected wasm crash')
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('非 uuid fileId → { ok: false }, headObject 呼出なし', async () => {
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource({ ...validInput, fileId: 'not-a-uuid' })
    expect(r.ok).toBe(false)
    expect(mockHeadObject).not.toHaveBeenCalled()
  })

  it('非 uuid idempotencyKey → { ok: false }, headObject 呼出なし', async () => {
    const { finalizePdfSource } = await importAction()
    const r = await finalizePdfSource({ ...validInput, idempotencyKey: 'not-a-uuid' })
    expect(r.ok).toBe(false)
    expect(mockHeadObject).not.toHaveBeenCalled()
  })

  it(
    '所有権 pin: key は authed userId + 検証済み idempotencyKey/fileId のみから' +
      '構築される — 入力に紛れ込ませた key 系 field は無視される(Codex I7)',
    async () => {
      const { finalizePdfSource } = await importAction()
      const forged = {
        ...validInput,
        // `FinalizePdfSourceInput` は key 文字列を受け取る field を型として
        // 持たない。 as unknown で無理やり紛れ込ませ、action が実際に無視する
        // ことを実行時に確認する(構築経路そのものの pin)。
        key: 'src/attacker/forged/forged.pdf',
        objectKey: 'src/attacker/forged/forged.pdf',
        userId: 'not-the-authed-user',
      }
      await finalizePdfSource(
        forged as unknown as Parameters<typeof finalizePdfSource>[0],
      )
      expect(mockHeadObject).toHaveBeenCalledWith(OBJECT_KEY)
    },
  )

  it('所有権 pin: authed userId を差し替えると key も追随する(session から都度導出)', async () => {
    const otherUserId = '44444444-4444-4444-8444-444444444444'
    mockGetCurrentUser.mockResolvedValueOnce({
      id: otherUserId,
      clerkId: 'clerk-2',
      email: 'u2@example.com',
      plan: 'free',
      billingInterval: null,
      deletedAt: null,
      stripeCustomerId: null,
    })
    const { finalizePdfSource } = await importAction()
    await finalizePdfSource(validInput)
    expect(mockHeadObject).toHaveBeenCalledWith(
      `src/${otherUserId}/${IDEMPOTENCY_KEY}/${FILE_ID}.pdf`,
    )
  })
})
