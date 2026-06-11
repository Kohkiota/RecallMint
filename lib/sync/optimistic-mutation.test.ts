// optimistic-mutation helper の test。 fake-indexeddb 経由で実 Dexie を動かし、
// `runOptimisticMutation` / `runOptimisticCreate` の atomic 性契約 (tx 内 enqueue throw
// → Dexie auto-rollback → silent or rethrow) と userId fail-fast を verify する。
//
// 既存 sync test pattern: `lib/sync/entity-mutations.test.ts` /
// `lib/sync/entity-mutation-flush.test.ts` に合わせ、 beforeEach で関連 store を全 clear。

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { getPendingEntityMutations, newId } from './entity-mutations'
import {
  runOptimisticMutation,
  runOptimisticCreate,
} from './optimistic-mutation'
import { logger } from '@/lib/logger'

const TEST_USER_ID = 'user-1'
const TEST_EXAM_ID = 'exam-1'

// 各 test の前に関連 store を全 clear。 fake-indexeddb は process 越しに state を持つので
// .clear() で isolation を保つ。
beforeEach(async () => {
  const db = getClientDb()
  await db.entity_mutations.clear()
  await db.cards.clear()
  await db.card_tags.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ClientCard 1 件を最小 default で組む helper。 mirror put 用。
function makeClientCard(id: string): ClientCard {
  const now = '2026-06-12T00:00:00.000Z'
  return {
    id,
    user_id: TEST_USER_ID,
    exam_id: TEST_EXAM_ID,
    source_document_id: null,
    title: 't',
    sort_key: '1',
    question_text: 'q',
    options: [{ id: '1', text: 'o', is_correct: false }],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: now,
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
    created_at: now,
    updated_at: now,
    sync_status: 'pending',
  }
}

// ---------------------------------------------------------------------------
// 1. main path (runOptimisticMutation)
// ---------------------------------------------------------------------------

describe('runOptimisticMutation — main path', () => {
  it('1 store mirror put + 1 enqueue 成功 → mirror に row + entity_mutations に 1 行', async () => {
    const db = getClientDb()
    const cardId = newId()

    await runOptimisticMutation({
      stores: [db.cards],
      mutate: async () => {
        await db.cards.put(makeClientCard(cardId))
      },
      mutations: [
        {
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'title', value: 'New title' },
        },
      ],
      logEvent: 'test.main_path',
    })

    // mirror: card row が存在する
    const stored = await db.cards.get(cardId)
    expect(stored).toBeDefined()
    expect(stored!.id).toBe(cardId)

    // outbox: 1 行 pending
    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].entity_id).toBe(cardId)
    expect(pending[0].patch).toEqual({ field: 'title', value: 'New title' })
  })
})

// ---------------------------------------------------------------------------
// 2. silent catch (runOptimisticMutation)
// ---------------------------------------------------------------------------

