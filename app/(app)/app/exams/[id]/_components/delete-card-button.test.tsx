// @vitest-environment jsdom
// delete-card-button.tsx の test (Task 4.3 local-first cutover 後)。
// 削除確定で mirror から card を remove + outbox enqueue (op='delete') + 即時 drain。
// 失敗時は error フェーズに遷移し enqueue / drain しない。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock、 mirror remove は
// fake-indexeddb の実 Dexie で assert する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { DeleteCardButton } from './delete-card-button'

const CARD_ID = '11111111-1111-4111-8111-111111111111'

function makeCard(id: string): ClientCard {
  return {
    id,
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 't',
    sort_key: '1',
    question_text: 'q',
    options: [{ id: '1', text: 'o', is_correct: false }],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    custom_props: {},
    tags: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-01-01T00:00:00.000Z',
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sync_status: 'synced',
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  await getClientDb().cards.clear()
})

afterEach(() => {
  cleanup()
})

describe('DeleteCardButton', () => {
  it('削除確定 → mirror から card を remove + enqueue(delete) + drain', async () => {
    await getClientDb().cards.put(makeCard(CARD_ID))
    render(<DeleteCardButton cardId={CARD_ID} />)

    // idle → confirm → 削除実行
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    // mirror から消える (楽観反映)
    await waitFor(async () => {
      expect(await getClientDb().cards.get(CARD_ID)).toBeUndefined()
    })
    // outbox に delete mutation を enqueue
    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'delete',
        patch: {},
      })
    })
    // 即時 drain
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('confirm フロー: キャンセルで idle に戻る', async () => {
    render(<DeleteCardButton cardId={CARD_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }))
    expect(await screen.findByRole('button', { name: '削除' })).toBeInTheDocument()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('最後の 1 枚でも削除を許容する (guard なし)', async () => {
    // mirror に 1 枚だけ
    await getClientDb().cards.put(makeCard(CARD_ID))
    render(<DeleteCardButton cardId={CARD_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    await waitFor(async () => {
      expect(await getClientDb().cards.get(CARD_ID)).toBeUndefined()
    })
    expect(mockEnqueue).toHaveBeenCalled()
  })

  it('mirror remove が throw → error フェーズ、 enqueue / drain しない', async () => {
    const spy = vi
      .spyOn(getClientDb().cards, 'delete')
      .mockRejectedValueOnce(new Error('boom'))
    render(<DeleteCardButton cardId={CARD_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getByText('カードの削除に失敗しました。')).toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
