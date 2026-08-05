// @vitest-environment jsdom
// ②-4a 単一 invocation Sprint Task S-3(canonical review I-1): result page が
// `source_documents.status` で成功 / 失敗を出し分けることの pin。
//
// 背景: 新経路の `submitUpload` は pipeline の成否を呼出側に返さない(失敗も server 側で
// 終端化する契約)ため、client は結果を知らずにこの page へ遷移する。ここで status を
// 見ないと、Gemini 失敗 / publish 失敗などの全失敗クラスが「✅ 0 問を抽出しました」と
// いう緑の成功パネルとして出る(silent failure・spec §4.4 違反)。
//
// page は server component(async function)。 auth + tenant tx + 2 query を mock し、
// `await Page()` の JSX を render する(study/smart/page.test.tsx と同じ方式)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const {
  mockGetCurrentUser,
  mockGetSourceDocumentForUser,
  mockGetCardsForSourceDocument,
  mockNotFound,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockGetSourceDocumentForUser: vi.fn(),
  mockGetCardsForSourceDocument: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
vi.mock('next/navigation', () => ({ notFound: mockNotFound }))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
}))
vi.mock('@/lib/exams/list', () => ({
  getSourceDocumentForUser: mockGetSourceDocumentForUser,
  getCardsForSourceDocument: mockGetCardsForSourceDocument,
}))

import UploadResultPage from './page'

const USER = { id: 'user-1' }

function params(id = 'doc-1') {
  return Promise.resolve({ sourceDocumentId: id })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentUser.mockResolvedValue(USER)
  mockGetCardsForSourceDocument.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe('UploadResultPage — source_documents.status で成功 / 失敗を出し分ける', () => {
  it("status='failed' はエラー表示(緑の成功パネルを出さない)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'failed',
    })

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/問題を抽出できませんでした/)).toBeInTheDocument()
    // 「N 問を抽出しました」「保存されました」は出さない — 失敗を成功として見せない。
    expect(screen.queryByText(/問を抽出しました/)).not.toBeInTheDocument()
    expect(screen.queryByText(/に保存されました/)).not.toBeInTheDocument()
    // 遷移先(試験一覧)は失敗時も出すが、失敗直後に「保存して」は齟齬ゆえ出さない。
    const link = screen.getByRole('link', { name: /試験一覧/ })
    expect(link).toBeInTheDocument()
    expect(link.textContent).not.toContain('保存して')
  })

  // `failed` だけを弾く形にすると processing が「✅ 0 問を抽出しました」になる。
  // S-4(after() + poll)では processing が常態になるためクラスごと閉じる。
  it("status='processing' も緑の成功パネルを出さない(まだ処理中の案内)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'processing',
    })

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/まだ処理中です/)).toBeInTheDocument()
    expect(screen.queryByText(/問を抽出しました/)).not.toBeInTheDocument()
    expect(screen.queryByText(/に保存されました/)).not.toBeInTheDocument()
    // 失敗と処理中は別の文言(中断案内を処理中に出さない)。
    expect(screen.queryByText(/問題を抽出できませんでした/)).not.toBeInTheDocument()
    // 公開文言の規律: 待ち時間の数値を出さない / 試験の削除を案内しない。
    const alertText = screen.getByRole('alert').textContent ?? ''
    expect(alertText).not.toMatch(/\d+\s*(分|秒|時間)/)
    expect(alertText).not.toContain('削除')
  })

  it("status='completed' は従来どおり成功表示(件数 + 保存先 exam 名)", async () => {
    mockGetSourceDocumentForUser.mockResolvedValue({
      id: 'doc-1',
      examName: 'テスト試験',
      status: 'completed',
    })
    mockGetCardsForSourceDocument.mockResolvedValue([
      { id: 'c1', title: '問 1', questionTextSnippet: '設問', optionCount: 4 },
      { id: 'c2', title: '問 2', questionTextSnippet: '設問', optionCount: 2 },
    ])

    render(await UploadResultPage({ params: params() }))

    expect(screen.getByText(/2 問を抽出しました/)).toBeInTheDocument()
    expect(screen.getByText(/に保存されました/)).toBeInTheDocument()
    expect(screen.queryByText(/問題を抽出できませんでした/)).not.toBeInTheDocument()
  })

  it('doc が見つからなければ notFound()(owner scope 外 / 削除済み)', async () => {
    mockGetSourceDocumentForUser.mockResolvedValue(null)

    await expect(UploadResultPage({ params: params() })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mockGetCardsForSourceDocument).not.toHaveBeenCalled()
  })
})
