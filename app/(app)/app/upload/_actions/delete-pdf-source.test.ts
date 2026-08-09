import { describe, it, expect, vi, beforeEach } from 'vitest'

// deletePdfSource のテスト(②-4b §1 design spec §3/§4/§6)。
// r2(deleteObject)と integration-failures(recordIntegrationFailure)は mock する
// (finalize-pdf-source.test.ts の vi.hoisted 様式に倣う)。

async function importUnauthenticatedError() {
  const mod = await import('@/lib/auth/errors')
  return mod.UnauthenticatedError
}

const { mockGetCurrentUser, mockDeleteObject, mockRecordIntegrationFailure } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockRecordIntegrationFailure: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/storage/r2', () => ({
  deleteObject: mockDeleteObject,
}))

vi.mock('@/lib/integration-failures', () => ({
  recordIntegrationFailure: mockRecordIntegrationFailure,
}))

async function importAction() {
  return await import('./delete-pdf-source')
}

const USER_ID = '11111111-1111-4111-8111-111111111111'
const UPLOAD_SESSION_ID = '22222222-2222-4222-8222-222222222222'
const FILE_ID = '33333333-3333-4333-8333-333333333333'
const OBJECT_KEY = `src/${USER_ID}/${UPLOAD_SESSION_ID}/${FILE_ID}.pdf`

const validInput = {
  uploadSessionId: UPLOAD_SESSION_ID,
  fileId: FILE_ID,
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockDeleteObject.mockReset()
  mockRecordIntegrationFailure.mockReset()
  mockGetCurrentUser.mockResolvedValue({
    id: USER_ID,
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
  mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })
  mockRecordIntegrationFailure.mockResolvedValue(undefined)
})

describe('deletePdfSource', () => {
  it('未認証(null)→ { ok: false }, deleteObject 呼出なし', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('未認証(UnauthenticatedError throw)→ { ok: false }, deleteObject 呼出なし', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('非 uuid fileId → { ok: false }, deleteObject 呼出なし', async () => {
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource({ ...validInput, fileId: 'not-a-uuid' })
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('非 uuid uploadSessionId → { ok: false }, deleteObject 呼出なし', async () => {
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource({ ...validInput, uploadSessionId: 'not-a-uuid' })
    expect(r.ok).toBe(false)
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('所有権 pin: key は authed userId + 検証済み uploadSessionId/fileId のみから構築される — 入力に紛れ込ませた key 系 field は無視される', async () => {
    const { deletePdfSource } = await importAction()
    const forged = {
      ...validInput,
      key: 'src/attacker/forged/forged.pdf',
      objectKey: 'src/attacker/forged/forged.pdf',
      userId: 'not-the-authed-user',
    }
    await deletePdfSource(forged as unknown as Parameters<typeof deletePdfSource>[0])
    expect(mockDeleteObject).toHaveBeenCalledWith(OBJECT_KEY)
  })

  it('正常 → sourcePdfObjectKey の key で deleteObject 呼出、台帳不呼出、{ ok: true }', async () => {
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource(validInput)
    expect(r).toEqual({ ok: true })
    expect(mockDeleteObject).toHaveBeenCalledWith(OBJECT_KEY)
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })

  it('deleteObject 失敗({ ok: false, status: 500 })→ 台帳が r2_staging_delete + { objectKey, status } で呼ばれる', async () => {
    mockDeleteObject.mockResolvedValueOnce({ ok: false, status: 500 })
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockRecordIntegrationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'r2_staging_delete',
        userId: USER_ID,
        context: { objectKey: OBJECT_KEY, status: 500 },
      }),
    )
  })

  it('deleteObject 404({ ok: true, status: 404 })→ { ok: true } + 台帳不呼出(重複 DELETE の中心契約)', async () => {
    mockDeleteObject.mockResolvedValueOnce({ ok: true, status: 404 })
    const { deletePdfSource } = await importAction()
    const r = await deletePdfSource(validInput)
    expect(r).toEqual({ ok: true })
    expect(mockRecordIntegrationFailure).not.toHaveBeenCalled()
  })

  it('recordIntegrationFailure reject → 飲んで { ok: false } を返す(throw しない)', async () => {
    mockDeleteObject.mockResolvedValueOnce({ ok: false, status: 500 })
    mockRecordIntegrationFailure.mockRejectedValueOnce(new Error('ledger down'))
    const { deletePdfSource } = await importAction()
    await expect(deletePdfSource(validInput)).resolves.toEqual({
      ok: false,
      error: expect.any(String),
    })
  })
})
