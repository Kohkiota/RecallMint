// @vitest-environment jsdom
// ExamDetailView の unit test (Grid-1 T4)。
// - 5 case: saved prefs なし → default 'card' / saved 'table' → useEffect 後 'table' /
//   saved 不正値 → 'card' fallback / toggle click → setJsonSyncMeta が呼ばれる /
//   view 別 render (InlineCardList stub / ExamCardTable stub)。
// - InlineCardList は vi.mock で軽量 stub に差し替え (useLiveQuery 依存の肥大化を回避。
//   本 test は ExamDetailView の責務を検証するため stub mock が妥当)。
// - ExamCardTable も vi.mock で軽量 stub に差し替え (同方針)。
// - setJsonSyncMeta は vi.mock で部分 mock + spy (ESM named export の spy 確実化)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { getClientDb } from '@/lib/client-db'
import {
  SYNC_META_KEYS,
  examViewPrefsV1Schema,
  setJsonSyncMeta as realSetJsonSyncMeta,
} from '@/lib/sync/sync-meta'

// ---------------------------------------------------------------------------
// モック: InlineCardList — 軽量 stub で useLiveQuery 依存を回避
// ---------------------------------------------------------------------------

vi.mock('./inline-card-list', () => ({
  InlineCardList: ({ examId }: { examId: string }) => (
    <div data-testid="inline-card-list-stub">inline-card-list-{examId}</div>
  ),
}))

// ---------------------------------------------------------------------------
// モック: ExamCardTable — 軽量 stub で TanStack / useLiveQuery 依存を回避
// ---------------------------------------------------------------------------

vi.mock('./exam-card-table', () => ({
  ExamCardTable: ({ examId }: { examId: string }) => (
    <div data-testid="exam-card-table-stub">exam-card-table-{examId}</div>
  ),
}))

// ---------------------------------------------------------------------------
// モック: sync-meta — setJsonSyncMeta を spy しつつ実装は通す (部分 mock)
// vi.hoisted で mockSetJsonSyncMeta を巻き上げ、vi.mock ファクトリより前に宣言。
// モジュール解決後に actual 実装を impl として注入することで infinite recursion を回避。
// ---------------------------------------------------------------------------

const { mockSetJsonSyncMeta } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSetJsonSyncMeta: vi.fn<any>(),
}))

vi.mock('@/lib/sync/sync-meta', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/sync/sync-meta')>()
  // impl を actual に向けることで, spy は actual を通してから Dexie に書く
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSetJsonSyncMeta.mockImplementation(actual.setJsonSyncMeta as any)
  return {
    ...actual,
    setJsonSyncMeta: mockSetJsonSyncMeta,
  }
})

import { ExamDetailView } from './exam-detail-view'

// ---------------------------------------------------------------------------
// 共通 fixtures
// ---------------------------------------------------------------------------

const defaultProps = {
  initialCards: [],
  examId: 'exam-1',
  userId: 'user-1',
}

