// @vitest-environment jsdom
// P3 Task0 ④: cross-component 統合 flow (edit → mirror + outbox → flush)。
//
// 目的: InlineCardList を実 tree で render し、 InlineTextField (title) を編集 → blur すると
//   (1) 実 Dexie cards mirror に新値が反映される
//   (2) outbox (entity_mutations) に op='update_field' の patch が enqueue される
//   (3) mock BulkApiClient で flush を明示駆動すると、 その mutation が client に POST され synced 化する
// を 1 本で pin する。 P3 の移設で「編集 → mirror → outbox → flush」 の end-to-end 配線が
// silent に壊れないための回帰網。
//
// 実 infra の組み合わせ (新規発明しない):
//   - fake-indexeddb + useLiveQuery live-run  (exam-card-table.test.tsx)
//   - 実 Dexie mirror write + assert          (inline-text-field.test.tsx)
//   - BulkApiClient injection mock            (entity-mutation-flush.test.ts)
//
// flake 対策 (Codex 指摘): REAL timers + waitFor/vi.waitFor で待機、 beforeEach で Dexie clear、
//   flush は drain timer を待たず flushAllPendingEntityMutations(mockClient) を明示 call し、
//   mock client の記録内容で assert する。 InlineTextField の debounce drain
//   (runGuardedEntityMutationFlush) は inert 化し、 実 flush は本 test が駆動する。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import {
  flushAllPendingEntityMutations,
  getPendingEntityMutations,
  inFlightMutationIds,
} from '@/lib/sync/entity-mutations'
import type { BulkApiClient } from '@/lib/sync/review-events'

// InlineTextField の 500ms debounce drain を inert 化する (実 flush は本 test が mock client で
// 明示駆動 = drain timer を待たない)。 enqueueEntityMutation は実装のまま (実 outbox 書込を検証)。
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: vi.fn(async () => 'no-pending' as const),
}))

import { InlineCardList } from '@/app/(app)/app/exams/[id]/_components/inline-card-list'

const EXAM_ID = 'exam-int-1'
const USER_ID = 'user-int-1'
const CARD_ID = 'card-int-1'

function fakeClientCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: CARD_ID,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    source_document_id: null,
    title: '旧タイトル',
    sort_key: null,
    question_text: '問題文',
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

// entity-mutation-flush.test.ts と同方式の BulkApiClient injection mock。
function makeMockClient(
  response: Awaited<ReturnType<BulkApiClient['post']>>,
): BulkApiClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    post: async (payload) => {
      calls.push(payload)
      return response
    },
  }
}

beforeEach(async () => {
  // real timers + 前 test の未 settle transaction を drain してから mock を clear。
  vi.useRealTimers()
  const db = getClientDb()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
  inFlightMutationIds.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('P3 Task0 ④: exam card edit flow — 編集 → mirror + outbox → flush', () => {
  it('title を編集 → blur で 実 Dexie mirror + outbox に反映され、 mock BulkApiClient flush で synced 化する', async () => {
    await getClientDb().cards.put(fakeClientCard({ title: '旧タイトル' }))

    render(<InlineCardList initialCards={[]} examId={EXAM_ID} userId={USER_ID} />)

    // live-run: mirror から title cell が描画されるまで待つ。
    const titleField = await screen.findByRole('button', { name: 'タイトル 編集' })
    expect(titleField).toHaveTextContent('旧タイトル')

    // 編集 → 値変更 → blur (commit)。
    fireEvent.click(titleField)
    const input = screen.getByRole('textbox', { name: 'タイトル 編集' })
    fireEvent.change(input, { target: { value: '新タイトル' } })
    fireEvent.blur(input)

    // (1) 実 Dexie cards mirror に新値が反映される。
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.title).toBe('新タイトル')
    })

    // (2) outbox (entity_mutations) に update_field patch が enqueue される。
    let pending: Awaited<ReturnType<typeof getPendingEntityMutations>> = []
    await vi.waitFor(async () => {
      pending = await getPendingEntityMutations()
      expect(pending).toHaveLength(1)
    })
    const mutation = pending[0]
    expect(mutation.entity_type).toBe('card')
    expect(mutation.entity_id).toBe(CARD_ID)
    expect(mutation.op).toBe('update_field')
    expect(mutation.patch).toEqual({ field: 'title', value: '新タイトル' })

    // (3) mock BulkApiClient で flush を明示駆動 (drain timer は待たない)。
    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)

    // mock client に mutation が POST された (記録内容で assert)。
    expect(client.calls).toHaveLength(1)
    const payload = client.calls[0] as {
      mutations: Array<{
        mutation_id: string
        entity_id: string
        op: string
        patch: Record<string, unknown>
      }>
    }
    expect(payload.mutations).toHaveLength(1)
    expect(payload.mutations[0].mutation_id).toBe(mutation.mutation_id)
    expect(payload.mutations[0].entity_id).toBe(CARD_ID)
    expect(payload.mutations[0].op).toBe('update_field')
    expect(payload.mutations[0].patch).toEqual({ field: 'title', value: '新タイトル' })

    // flush 結果: 当該 mutation が synced 化し pending が 0 になる。
    expect(results).toHaveLength(1)
    expect(results[0].syncedEventIds).toContain(mutation.mutation_id)
    expect(await getPendingEntityMutations()).toHaveLength(0)
  })
})
