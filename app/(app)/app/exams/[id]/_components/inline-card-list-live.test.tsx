// @vitest-environment jsdom
// Task 4.1: InlineCardList が cards 表示 source を Dexie cards mirror の
// useLiveQuery 直読みに切替えた挙動の test。
//
// 検証観点:
// - live 反映: Dexie mirror を seed → render で表示、 mirror を put 変更 → UI 追従
// - exam filter: 別 exam_id の card は除外
// - owner-scope: 別 user_id の card は除外
// - sort: server (sort_key ASC NULLS LAST → created_at ASC) と一致
// - SSR / 初期 fallback: useLiveQuery が undefined の間は initialCards を表示し、
//   resolve 後は Dexie mirror が単一の真実 (initialCards に在って mirror に無い
//   card は resolve 後に消える = length===0 永続 fallback でないことの証明)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import type { ExamDetailCard } from '@/lib/exams/list'

// 本 test は表示 source (Dexie mirror live-read) のみ検証、 編集経路は別 test で
// 網羅。 InlineCardList とその子は server action / pull / next/navigation を
// 一切 import しないため (Task 4.x local-first cutover 済)、 mock は不要。

import { InlineCardList } from './inline-card-list'

function fakeClientCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'タイトル',
    sort_key: null,
    question_text: '問題文',
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

describe('InlineCardList Dexie live-read (Task 4.1)', () => {
  it('mirror を seed → title / 問題文 が表示される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({
        id: 'c1',
        title: '問1',
        question_text: '問題文 1',
        sort_key: '001',
      }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('問1')).toBeInTheDocument()
      expect(screen.getByText('問題文 1')).toBeInTheDocument()
    })
  })

  it('mirror の変化が live 反映される (put で title 変更 → UI 追従)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', title: '旧タイトル', question_text: 'Q1' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('旧タイトル')).toBeInTheDocument()
    })
    await act(async () => {
      await getClientDb().cards.put(
        fakeClientCard({ id: 'c1', title: '新タイトル', question_text: 'Q1' }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText('新タイトル')).toBeInTheDocument()
    })
    expect(screen.queryByText('旧タイトル')).not.toBeInTheDocument()
  })

  it('exam filter: 別 exam_id の card は除外される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', exam_id: 'exam-1', title: '対象 card' }),
      fakeClientCard({ id: 'c2', exam_id: 'exam-OTHER', title: '別試験 card' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('対象 card')).toBeInTheDocument()
    })
    expect(screen.queryByText('別試験 card')).not.toBeInTheDocument()
  })

  it('owner-scope: 別 user_id の card は除外される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'c1', user_id: 'user-1', title: '自分の card' }),
      fakeClientCard({ id: 'c2', user_id: 'user-OTHER', title: '他人の card' }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('自分の card')).toBeInTheDocument()
    })
    expect(screen.queryByText('他人の card')).not.toBeInTheDocument()
  })

  it('sort: sort_key ASC NULLS LAST → created_at ASC で server と一致', async () => {
    // 期待順: sort_key='001'(b) → sort_key='002'(a) → sort_key=null は末尾、
    //         null 同士は created_at ASC で d → c
    await getClientDb().cards.bulkPut([
      fakeClientCard({
        id: 'a',
        sort_key: '002',
        title: 'A',
        created_at: '2026-04-01T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'b',
        sort_key: '001',
        title: 'B',
        created_at: '2026-04-01T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'c',
        sort_key: null,
        title: 'C',
        created_at: '2026-04-05T00:00:00.000Z',
      }),
      fakeClientCard({
        id: 'd',
        sort_key: null,
        title: 'D',
        created_at: '2026-04-03T00:00:00.000Z',
      }),
    ])
    render(
      <InlineCardList initialCards={[]} examId="exam-1" userId="user-1" />,
    )
    await waitFor(() => {
      expect(screen.getByText('A')).toBeInTheDocument()
    })
    // title cell は aria-label「タイトル 編集」 の button。 DOM 出現順を取り出す。
    const titleCells = screen.getAllByRole('button', { name: 'タイトル 編集' })
    const order = titleCells.map((el) => el.textContent)
    expect(order).toEqual(['B', 'A', 'D', 'C'])
  })

  it('SSR/初期 fallback: useLiveQuery undefined の間は initialCards を表示', () => {
    // render 同期直後 (microtask 未消化) は useLiveQuery が undefined。 この瞬間に
    // initialCards が描画される。
    const initialCards: ExamDetailCard[] = [
      {
        id: 'ssr-1',
        title: 'SSR タイトル',
        sortKey: '001',
        questionText: 'SSR 問題文',
        options: [],
        explanationText: null,
        memo: null,
      },
    ]
    render(
      <InlineCardList
        initialCards={initialCards}
        examId="exam-1"
        userId="user-1"
      />,
    )
    // 同期直後: live query 未解決のため initialCards が見える
    expect(screen.getByText('SSR タイトル')).toBeInTheDocument()
  })

  it('resolve 後は Dexie が単一の真実: initialCards に在り mirror に無い card は消える', async () => {
    // mirror は空。 initialCards に 1 件。 resolve 後 mirror=[] を信頼するため、
    // length===0 でも server fallback せず、 initialCards の card は消える。
    const initialCards: ExamDetailCard[] = [
      {
        id: 'stale-1',
        title: 'server 残存 card',
        sortKey: null,
        questionText: 'Q',
        options: [],
        explanationText: null,
        memo: null,
      },
    ]
    render(
      <InlineCardList
        initialCards={initialCards}
        examId="exam-1"
        userId="user-1"
      />,
    )
    // 初期は表示
    expect(screen.getByText('server 残存 card')).toBeInTheDocument()
    // mirror 空が resolve すると消える (永続 fallback でないことの証明)
    await waitFor(() => {
      expect(screen.queryByText('server 残存 card')).not.toBeInTheDocument()
    })
    // 0 件 empty-state hint が出る
    expect(screen.getByText(/まだカードがありません/)).toBeInTheDocument()
  })
})
