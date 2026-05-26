// @vitest-environment jsdom
// DashboardActions client component tests (S-perf-3 で IDB 化、 fake-indexeddb seed
// 形式に書き換え)。
//
// 検証観点:
// - props 不要 (userId のみ)、 dueCount は Dexie cards から useLiveQuery で算出
// - 未 pull (Dexie 空 → undefined / 0 件) の境界
// - mount 直後の skeleton (layout shift 防止)
// - tenant 分離 (他 user の cards は混入しない)
// - due 判定は `card.due <= now` (ISO8601 lexicographic compare)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

import { DashboardActions } from './dashboard-actions'

function fakeCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'Q',
    sort_key: null,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    custom_props: {},
    tags: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-04-22T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

beforeEach(async () => {
  await getClientDb().cards.clear()
})

afterEach(() => {
  cleanup()
})

describe('DashboardActions (Dexie)', () => {
  it('Dexie 空 (mount 直後): スマート復習 link 不在 + 復習完了！ で render 安定する', async () => {
    render(<DashboardActions userId="user-1" />)
    // useLiveQuery は undefined → 数値確定までは skeleton。 fake-indexeddb の
    // microtask 経過後、 空 collection → 0 件 → 復習完了！ に落ち着く。
    await waitFor(() => {
      expect(screen.getByText('復習完了！')).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('link', { name: /スマート復習/ }),
    ).not.toBeInTheDocument()
  })

  it('due card 3 件: スマート復習 link が href=/app/study/smart で件数を表示', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'a', due: '2026-04-21T00:00:00.000Z' }),
      fakeCard({ id: 'b', due: '2026-04-22T00:00:00.000Z' }),
      fakeCard({ id: 'c', due: '2026-04-22T00:00:00.000Z' }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveAttribute('href', '/app/study/smart')
      expect(btn).toHaveTextContent('スマート復習（3件）')
    })
  })

  it('future due (> now) の card は dueCount に含めない', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'past', due: '2026-04-20T00:00:00.000Z' }),
      fakeCard({ id: 'future', due: '2026-05-01T00:00:00.000Z' }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveTextContent('スマート復習（1件）')
    })
  })

  it('他 user の cards は dueCount に含めない (tenant 分離)', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({
        id: 'mine',
        user_id: 'user-1',
        due: '2026-04-20T00:00:00.000Z',
      }),
      fakeCard({
        id: 'theirs',
        user_id: 'other-user',
        due: '2026-04-20T00:00:00.000Z',
      }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveTextContent('スマート復習（1件）')
    })
  })

  it('右 button は「カスタム演習（準備中）」 label で常に disabled', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ due: '2026-04-20T00:00:00.000Z' }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    // dueCount 確定を待つ (右 button は常時 disabled だが、 await で render 確定後の
    // 状態を verify する)
    await waitFor(() => {
      expect(
        screen.queryByText('読み込み中', { exact: false }),
      ).not.toBeInTheDocument()
    })
    const btn = screen.getByRole('button', { name: 'カスタム演習（準備中）' })
    expect(btn).toBeDisabled()
  })

  it('useLiveQuery 結果未確定 (undefined) の瞬間は skeleton (aria-busy) を出す', () => {
    // mount 直後 1 tick 以内: useLiveQuery は undefined を返す
    render(<DashboardActions userId="user-1" />)
    expect(screen.getByRole('status', { name: /読み込み中/ })).toBeInTheDocument()
  })

  it('旧「問題演習」link は存在しない', async () => {
    render(<DashboardActions userId="user-1" />)
    await waitFor(() => {
      expect(screen.getByText('復習完了！')).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('link', { name: '問題演習' }),
    ).not.toBeInTheDocument()
  })
})