beforeEach(async () => {
  vi.clearAllMocks()
  const db = getClientDb()
  await db.sync_meta.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Case ①: saved prefs なし → default 'card'
// ===========================================================================

describe('ExamDetailView — Case ①: saved prefs なし → default card', () => {
  it('sync_meta 空状態で render → カード button が active、InlineCardList が render される', async () => {
    render(<ExamDetailView {...defaultProps} />)

    // useEffect 完了を waitFor で待つ
    await waitFor(() => {
      const cardBtn = screen.getByRole('button', { name: 'カード' })
      expect(cardBtn).toHaveAttribute('aria-pressed', 'true')
    })

    // テーブル button は inactive
    const tableBtn = screen.getByRole('button', { name: 'テーブル' })
    expect(tableBtn).toHaveAttribute('aria-pressed', 'false')

    // InlineCardList stub が render されている
    expect(screen.getByTestId('inline-card-list-stub')).toBeInTheDocument()

    // ExamCardTable stub は render されていない
    expect(screen.queryByTestId('exam-card-table-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ②: saved 'table' → useEffect 後 'table'
// ===========================================================================

describe('ExamDetailView — Case ②: saved table → useEffect 後 table 切替', () => {
  it('事前に exam_view_prefs = table で seed → waitFor 後に table view に切替される', async () => {
    // 事前に sync_meta に { version: 1, view: 'table' } を seed
    await realSetJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 1, view: 'table' },
      examViewPrefsV1Schema,
    )

    render(<ExamDetailView {...defaultProps} />)

    // 初期は default 'card' (SSR-style)
    const cardBtnInitial = screen.getByRole('button', { name: 'カード' })
    expect(cardBtnInitial).toHaveAttribute('aria-pressed', 'true')

    // useEffect 後に 'table' に切替
    await waitFor(() => {
      const tableBtn = screen.getByRole('button', { name: 'テーブル' })
      expect(tableBtn).toHaveAttribute('aria-pressed', 'true')
    })

    // カード button は inactive
    const cardBtn = screen.getByRole('button', { name: 'カード' })
    expect(cardBtn).toHaveAttribute('aria-pressed', 'false')

    // ExamCardTable stub が render されている
    expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()

    // InlineCardList は render されていない
    expect(screen.queryByTestId('inline-card-list-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ③: saved 不正値 → 'card' fallback
// ===========================================================================

describe('ExamDetailView — Case ③: saved 不正値 → card fallback', () => {
  it('不正 JSON を seed → getJsonSyncMeta が undefined を返し setState 走らず default card のまま', async () => {
    // Dexie 直接書込で不正値を seed (schema mismatch → getJsonSyncMeta が undefined 返し)
    const db = getClientDb()
    await db.sync_meta.put({ key: 'exam_view_prefs', value: 'broken-json-{{{' })

    render(<ExamDetailView {...defaultProps} />)

    // useEffect 完了を waitFor で待つ
    await waitFor(() => {
      const cardBtn = screen.getByRole('button', { name: 'カード' })
      // 'card' のまま (fallback)
      expect(cardBtn).toHaveAttribute('aria-pressed', 'true')
    })

    // テーブル button は inactive
    const tableBtn = screen.getByRole('button', { name: 'テーブル' })
    expect(tableBtn).toHaveAttribute('aria-pressed', 'false')

    // InlineCardList stub が render されている
    expect(screen.getByTestId('inline-card-list-stub')).toBeInTheDocument()
  })
})

// ===========================================================================
// Case ④: toggle click → setState + setJsonSyncMeta が呼ばれる
// ===========================================================================

describe('ExamDetailView — Case ④: toggle click → setState + sync_meta write', () => {
  it('テーブル button を click → view が table に切替 + setJsonSyncMeta が正しい args で呼ばれる', async () => {
    render(<ExamDetailView {...defaultProps} />)

    // useEffect 完了を waitFor (初期 prefs なし → card のまま)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // spy カウントをここでリセット (useEffect 内の write は case ④ では起きないが念のため)
    mockSetJsonSyncMeta.mockClear()

    // 「テーブル」 button を click
    const tableBtn = screen.getByRole('button', { name: 'テーブル' })
    fireEvent.click(tableBtn)

    // view が table に切替される
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーブル' })).toHaveAttribute('aria-pressed', 'true')
    })

    // setJsonSyncMeta が { version: 1, view: 'table' } で呼ばれていることを確認
    expect(mockSetJsonSyncMeta).toHaveBeenCalledTimes(1)
    expect(mockSetJsonSyncMeta).toHaveBeenCalledWith(
      SYNC_META_KEYS.examViewPrefs,
      { version: 1, view: 'table' },
      examViewPrefsV1Schema,
    )

    // ExamCardTable stub が render されている
    expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()

    // InlineCardList は unmount
    expect(screen.queryByTestId('inline-card-list-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ⑤: view 別 render (InlineCardList / ExamCardTable conditional unmount)
// ===========================================================================

describe('ExamDetailView — Case ⑤: view 別 render の conditional unmount', () => {
  it('view=card のとき InlineCardList が render され ExamCardTable は render されない', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    expect(screen.getByTestId('inline-card-list-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('exam-card-table-stub')).not.toBeInTheDocument()
  })

  it('view=table に切替後は ExamCardTable が render され InlineCardList は unmount される', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    // InlineCardList は unmount
    expect(screen.queryByTestId('inline-card-list-stub')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Case ⑥: 幅クラス — card view は max-w-4xl (capped) / table view は w-full (full-width)
// ===========================================================================

describe('ExamDetailView — Case ⑥: 幅クラス (Edit-1 T2)', () => {
  it('default card view: InlineCardList の親要素が max-w-4xl を持つ', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    const stub = screen.getByTestId('inline-card-list-stub')
    const wrapper = stub.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain('max-w-4xl')
  })

  it('table view に切替後: ExamCardTable の親要素が w-full を持ち max-w-4xl を持たない', async () => {
    render(<ExamDetailView {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カード' })).toHaveAttribute('aria-pressed', 'true')
    })

    // table に切替
    fireEvent.click(screen.getByRole('button', { name: 'テーブル' }))

    await waitFor(() => {
      expect(screen.getByTestId('exam-card-table-stub')).toBeInTheDocument()
    })

    const stub = screen.getByTestId('exam-card-table-stub')
    const wrapper = stub.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain('w-full')
    expect(wrapper!.className).not.toContain('max-w-4xl')
  })
})
