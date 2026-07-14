// @vitest-environment jsdom
// delete-card-button.tsx の test (Task 4.3 local-first cutover 後 / W3: ローカル Cache
// blob 掃除配線後)。
// 削除確定で mirror から card を remove + outbox enqueue (op='delete') + 即時 drain。
// 失敗時は error フェーズに遷移し enqueue / drain しない。
// 削除前に card.images の UUID key を収集し、 削除後に reclaimLocalAssetBlobs を
// best-effort fire-and-forget で呼ぶ (spec §4.7)。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush / reclaimLocalAssetBlobs は
// spy mock、 mirror remove は fake-indexeddb の実 Dexie で assert する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'

const { mockEnqueue, mockFlush, mockReclaimLocalAssetBlobs } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  mockReclaimLocalAssetBlobs: vi.fn(async () => undefined),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))
vi.mock('@/lib/media/reclaim-local-asset-blobs', () => ({
  reclaimLocalAssetBlobs: mockReclaimLocalAssetBlobs,
}))

import { DeleteCardButton } from './delete-card-button'

const CARD_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = 'user-1'
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LEGACY_KEY = 'img-1'

function makeCard(id: string, images: ClientCard['images'] = []): ClientCard {
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
    images,
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
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)

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
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }))
    expect(await screen.findByRole('button', { name: '削除' })).toBeInTheDocument()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('最後の 1 枚でも削除を許容する (guard なし)', async () => {
    // mirror に 1 枚だけ
    await getClientDb().cards.put(makeCard(CARD_ID))
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
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
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getByText('カードの削除に失敗しました。')).toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    expect(mockReclaimLocalAssetBlobs).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('削除前に card.images の UUID key を収集し、 削除後に reclaimLocalAssetBlobs を呼ぶ(spec §4.7)', async () => {
    await getClientDb().cards.put(
      makeCard(CARD_ID, [
        { key: UUID_A, target: 'question_text', alt: '' },
        { key: LEGACY_KEY, target: 'question_text', alt: '' },
        { key: UUID_B, target: 'option:1', alt: '' },
      ]),
    )
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(async () => {
      expect(await getClientDb().cards.get(CARD_ID)).toBeUndefined()
    })
    // legacy (非 UUID) key は掃除対象外(isAssetKey フィルタ)。 UUID key のみ渡す。
    await waitFor(() => {
      expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith(USER_ID, [UUID_A, UUID_B])
    })
  })

  it('card.images が空でも reclaimLocalAssetBlobs を空配列 keys で呼ぶ(no-op は helper 側)', async () => {
    await getClientDb().cards.put(makeCard(CARD_ID, []))
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(async () => {
      expect(await getClientDb().cards.get(CARD_ID)).toBeUndefined()
    })
    await waitFor(() => {
      expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith(USER_ID, [])
    })
  })

  it('削除前 pre-read (cards.get) が reject → error フェーズ、 enqueue / drain / reclaim しない', async () => {
    // key 収集の pre-read が try 外にあると、 read reject が delete の error UI をバイパスし
    // deleting phase に固着する。 pre-read を try 内に置くことで既存 error 経路に集約する。
    await getClientDb().cards.put(makeCard(CARD_ID, []))
    const spy = vi
      .spyOn(getClientDb().cards, 'get')
      .mockRejectedValueOnce(new Error('idb read boom'))
    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))
    await waitFor(() => {
      expect(screen.getByText('カードの削除に失敗しました。')).toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    expect(mockReclaimLocalAssetBlobs).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('stale mirror で images が非配列でも key 収集で throw せず削除は成立し reclaim を空配列で呼ぶ', async () => {
    // 旧 schema / 破損 row 想定: images が array でない (Array.isArray 防御)。 `?? []` は
    // null/undefined しか救わないため、 非配列で .filter が throw して削除が deleting phase
    // に固着する regression を防ぐ。
    const staleCard = makeCard(CARD_ID, [])
    ;(staleCard as unknown as { images: unknown }).images = 'corrupt'
    await getClientDb().cards.put(staleCard)

    render(<DeleteCardButton cardId={CARD_ID} userId={USER_ID} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    // 削除は成立する (deleting phase に固着しない)。
    await waitFor(async () => {
      expect(await getClientDb().cards.get(CARD_ID)).toBeUndefined()
    })
    await waitFor(() => {
      expect(mockReclaimLocalAssetBlobs).toHaveBeenCalledWith(USER_ID, [])
    })
  })
})
