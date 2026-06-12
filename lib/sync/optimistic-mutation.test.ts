// optimistic-mutation helper の test。 fake-indexeddb 経由で実 Dexie を動かし、
// `runOptimisticMutation` / `runOptimisticCreate` の atomic 性契約 (tx 内 enqueue throw
// → Dexie auto-rollback → silent or rethrow) と userId fail-fast を verify する。
//
// 既存 sync test pattern: `lib/sync/entity-mutations.test.ts` /
// `lib/sync/entity-mutation-flush.test.ts` に合わせ、 beforeEach で関連 store を全 clear。

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import {
  getPendingEntityMutations,
  newId,
  type EnqueueEntityMutationInput,
} from './entity-mutations'

// runGuardedEntityMutationFlush は helper 内蔵 fire-and-forget で叩かれる。 本 test では
// `skipInternalFlush` の検証で「呼ばれた / 呼ばれなかった」 を assert する必要があるため
// module 全体を mock 化 (vi.hoisted で mock 関数を先に生成、 inline-text-field.test.tsx 同形)。
// 既存 case はこの mock の影響を受けない (flush 戻り値を assert していない)。
const { mockGuardedFlush } = vi.hoisted(() => ({
  mockGuardedFlush: vi.fn(async () => 'no-pending' as const),
}))
vi.mock('./entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockGuardedFlush,
}))

