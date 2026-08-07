import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// reservePdfUploadUrls のテスト(②-4b design spec §2/§3/D7)。
// DB 無し(spec §3 分岐 (a))ゆえ db mock は不要 — r2 の presignPutUrl だけを
// mock する(実 sourcePdfObjectKey は本物のまま使い、key 構築の実挙動を検証する)。

async function importUnauthenticatedError() {
  const mod = await import('@/lib/auth/errors')
  return mod.UnauthenticatedError
}

const { mockGetCurrentUser, mockPresignPutUrl } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockPresignPutUrl: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/storage/r2', () => ({
  presignPutUrl: mockPresignPutUrl,
}))

async function importAction() {
  return await import('./reserve-pdf-upload')
}

const USER_ID = '11111111-1111-4111-8111-111111111111'
const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222'

function makeFile(declaredBytes = 1000) {
  return { fileId: randomUUID(), declaredBytes }
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockPresignPutUrl.mockReset()
  mockGetCurrentUser.mockResolvedValue({
    id: USER_ID,
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
  mockPresignPutUrl.mockResolvedValue('https://r2.example.com/put-signed')
})

describe('reservePdfUploadUrls', () => {
  it('未認証(null)→ { ok: false }, presign 発行なし', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { reservePdfUploadUrls } = await importAction()
    const r = await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [makeFile()],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('未認証(UnauthenticatedError throw)→ { ok: false }, presign 発行なし', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { reservePdfUploadUrls } = await importAction()
    const r = await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [makeFile()],
    })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('non-UnauthenticatedError は隠さず伝播する(握り潰さない)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('db down'))
    const { reservePdfUploadUrls } = await importAction()
    await expect(
      reservePdfUploadUrls({ idempotencyKey: IDEMPOTENCY_KEY, files: [makeFile()] }),
    ).rejects.toThrow('db down')
  })

  it('正常 → N 件の presigned URL を fileId 対応で返す', async () => {
    const { reservePdfUploadUrls } = await importAction()
    const files = [makeFile(1000), makeFile(2000), makeFile(3000)]
    const r = await reservePdfUploadUrls({ idempotencyKey: IDEMPOTENCY_KEY, files })
    expect(r.ok).toBe(true)
    if (r.ok && r.data) {
      expect(r.data).toHaveLength(3)
      expect(r.data.map((d) => d.fileId).sort()).toEqual(
        files.map((f) => f.fileId).sort(),
      )
      for (const d of r.data) {
        expect(d.uploadUrl).toBe('https://r2.example.com/put-signed')
      }
    }
    expect(mockPresignPutUrl).toHaveBeenCalledTimes(3)
    // key は authed userId + idempotencyKey + fileId から構築される。
    expect(mockPresignPutUrl).toHaveBeenCalledWith(
      `src/${USER_ID}/${IDEMPOTENCY_KEY}/${files[0].fileId}.pdf`,
      'application/pdf',
      1000,
    )
  })

  it('fileId 重複 → { ok: false }, presign 発行なし', async () => {
    const { reservePdfUploadUrls } = await importAction()
    const dupId = randomUUID()
    const r = await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [
        { fileId: dupId, declaredBytes: 1000 },
        { fileId: dupId, declaredBytes: 2000 },
      ],
    })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('件数 > 40(OCR_MAX_PAGES)→ { ok: false }, presign 発行なし', async () => {
    const { reservePdfUploadUrls } = await importAction()
    const files = Array.from({ length: 41 }, () => makeFile())
    const r = await reservePdfUploadUrls({ idempotencyKey: IDEMPOTENCY_KEY, files })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('件数 = 40 は valid(境界)', async () => {
    const { reservePdfUploadUrls } = await importAction()
    const files = Array.from({ length: 40 }, () => makeFile())
    const r = await reservePdfUploadUrls({ idempotencyKey: IDEMPOTENCY_KEY, files })
    expect(r.ok).toBe(true)
  })

  it('declaredBytes > MAX_PDF_BYTES(50MB)→ { ok: false }, presign 発行なし', async () => {
    const { MAX_PDF_BYTES } = await import('../_lib/constants')
    const { reservePdfUploadUrls } = await importAction()
    const r = await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [makeFile(MAX_PDF_BYTES + 1)],
    })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('declaredBytes = MAX_PDF_BYTES ちょうどは valid(境界)', async () => {
    const { MAX_PDF_BYTES } = await import('../_lib/constants')
    const { reservePdfUploadUrls } = await importAction()
    const r = await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [makeFile(MAX_PDF_BYTES)],
    })
    expect(r.ok).toBe(true)
  })

  it('Σ declaredBytes > MAX_PDF_TOTAL_BYTES(200MB)→ { ok: false }, presign 発行なし(spec r4)', async () => {
    const { MAX_PDF_BYTES } = await import('../_lib/constants')
    const { reservePdfUploadUrls } = await importAction()
    // 各 file は per-file 上限(50MB)以内・件数も 5 ≤ 40 だが、合計 250MB > 200MB。
    const files = Array.from({ length: 5 }, () => makeFile(MAX_PDF_BYTES))
    const r = await reservePdfUploadUrls({ idempotencyKey: IDEMPOTENCY_KEY, files })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('Σ declaredBytes = MAX_PDF_TOTAL_BYTES ちょうどは valid(境界)', async () => {
    const { MAX_PDF_TOTAL_BYTES } = await import('../_lib/constants')
    const { reservePdfUploadUrls } = await importAction()
    // 4 file × 50MB = 200MB ちょうど(per-file 上限内・合計は上限ちょうど)。
    const perFile = MAX_PDF_TOTAL_BYTES / 4
    const files = Array.from({ length: 4 }, () => makeFile(perFile))
    const r = await reservePdfUploadUrls({ idempotencyKey: IDEMPOTENCY_KEY, files })
    expect(r.ok).toBe(true)
  })

  it('非 uuid idempotencyKey → { ok: false }, presign 発行なし', async () => {
    const { reservePdfUploadUrls } = await importAction()
    const r = await reservePdfUploadUrls({
      idempotencyKey: 'not-a-uuid',
      files: [makeFile()],
    })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('非 uuid fileId → { ok: false }, presign 発行なし', async () => {
    const { reservePdfUploadUrls } = await importAction()
    const r = await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [{ fileId: 'not-a-uuid', declaredBytes: 1000 }],
    })
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it(
    '所有権 pin: key は authed userId + 検証済み idempotencyKey/fileId のみから' +
      '構築される — 入力に紛れ込ませた key 系 field は無視される(Codex I7)',
    async () => {
      const { reservePdfUploadUrls } = await importAction()
      const fileId = randomUUID()
      const forged = {
        idempotencyKey: IDEMPOTENCY_KEY,
        files: [{ fileId, declaredBytes: 1000 }],
        // `ReservePdfUploadInput` は key 文字列を受け取る field を型として
        // 持たない。 as unknown で無理やり紛れ込ませ、action が実際に無視する
        // ことを実行時に確認する(構築経路そのものの pin)。
        key: 'src/attacker/forged/forged.pdf',
        objectKey: 'src/attacker/forged/forged.pdf',
        userId: 'not-the-authed-user',
      }
      const r = await reservePdfUploadUrls(
        forged as unknown as Parameters<typeof reservePdfUploadUrls>[0],
      )
      expect(r.ok).toBe(true)
      expect(mockPresignPutUrl).toHaveBeenCalledWith(
        `src/${USER_ID}/${IDEMPOTENCY_KEY}/${fileId}.pdf`,
        'application/pdf',
        1000,
      )
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
    const { reservePdfUploadUrls } = await importAction()
    const fileId = randomUUID()
    await reservePdfUploadUrls({
      idempotencyKey: IDEMPOTENCY_KEY,
      files: [{ fileId, declaredBytes: 1000 }],
    })
    expect(mockPresignPutUrl).toHaveBeenCalledWith(
      `src/${otherUserId}/${IDEMPOTENCY_KEY}/${fileId}.pdf`,
      'application/pdf',
      1000,
    )
  })
})