describe('runOptimisticMutation — silent catch (既定 throwOnError=false)', () => {
  it('enqueue throw → tx rollback で mirror 未反映 + 例外を caller に伝播しない + logger.warn 1 回', async () => {
    const db = getClientDb()
    const cardId = newId()

    // enqueueEntityMutation の内部実装は entity_mutations.add() を呼ぶ (新規 path)。
    // .add を spy で throw させ、 tx 内 enqueue 失敗 → tx 全体 throw → Dexie auto-rollback
    // により mirror 側の put も巻き戻る挙動を verify する。
    const addSpy = vi
      .spyOn(db.entity_mutations, 'add')
      .mockRejectedValueOnce(new Error('boom-enqueue'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(
      runOptimisticMutation({
        stores: [db.cards],
        mutate: async () => {
          await db.cards.put(makeClientCard(cardId))
        },
        mutations: [
          {
            entity_type: 'card',
            entity_id: cardId,
            op: 'update_field',
            patch: { field: 'title', value: 'X' },
          },
        ],
        logEvent: 'test.silent_catch',
        logContext: { cardId },
      }),
    ).resolves.toBeUndefined()

    // mirror put は rollback
    expect(await db.cards.get(cardId)).toBeUndefined()
    // outbox にも残らない
    expect(await getPendingEntityMutations()).toHaveLength(0)

    // logger.warn が event + context + err 付きで 1 回呼ばれた
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const call = warnSpy.mock.calls[0][0] as {
      event: string
      cardId: string
      err: unknown
    }
    expect(call.event).toBe('test.silent_catch')
    expect(call.cardId).toBe(cardId)
    expect(call.err).toBeInstanceOf(Error)

    addSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 3. throwOnError rethrow (runOptimisticMutation)
// ---------------------------------------------------------------------------

describe('runOptimisticMutation — throwOnError=true で rethrow', () => {
  it('enqueue throw + throwOnError=true → caller が catch できる + logger.warn 1 回 + mirror rollback', async () => {
    const db = getClientDb()
    const cardId = newId()

    const addSpy = vi
      .spyOn(db.entity_mutations, 'add')
      .mockRejectedValueOnce(new Error('boom-rethrow'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(
      runOptimisticMutation({
        stores: [db.cards],
        mutate: async () => {
          await db.cards.put(makeClientCard(cardId))
        },
        mutations: [
          {
            entity_type: 'card',
            entity_id: cardId,
            op: 'delete',
            patch: {},
          },
        ],
        logEvent: 'test.rethrow',
        throwOnError: true,
      }),
    ).rejects.toThrow(/boom-rethrow/)

    // mirror put も rollback
    expect(await db.cards.get(cardId)).toBeUndefined()
    expect(await getPendingEntityMutations()).toHaveLength(0)
    // logger.warn は 1 回呼ばれる (rethrow 経路でも記録は残す)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    addSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 4. multi-store rollback (runOptimisticMutation)
// ---------------------------------------------------------------------------

describe('runOptimisticMutation — multi-store rollback', () => {
  it('2 store mirror write 後 enqueue throw → 両 store が rollback されて行が残らない', async () => {
    const db = getClientDb()
    const cardId = newId()
    const optionId = 'opt-1'

    const addSpy = vi
      .spyOn(db.entity_mutations, 'add')
      .mockRejectedValueOnce(new Error('boom-multi'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await runOptimisticMutation({
      stores: [db.cards, db.card_tags],
      mutate: async () => {
        await db.cards.put(makeClientCard(cardId))
        await db.card_tags.put({
          card_id: cardId,
          option_id: optionId,
          user_id: TEST_USER_ID,
          created_at: '2026-06-12T00:00:00.000Z',
        })
      },
      mutations: [
        {
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'tag_option_ids', value: [optionId] },
        },
      ],
      logEvent: 'test.multi_store',
    })

    // 両 store とも rollback で空のまま
    expect(await db.cards.get(cardId)).toBeUndefined()
    expect(await db.card_tags.get([cardId, optionId])).toBeUndefined()
    expect(await getPendingEntityMutations()).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    addSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 5. create flow (runOptimisticCreate)
// ---------------------------------------------------------------------------

describe('runOptimisticCreate — main path', () => {
  it('buildRow / buildMutation が同一 newId + nowIso を受領 → mirror 1 行 + entity_mutations 1 行 + 戻り値 id 一致', async () => {
    const db = getClientDb()
    const receivedByBuildRow: { id: string; nowIso: string }[] = []
    const receivedByBuildMutation: { id: string; nowIso: string }[] = []

    const result = await runOptimisticCreate<ClientCard>({
      userId: TEST_USER_ID,
      mirrorStore: db.cards,
      buildRow: (id, nowIso) => {
        receivedByBuildRow.push({ id, nowIso })
        const row = makeClientCard(id)
        return { ...row, created_at: nowIso, updated_at: nowIso, due: nowIso }
      },
      buildMutation: (id, nowIso) => {
        receivedByBuildMutation.push({ id, nowIso })
        return {
          entity_type: 'card',
          entity_id: id,
          op: 'create',
          patch: {
            exam_id: TEST_EXAM_ID,
            title: 'created',
          },
          edited_at: nowIso,
        }
      },
      logEvent: 'test.create_main',
    })

    // 戻り値 id が定義済 + buildRow/buildMutation 双方の受領値と一致
    expect(result.id).toBeTruthy()
    expect(receivedByBuildRow).toHaveLength(1)
    expect(receivedByBuildMutation).toHaveLength(1)
    expect(receivedByBuildRow[0].id).toBe(result.id)
    expect(receivedByBuildMutation[0].id).toBe(result.id)
    // 同一 nowIso が両者に渡る
    expect(receivedByBuildRow[0].nowIso).toBe(receivedByBuildMutation[0].nowIso)

    // mirror に 1 行
    const stored = await db.cards.get(result.id)
    expect(stored).toBeDefined()
    expect(stored!.id).toBe(result.id)

    // outbox に 1 行 (create) + edited_at が一致
    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].entity_id).toBe(result.id)
    expect(pending[0].op).toBe('create')
    expect(pending[0].edited_at).toBe(receivedByBuildMutation[0].nowIso)
  })
})

// ---------------------------------------------------------------------------
// 6. caller-provided id (runOptimisticCreate)
// ---------------------------------------------------------------------------

describe('runOptimisticCreate — caller-provided id', () => {
  it('options.id 指定で caller 採番 id がそのまま buildRow / buildMutation / 戻り値に渡る', async () => {
    // T1a smoke #4 race fix: caller 側で sync 採番 → setNewCardId(id) を await の前に
    // 発火させたい場合に使う経路。 helper 内 newId() は呼ばれず、 caller 採番 id が
    // 一貫して buildRow / buildMutation / 戻り値 / mirror 行 / outbox 行に伝播する。
    const db = getClientDb()
    const CALLER_ID = 'caller-provided-id'
    const receivedByBuildRow: { id: string; nowIso: string }[] = []
    const receivedByBuildMutation: { id: string; nowIso: string }[] = []

    const result = await runOptimisticCreate<ClientCard>({
      userId: TEST_USER_ID,
      id: CALLER_ID,
      mirrorStore: db.cards,
      buildRow: (id, nowIso) => {
        receivedByBuildRow.push({ id, nowIso })
        const row = makeClientCard(id)
        return { ...row, created_at: nowIso, updated_at: nowIso, due: nowIso }
      },
      buildMutation: (id, nowIso) => {
        receivedByBuildMutation.push({ id, nowIso })
        return {
          entity_type: 'card',
          entity_id: id,
          op: 'create',
          patch: { exam_id: TEST_EXAM_ID, title: 'created' },
          edited_at: nowIso,
        }
      },
      logEvent: 'test.create_caller_id',
    })

    // 戻り値 + buildRow / buildMutation 受領値が全て caller 採番 id と一致
    expect(result.id).toBe(CALLER_ID)
    expect(receivedByBuildRow[0].id).toBe(CALLER_ID)
    expect(receivedByBuildMutation[0].id).toBe(CALLER_ID)

    // mirror / outbox 双方の id も caller 採番 id
    const stored = await db.cards.get(CALLER_ID)
    expect(stored).toBeDefined()
    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].entity_id).toBe(CALLER_ID)
  })
})

// ---------------------------------------------------------------------------
// 7. userId='' fail-fast (runOptimisticCreate)
// ---------------------------------------------------------------------------

describe('runOptimisticCreate — userId="" fail-fast', () => {
  it('空文字 userId で Error("empty user_id") throw + tx 張らない (mirror / entity_mutations 共に書込なし)', async () => {
    const db = getClientDb()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // buildRow / buildMutation が呼ばれないことも verify (tx 自体張らない契約)
    const buildRow = vi.fn((id: string): ClientCard => makeClientCard(id))
    const buildMutation = vi.fn((id: string) => ({
      entity_type: 'card',
      entity_id: id,
      op: 'create',
      patch: {},
    }))

    await expect(
      runOptimisticCreate<ClientCard>({
        userId: '',
        mirrorStore: db.cards,
        buildRow,
        buildMutation,
        logEvent: 'test.fail_fast',
      }),
    ).rejects.toThrow(/empty user_id/)

    // console.error が呼ばれた (CC 環境への fail-fast 警告)
    expect(errorSpy).toHaveBeenCalled()
    // buildRow / buildMutation は呼ばれない (tx 自体張らない)
    expect(buildRow).not.toHaveBeenCalled()
    expect(buildMutation).not.toHaveBeenCalled()
    // mirror / outbox 双方とも書込ゼロ
    expect(await db.cards.toArray()).toHaveLength(0)
    expect(await db.entity_mutations.toArray()).toHaveLength(0)

    errorSpy.mockRestore()
  })
})
