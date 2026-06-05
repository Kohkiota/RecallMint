// @vitest-environment jsdom
// ExamListLive client component tests — Dexie mirror (useLiveQuery) 参照の
// 試験一覧 component 検証。
//
// 検証観点:
// 1. active exam が card_count 付きで表示される (Dexie cards から動的集計)
// 2. archived exam は除外される
// 3. updated_at DESC 順で表示される
// 4. active exam 0 件 → 空状態 CTA 表示
// 5. mount 直後は skeleton (role="status") が出て、waitFor 後に list に変わる

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { getClientDb, type ClientExam, type ClientCard } from '@/lib/client-db'

// next/link の mock (DashboardActions test と同パターン)
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

// next/navigation mock (DeleteExamButton → useRouter が必要)
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// DeleteExamButton 内の deleteExam server action を mock
// (server action は client test 環境で動かせないため)
vi.mock('@/app/(app)/app/exams/_actions/delete-exam', () => ({
  deleteExam: vi.fn().mockResolvedValue({ ok: true }),
}))

// ExamStatusProvider / ExamStatusBadge の useRouter も mock 済のため OK
// ExamStatusContext polling の fetch は test 内では実行されない
// (initialStatuses={} でバッジなし → polling 不要 branch に入る)

import { ExamListLive } from './exam-list-live'
import { ExamStatusProvider } from '../../_components/exam-status-live'

// fetch mock (ExamStatusProvider の polling が万一走っても失敗しないよう)
global.fetch = vi.fn().mockResolvedValue({
  ok: false,
  json: async () => ({}),
})

function fakeExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: 'user-1',
    name: 'テスト試験',
    archived_at: null,
    card_count: 0,
    content_version: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-10T00:00:00.000Z',
    ...overrides,
  }
}

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

// ExamListLive を ExamStatusProvider で wrap して render するヘルパー
// (ExamStatusBadge が ExamStatusContext を購読するため)
function renderWithProvider(userId: string) {
  return render(
    <ExamStatusProvider initialStatuses={{}}>
      <ExamListLive userId={userId} />
    </ExamStatusProvider>,
  )
}

beforeEach(async () => {
  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
})

afterEach(() => {
  cleanup()
})