import {
  runOptimisticMutation,
  runOptimisticCreate,
  runOptimisticUpdate,
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
  mockGuardedFlush.mockClear()
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
        // T5: 最小 patch shape (test 視点) を envelope union に通すため cast。
        return {
          entity_type: 'card',
          entity_id: id,
          op: 'create',
          patch: {
            exam_id: TEST_EXAM_ID,
            title: 'created',
          },
          edited_at: nowIso,
        } as unknown as EnqueueEntityMutationInput
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
        // T5: 最小 patch shape (test 視点) を envelope union に通すため cast。
        return {
          entity_type: 'card',
          entity_id: id,
          op: 'create',
          patch: { exam_id: TEST_EXAM_ID, title: 'created' },
          edited_at: nowIso,
        } as unknown as EnqueueEntityMutationInput
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
// 6.5 update path (runOptimisticUpdate) — revert 成功 / revert 失敗 silent / isNoop
// ---------------------------------------------------------------------------

describe('runOptimisticUpdate — revert 成功 (enqueue throw で auto-rollback)', () => {
  it('enqueue throw → tx auto-rollback で mirror が beforeValue に戻る + 例外伝播なし + logger.warn 1 回', async () => {
    // before 値を mirror に seed (T1b 取扱: caller が事前取得した値を beforeValue として渡す)。
    const db = getClientDb()
    const cardId = newId()
    await db.cards.put({ ...makeClientCard(cardId), title: '旧タイトル' })

    // enqueue throw 化 (= entity_mutations.add throw)。
    const addSpy = vi
      .spyOn(db.entity_mutations, 'add')
      .mockRejectedValueOnce(new Error('boom-update'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(
      runOptimisticUpdate({
        store: db.cards,
        rowKey: cardId,
        beforeValue: { title: '旧タイトル' },
        afterPatch: { title: '新タイトル' },
        mutation: {
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'title', value: '新タイトル' },
        },
        logEvent: 'test.update.revert_ok',
        logContext: { cardId },
      }),
    ).resolves.toBeUndefined()

    // tx auto-rollback で mirror title は旧値に戻っている。
    const row = await db.cards.get(cardId)
    expect(row?.title).toBe('旧タイトル')
    // outbox は未反映。
    expect(await getPendingEntityMutations()).toHaveLength(0)
    // logger.warn は 1 回 (event + context + err)。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const call = warnSpy.mock.calls[0][0] as {
      event: string
      cardId: string
      err: unknown
    }
    expect(call.event).toBe('test.update.revert_ok')
    expect(call.cardId).toBe(cardId)
    expect(call.err).toBeInstanceOf(Error)

    addSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('runOptimisticUpdate — mirror update throw → silent + auto-rollback (manual revert なし)', () => {
  it('store.update throw → tx auto-rollback (mirror 不変) + silent return + logger.warn 1 回', async () => {
    const db = getClientDb()
    const cardId = newId()
    await db.cards.put({ ...makeClientCard(cardId), title: '元タイトル' })

    // mirror update 自体が throw する経路。 tx callback throw で Dexie auto-rollback、
    // catch 後の silent return を verify。
    const updateSpy = vi
      .spyOn(db.cards, 'update')
      .mockRejectedValueOnce(new Error('boom-mirror'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(
      runOptimisticUpdate({
        store: db.cards,
        rowKey: cardId,
        beforeValue: { title: '元タイトル' },
        afterPatch: { title: '新タイトル' },
        mutation: {
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'title', value: '新タイトル' },
        },
        logEvent: 'test.update.revert_failed',
      }),
    ).resolves.toBeUndefined()

    // tx auto-rollback で mirror は元のまま (= 元タイトル)。
    const row = await db.cards.get(cardId)
    expect(row?.title).toBe('元タイトル')
    expect(await getPendingEntityMutations()).toHaveLength(0)
    // silent: logger.warn 1 行 (case a 取り直し経路)。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const call = warnSpy.mock.calls[0][0] as { event: string; err: unknown }
    expect(call.event).toBe('test.update.revert_failed')
    expect(call.err).toBeInstanceOf(Error)

    updateSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('runOptimisticUpdate — isNoop 早期 return (tx 張らず flush 呼ばず)', () => {
  it('isNoop true → mirror 不変 + outbox 不変 + flush 呼ばれず + return', async () => {
    const db = getClientDb()
    const cardId = newId()
    await db.cards.put({ ...makeClientCard(cardId), title: '同一' })

    // tx 自体張らないことを verify: spy で update / add が呼ばれないことを assert。
    const updateSpy = vi.spyOn(db.cards, 'update')
    const addSpy = vi.spyOn(db.entity_mutations, 'add')

    await expect(
      runOptimisticUpdate({
        store: db.cards,
        rowKey: cardId,
        beforeValue: { title: '同一' },
        afterPatch: { title: '同一' },
        mutation: {
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'title', value: '同一' },
        },
        logEvent: 'test.update.noop',
        isNoop: (before, after) => before.title === after.title,
      }),
    ).resolves.toBeUndefined()

    // mirror 不変。
    const row = await db.cards.get(cardId)
    expect(row?.title).toBe('同一')
    // outbox 不変。
    expect(await getPendingEntityMutations()).toHaveLength(0)
    // tx 自体張らない契約: update / enqueue の add は一切呼ばれない。
    expect(updateSpy).not.toHaveBeenCalled()
    expect(addSpy).not.toHaveBeenCalled()

    updateSpy.mockRestore()
    addSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6.6 runOptimisticUpdate — throwOnError=true で rethrow
// ---------------------------------------------------------------------------

describe('runOptimisticUpdate — throwOnError=true で rethrow', () => {
  it('enqueue throw + throwOnError=true → caller が rejects.toThrow で catch + mirror が beforeValue に戻る + logger.warn 1 回', async () => {
    const db = getClientDb()
    const cardId = newId()
    await db.cards.put({ ...makeClientCard(cardId), title: '元タイトル' })

    // enqueue (entity_mutations.add) を throw 化 → tx callback rethrow → Dexie
    // auto-rollback で mirror update も巻き戻る (mirror は元タイトルのまま)。
    const addSpy = vi
      .spyOn(db.entity_mutations, 'add')
      .mockRejectedValueOnce(new Error('boom-update-rethrow'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(
      runOptimisticUpdate({
        store: db.cards,
        rowKey: cardId,
        beforeValue: { title: '元タイトル' },
        afterPatch: { title: '新タイトル' },
        mutation: {
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'title', value: '新タイトル' },
        },
        logEvent: 'test.update.throw_rethrow',
        logContext: { cardId },
        throwOnError: true,
      }),
    ).rejects.toThrow(/boom-update-rethrow/)

    // tx auto-rollback で mirror は beforeValue 相当 (元タイトル) に戻っている。
    const row = await db.cards.get(cardId)
    expect(row?.title).toBe('元タイトル')
    // outbox は未反映。
    expect(await getPendingEntityMutations()).toHaveLength(0)
    // logger.warn は rethrow 経路でも 1 回呼ばれる (記録は残す)。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const call = warnSpy.mock.calls[0][0] as {
      event: string
      cardId: string
      err: unknown
    }
    expect(call.event).toBe('test.update.throw_rethrow')
    expect(call.cardId).toBe(cardId)
    expect(call.err).toBeInstanceOf(Error)

    addSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6.7 runOptimisticUpdate — skipInternalFlush (caller-side debounce drain との二重 flush 回避)
// ---------------------------------------------------------------------------

describe('runOptimisticUpdate — skipInternalFlush 契約 (caller-side debounce との二重 flush 回避)', () => {
  it('skipInternalFlush=true で内蔵 flush 呼ばれず / 既定 (=false) では 1 回呼ばれる', async () => {
    const db = getClientDb()

    // --- skipInternalFlush=true: 内蔵 flush は skip (caller-side debounce drain に委任) ---
    const cardIdA = newId()
    await db.cards.put({ ...makeClientCard(cardIdA), title: '旧' })

    await expect(
      runOptimisticUpdate({
        store: db.cards,
        rowKey: cardIdA,
        beforeValue: { title: '旧' },
        afterPatch: { title: '新' },
        mutation: {
          entity_type: 'card',
          entity_id: cardIdA,
          op: 'update_field',
          patch: { field: 'title', value: '新' },
        },
        logEvent: 'test.update.skip_flush',
        skipInternalFlush: true,
      }),
    ).resolves.toBeUndefined()

    // mirror / outbox は正常更新済。 内蔵 flush は skip された (二重 flush 回避)。
    expect((await db.cards.get(cardIdA))?.title).toBe('新')
    expect(await getPendingEntityMutations()).toHaveLength(1)
    expect(mockGuardedFlush).not.toHaveBeenCalled()

    // --- 既定 (skipInternalFlush 省略 = false): 内蔵 flush が 1 回呼ばれる ---
    const cardIdB = newId()
    await db.cards.put({ ...makeClientCard(cardIdB), title: '旧B' })

    await expect(
      runOptimisticUpdate({
        store: db.cards,
        rowKey: cardIdB,
        beforeValue: { title: '旧B' },
        afterPatch: { title: '新B' },
        mutation: {
          entity_type: 'card',
          entity_id: cardIdB,
          op: 'update_field',
          patch: { field: 'title', value: '新B' },
        },
        logEvent: 'test.update.default_flush',
        // skipInternalFlush 省略 = 既定 false
      }),
    ).resolves.toBeUndefined()

    expect((await db.cards.get(cardIdB))?.title).toBe('新B')
    // tx 成功後に内蔵 fire-and-forget flush が叩かれる (`void ... .catch(() => {})` は
    // 同期 promise resolve を待たないので、 microtask flush で settle させて assert)。
    await Promise.resolve()
    expect(mockGuardedFlush).toHaveBeenCalledTimes(1)
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
    // T5: buildMutation の戻り型は envelope union だが、 本 test は fail-fast 経路で
    // 呼ばれないため shape 整合は不要 (cast で satisfy)。
    const buildRow = vi.fn((id: string): ClientCard => makeClientCard(id))
    const buildMutation = vi.fn(
      (id: string) =>
        ({
          entity_type: 'card',
          entity_id: id,
          op: 'create',
          patch: {},
        }) as unknown as EnqueueEntityMutationInput,
    )

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
