// submit-review server action の unit test。
// getCurrentUser / getDb を mock し、 auth 失敗 / rating バリデーション /
// 正常系 / throw → ok:false 変換を検証する。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// -----------------------------------------------------------------------
// Hoisted mocks
// -----------------------------------------------------------------------
const { mockGetCurrentUser, mockSubmitReviewTx, dbTransactionSpy } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockSubmitReviewTx: vi.fn(),
    dbTransactionSpy: vi.fn(),
  }))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/cards/submit-review-tx', () => ({
  submitReviewTx: mockSubmitReviewTx,
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    transaction: dbTransactionSpy,
  }),
}))

// -----------------------------------------------------------------------
// Import under test (after mocks are registered)
// -----------------------------------------------------------------------
async function importAction() {
  return await import('./submit-review')
}

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------
const mockUser = {
  id: 'user-1',
  clerkId: 'clerk-1',
  email: 'test@example.com',
  plan: 'free',
  billingInterval: null,
  deletedAt: null,
  stripeCustomerId: null,
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockSubmitReviewTx.mockReset()
  dbTransactionSpy.mockReset()
  // デフォルト: 認証済みユーザー
  mockGetCurrentUser.mockResolvedValue(mockUser)
  // デフォルト: transaction が submitReviewTx を呼び出すように設定
  dbTransactionSpy.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {} // minimal tx object
      return fn(tx)
    },
  )
  // デフォルト: submitReviewTx が成功を返す
  mockSubmitReviewTx.mockResolvedValue({ correct: true })
})

describe('submitReview', () => {
  // -----------------------------------------------------------------------
  // 認証ガード
  // -----------------------------------------------------------------------
  it('auth fail (getCurrentUser → null) → { ok: false, error: "認証が必要です" }', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { submitReview } = await importAction()
    const r = await submitReview('card-1', 3)
    expect(r).toEqual({ ok: false, error: '認証が必要です' })
    expect(dbTransactionSpy).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // rating バリデーション
  // -----------------------------------------------------------------------
  it.each([0, 5, -1, 2.5])('rating=%s → { ok: false, error: "invalid rating" }', async (rating) => {
    const { submitReview } = await importAction()
    const r = await submitReview('card-1', rating)
    expect(r).toEqual({ ok: false, error: 'invalid rating' })
    expect(dbTransactionSpy).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 正常系
  // -----------------------------------------------------------------------
  it('正常系: { ok: true, data: { correct: true } } を返す', async () => {
    mockSubmitReviewTx.mockResolvedValueOnce({ correct: true })
    const { submitReview } = await importAction()
    const r = await submitReview('card-1', 3)
    expect(r).toEqual({ ok: true, data: { correct: true } })
  })

  it('rating=1 (incorrect): { ok: true, data: { correct: false } } を返す', async () => {
    mockSubmitReviewTx.mockResolvedValueOnce({ correct: false })
    const { submitReview } = await importAction()
    const r = await submitReview('card-1', 1)
    expect(r).toEqual({ ok: true, data: { correct: false } })
  })

  it('db.transaction を呼び、submitReviewTx に userId / cardId / rating / now を渡す', async () => {
    const { submitReview } = await importAction()
    await submitReview('card-42', 2)
    // dbTransactionSpy が呼ばれた = transaction が発火
    expect(dbTransactionSpy).toHaveBeenCalledOnce()
    // submitReviewTx が呼ばれ、 userId が mockUser.id で渡されていること
    expect(mockSubmitReviewTx).toHaveBeenCalledWith(
      expect.anything(), // tx
      expect.objectContaining({
        userId: 'user-1',
        cardId: 'card-42',
        rating: 2,
        now: expect.any(Date),
      }),
    )
  })

  // -----------------------------------------------------------------------
  // throw → ok:false 変換
  // -----------------------------------------------------------------------
  it('submitReviewTx が throw → { ok: false, error: "カードが見つかりません" }', async () => {
    mockSubmitReviewTx.mockRejectedValueOnce(new Error('card not found'))
    const { submitReview } = await importAction()
    const r = await submitReview('card-x', 3)
    expect(r).toEqual({ ok: false, error: 'カードが見つかりません' })
  })

  it('db.transaction が throw しても ok:false に変換される', async () => {
    dbTransactionSpy.mockRejectedValueOnce(new Error('db error'))
    const { submitReview } = await importAction()
    const r = await submitReview('card-1', 3)
    expect(r).toEqual({ ok: false, error: 'カードが見つかりません' })
  })
})