describe('ExamListLive (Dexie useLiveQuery)', () => {
  it('1. active exam を card_count 付きで表示 (Dexie cards から動的集計)', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([
      fakeExam({ id: 'exam-1', name: '試験 A', updated_at: '2026-04-10T00:00:00.000Z' }),
      fakeExam({ id: 'exam-2', name: '試験 B', updated_at: '2026-04-09T00:00:00.000Z' }),
    ])
    // exam-1 に 3 枚、exam-2 に 1 枚
    await db.cards.bulkPut([
      fakeCard({ id: 'c1', exam_id: 'exam-1' }),
      fakeCard({ id: 'c2', exam_id: 'exam-1' }),
      fakeCard({ id: 'c3', exam_id: 'exam-1' }),
      fakeCard({ id: 'c4', exam_id: 'exam-2' }),
    ])

    renderWithProvider('user-1')

    await waitFor(() => {
      expect(screen.getByText('試験 A')).toBeInTheDocument()
      expect(screen.getByText('試験 B')).toBeInTheDocument()
    })

    // card_count は Dexie cards から動的集計
    expect(screen.getByText(/カード 3 件/)).toBeInTheDocument()
    expect(screen.getByText(/カード 1 件/)).toBeInTheDocument()
  })

  it('2. archived exam は除外される', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([
      fakeExam({ id: 'active', name: 'アクティブ試験', archived_at: null }),
      fakeExam({ id: 'archived', name: 'アーカイブ試験', archived_at: '2026-03-01T00:00:00.000Z' }),
    ])

    renderWithProvider('user-1')

    await waitFor(() => {
      expect(screen.getByText('アクティブ試験')).toBeInTheDocument()
    })
    expect(screen.queryByText('アーカイブ試験')).not.toBeInTheDocument()
  })

  it('3. updated_at DESC 順で表示される', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([
      fakeExam({ id: 'exam-old', name: '古い試験', updated_at: '2026-04-01T00:00:00.000Z' }),
      fakeExam({ id: 'exam-new', name: '新しい試験', updated_at: '2026-04-20T00:00:00.000Z' }),
      fakeExam({ id: 'exam-mid', name: '中間試験', updated_at: '2026-04-10T00:00:00.000Z' }),
    ])

    renderWithProvider('user-1')

    await waitFor(() => {
      expect(screen.getByText('新しい試験')).toBeInTheDocument()
    })

    const items = screen.getAllByRole('listitem')
    const texts = items.map((el) => el.textContent ?? '')
    const newIdx = texts.findIndex((t) => t.includes('新しい試験'))
    const midIdx = texts.findIndex((t) => t.includes('中間試験'))
    const oldIdx = texts.findIndex((t) => t.includes('古い試験'))
    expect(newIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(oldIdx)
  })

  it('4. active exam 0 件 → 空状態 CTA 表示', async () => {
    // archived のみ存在 → active は 0 件
    const db = getClientDb()
    await db.exams.bulkPut([
      fakeExam({ id: 'archived', name: 'アーカイブ', archived_at: '2026-03-01T00:00:00.000Z' }),
    ])

    renderWithProvider('user-1')

    await waitFor(() => {
      expect(screen.getByText('まだ試験がありません。')).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'アップロードから始める' })).toBeInTheDocument()
  })

  it('5. mount 直後は skeleton (role="status") が出て、waitFor 後に list に変わる', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([
      fakeExam({ id: 'exam-1', name: 'テスト試験' }),
    ])

    renderWithProvider('user-1')

    // mount 直後: useLiveQuery は undefined → skeleton
    expect(screen.getByRole('status', { name: /読み込み中/ })).toBeInTheDocument()

    // Dexie 解決後: list が表示される
    await waitFor(() => {
      expect(screen.getByText('テスト試験')).toBeInTheDocument()
    })
    expect(screen.queryByRole('status', { name: /読み込み中/ })).not.toBeInTheDocument()
  })

  it('6. owner 分離: 他 user の exam/card は表示・件数に混入しない (CLAUDE.md 必須ガード)', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([
      // 自 user の exam。 server 非正規化列 card_count は意図的に誤値 (99) を入れ、
      // component が exams.card_count を読まず cards mirror から集計することを証明する。
      fakeExam({ id: 'mine', user_id: 'user-1', name: '自分の試験', card_count: 99 }),
      fakeExam({ id: 'theirs', user_id: 'user-2', name: '他人の試験' }),
    ])
    await db.cards.bulkPut([
      fakeCard({ id: 'mc1', user_id: 'user-1', exam_id: 'mine' }),
      fakeCard({ id: 'mc2', user_id: 'user-1', exam_id: 'mine' }),
      // 他 user の card は同 exam_id を持っても自 user の件数に混入してはならない。
      fakeCard({ id: 'tc1', user_id: 'user-2', exam_id: 'mine' }),
      fakeCard({ id: 'tc2', user_id: 'user-2', exam_id: 'theirs' }),
    ])

    renderWithProvider('user-1')

    await waitFor(() => {
      expect(screen.getByText('自分の試験')).toBeInTheDocument()
    })
    // 他 user の exam は出ない
    expect(screen.queryByText('他人の試験')).not.toBeInTheDocument()
    // card_count は cards mirror の自 user 分のみ (2 件)。exams.card_count=99 でも
    // 他 user card (tc1) でもなく、 user-1 の mc1/mc2 = 2 件。
    expect(screen.getByText(/カード 2 件/)).toBeInTheDocument()
    expect(screen.queryByText(/カード 99 件/)).not.toBeInTheDocument()
    expect(screen.queryByText(/カード 3 件/)).not.toBeInTheDocument()
  })
})
