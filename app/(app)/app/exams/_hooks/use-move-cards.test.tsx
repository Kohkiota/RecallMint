// @vitest-environment jsdom
// useMoveCards: Grid-3 の移動 hook + undo の unit test。
// - real Dexie (fake-indexeddb/auto) で cards / exams / entity_mutations を実 read で検証
// - enqueueEntityMutation は real 実装へ委譲する wrapper (呼出回数の捕捉のみ spy)
// - runGuardedEntityMutationFlush は spy mock (fire-and-forget の呼出回数を観測)
// - wire の形は組立側の型ではなく **保存された patch を `cardMovePatchSchema` で parse** して
//   pin する (contract の一致を test 側で実証する)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect } from 'react'

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { cardMovePatchSchema } from '@/lib/sync/shared/mutation-schemas'

// ---------------------------------------------------------------------------
// モック (use-bulk-card-delete.test.tsx と同じ作法)
// ---------------------------------------------------------------------------

const { enqueueSpy, mockFlush, enqueueHandle } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  // test から enqueue 実装を差し替えるための可変ハンドル (既定は real 委譲)。
  // tx 失敗の注入に使う (use-bulk-card-delete.test.tsx と同じ作法)。
  enqueueHandle: {
    current: (input: unknown, real: (input: unknown) => Promise<unknown>) => real(input),
  } as {
    current: (input: unknown, real: (input: unknown) => Promise<unknown>) => Promise<unknown>
  },
}))

vi.mock('@/lib/sync/entity-mutations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sync/entity-mutations')>(
    '@/lib/sync/entity-mutations',
  )
  return {
    ...actual,
    enqueueEntityMutation: (input: unknown) => {
      enqueueSpy(input)
      return enqueueHandle.current(
        input,
        actual.enqueueEntityMutation as (i: unknown) => Promise<unknown>,
      )
    },
  }
})

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import {
  useMoveCards,
  type MoveResult,
  type UndoResult,
  type UseMoveCards,
} from './use-move-cards'

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const USER = 'user-1'
const OTHER_USER = 'user-2'

const EXAM_1 = '11111111-1111-4111-8111-111111111111'
const EXAM_2 = '22222222-2222-4222-8222-222222222222'
const EXAM_3 = '33333333-3333-4333-8333-333333333333'

function cardId(n: number): string {
  return `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`
}

const C1 = cardId(1)
const C2 = cardId(2)
const C3 = cardId(3)
const R1 = cardId(11)
const R2 = cardId(12)
const MISSING = cardId(99)

const SEED_UPDATED_AT = '2026-06-01T00:00:00.000Z'

function makeCard(
  id: string,
  examId: string,
  baseOrder: number,
  userId = USER,
): ClientCard {
  return {
    id,
    user_id: userId,
    exam_id: examId,
    base_order: baseOrder,
    title: `card-${id}`,
    question_text: `q-${id}`,
    options: [{ id: 'a', text: 'a', is_correct: true }],
    correct_answer_ids: ['a'],
    images: [],
    answered: false,
    current_streak: 0,
    due: '2026-06-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: SEED_UPDATED_AT,
    sync_status: 'synced',
  }
}

function makeExam(id: string, userId = USER): ClientExam {
  return {
    id,
    user_id: userId,
    name: `exam-${id}`,
    content_version: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: SEED_UPDATED_AT,
  }
}

async function seed(cards: ClientCard[], examIds: string[] = [EXAM_1, EXAM_2]) {
  const db = getClientDb()
  await db.exams.bulkPut(examIds.map((id) => makeExam(id)))
  await db.cards.bulkPut(cards)
}

async function cardRow(id: string) {
  return getClientDb().cards.get(id)
}

/** 保存された card_move 行を patch まで parse して返す。 */
async function moveRows() {
  const rows = await getClientDb().entity_mutations.toArray()
  return rows.map((row) => ({
    entity_type: row.entity_type,
    op: row.op,
    entity_id: row.entity_id,
    mutation_id: row.mutation_id,
    // 契約一致の実証: 保存 patch を wire schema で parse する (失敗すれば test も落ちる)。
    patch: cardMovePatchSchema.parse(row.patch),
  }))
}

/** patch.cards を id 昇順で比較しやすい形に整える。 */
function sortedCards(cards: { id: string; base_order: number }[]) {
  return [...cards].sort((a, b) => (a.id < b.id ? -1 : 1))
}

// ---------------------------------------------------------------------------
// hook mount
// ---------------------------------------------------------------------------

function HookWrapper({
  userId,
  onReady,
}: {
  userId: string
  onReady: (api: UseMoveCards) => void
}) {
  const api = useMoveCards({ userId })
  useEffect(() => {
    onReady(api)
  }, [api, onReady])
  return <div data-testid="hook-wrapper" />
}

function mountMove(userId = USER): UseMoveCards {
  let api: UseMoveCards | null = null
  render(
    <HookWrapper
      userId={userId}
      onReady={(a) => {
        api = a
      }}
    />,
  )
  return api!
}

beforeEach(async () => {
  vi.clearAllMocks()
  enqueueHandle.current = (input, real) => real(input) // 既定は real 委譲
  const db = getClientDb()
  await db.cards.clear()
  await db.exams.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Case 1: cross-exam 末尾移動 — mirror 更新 / envelope 1 件 / patch 契約 / originals
// ===========================================================================

describe('useMoveCards — cross-exam 末尾移動', () => {
  it('mirror が移動先 exam + 新 base_order に更新され、card_move envelope が 1 件だけ積まれる', async () => {
    await seed([
      makeCard(C1, EXAM_1, 1024),
      makeCard(C2, EXAM_1, 2048),
      makeCard(C3, EXAM_1, 3072),
      makeCard(R1, EXAM_2, 1024),
      makeCard(R2, EXAM_2, 2048),
    ])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C3, C1], // 呼出順は基準順と無関係 (domain が base_order で並べ替える)
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    // mirror: 移動対象のみ移動先 exam + 末尾採番 (常駐の最大 2048 の次から stride 刻み)。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2, base_order: 3072 })
    expect(await cardRow(C3)).toMatchObject({ exam_id: EXAM_2, base_order: 4096 })
    // 非対象と常駐は無傷。
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2048 })
    expect(await cardRow(R1)).toMatchObject({ exam_id: EXAM_2, base_order: 1024 })
    expect(await cardRow(R2)).toMatchObject({ exam_id: EXAM_2, base_order: 2048 })
    // mirror の updated_at は触らない (pull-back で server 値に収束する既存流儀)。
    expect((await cardRow(C1))?.updated_at).toBe(SEED_UPDATED_AT)

    // envelope は 1 件だけ (per-card ではなく集約 op)。
    const rows = await moveRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_type).toBe('card_move')
    expect(rows[0].op).toBe('move')
    expect(rows[0].patch.exam_id).toBe(EXAM_2)
    expect(sortedCards(rows[0].patch.cards)).toEqual([
      { id: C1, base_order: 3072 },
      { id: C3, base_order: 4096 },
    ])
    // entity_id は対象 card の PK ではなく移動操作 instance の uuid (spec §2.1)。
    expect(rows[0].entity_id).not.toBe(C1)
    expect(rows[0].entity_id).not.toBe(C3)
    expect(rows[0].entity_id).not.toBe(EXAM_2)
    expect(rows[0].entity_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    // 返り値 = undo 素材。originals は移動前の (exam_id, base_order)。
    expect(result).toEqual({
      ok: true,
      movedCount: 2,
      sourceExamId: EXAM_1,
      originals: expect.arrayContaining([
        { id: C1, exam_id: EXAM_1, base_order: 1024 },
        { id: C3, exam_id: EXAM_1, base_order: 3072 },
      ]),
    })
    // 割当と originals の整合: 同じ id 集合を覆う。
    const okResult = result as MoveResult & { ok: true }
    expect(new Set(okResult.originals.map((o) => o.id))).toEqual(
      new Set(rows[0].patch.cards.map((c) => c.id)),
    )

    // 1 tx + 1 flush。
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Case 2: 再採番を伴う同一 exam 内移動 — originals が常駐の再採番分も含む
// ===========================================================================

describe('useMoveCards — 同一 exam 内移動 (step=0 再採番)', () => {
  it('常駐の再採番割当も patch と originals の両方に含まれる', async () => {
    // 隣接 gap 1 (1,2,3) → 挿入すると step=0 になり常駐列が再採番される。
    await seed([
      makeCard(C1, EXAM_1, 1),
      makeCard(C2, EXAM_1, 2),
      makeCard(C3, EXAM_1, 3),
    ])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C3],
        targetExamId: EXAM_1,
        placement: { kind: 'after', anchorId: C1 },
      })
    })

    // 常駐 (C1/C2) は i·S に再採番、移動対象 C3 はその間へ。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1024 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2048 })
    expect(await cardRow(C3)).toMatchObject({ exam_id: EXAM_1, base_order: 1536 })

    const rows = await moveRows()
    expect(rows).toHaveLength(1)
    expect(sortedCards(rows[0].patch.cards)).toEqual([
      { id: C1, base_order: 1024 },
      { id: C2, base_order: 2048 },
      { id: C3, base_order: 1536 },
    ])

    // originals は「割当対象の全 card」= 常駐 2 枚 + 移動対象 1 枚の **移動前** の値。
    const okResult = result as MoveResult & { ok: true }
    expect([...okResult.originals].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      { id: C1, exam_id: EXAM_1, base_order: 1 },
      { id: C2, exam_id: EXAM_1, base_order: 2 },
      { id: C3, exam_id: EXAM_1, base_order: 3 },
    ])
    // movedCount は「移動対象」の枚数であって割当件数ではない。
    expect(okResult.movedCount).toBe(1)
  })
})

// ===========================================================================
// Case 3: runtime invariant — 複数 source exam 混入で throw
// ===========================================================================

describe('useMoveCards — 複数 source exam', () => {
  it('元 exam が複数の選択で throw し、mirror も outbox も変えない', async () => {
    await seed(
      [
        makeCard(C1, EXAM_1, 1024),
        makeCard(C2, EXAM_3, 1024),
        makeCard(R1, EXAM_2, 1024),
      ],
      [EXAM_1, EXAM_2, EXAM_3],
    )
    const { moveCards } = mountMove()

    await act(async () => {
      await expect(
        moveCards({
          cardIds: [C1, C2],
          targetExamId: EXAM_2,
          placement: { kind: 'end' },
        }),
      ).rejects.toThrow(/multiple source exams/)
    })

    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1024 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_3, base_order: 1024 })
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Case 4: mirror 不在 / 他 user 行の除外 (server の skip-missing と同意味論)
// ===========================================================================

describe('useMoveCards — mirror 不在分の除外', () => {
  it('mirror に無い id は除外して残りを移動する', async () => {
    await seed([makeCard(C1, EXAM_1, 1024), makeCard(C2, EXAM_1, 2048)])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C1, MISSING, C2],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    const rows = await moveRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].patch.cards.map((c) => c.id).sort()).toEqual([C1, C2].sort())
    expect((result as MoveResult & { ok: true }).movedCount).toBe(2)
  })

  it('他 user の mirror 行は不在扱いで除外する (認証主体名義の outbox に載せない)', async () => {
    await seed([
      makeCard(C1, EXAM_1, 1024),
      makeCard(C2, EXAM_1, 2048, OTHER_USER),
    ])
    const { moveCards } = mountMove()

    await act(async () => {
      await moveCards({
        cardIds: [C1, C2],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    const rows = await moveRows()
    expect(rows[0].patch.cards.map((c) => c.id)).toEqual([C1])
    // 他 user 行の mirror は書き換えない。
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2048 })
  })
})

// ===========================================================================
// Case 5: 存在 0 件 — mutation を発行しない
// ===========================================================================

describe('useMoveCards — 存在 0 件', () => {
  it('要求 id が全て mirror に無ければ {ok:false} で enqueue も flush もしない', async () => {
    await seed([makeCard(R1, EXAM_2, 1024)])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [MISSING],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    expect(result).toEqual({ ok: false, reason: 'no-cards' })
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    expect(await getClientDb().entity_mutations.count()).toBe(0)
    // 移動先の常駐も無傷。
    expect(await cardRow(R1)).toMatchObject({ exam_id: EXAM_2, base_order: 1024 })
  })

  it('空配列も同じく no-op', async () => {
    await seed([makeCard(C1, EXAM_1, 1024)])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    expect(result).toEqual({ ok: false, reason: 'no-cards' })
    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Case 6: undo 検証失敗 — 2 理由を区別して返す
// ===========================================================================

describe('useMoveCards — undo の検証失敗', () => {
  async function moveOnce(): Promise<MoveResult & { ok: true }> {
    await seed([
      makeCard(C1, EXAM_1, 1024),
      makeCard(C2, EXAM_1, 2048),
      makeCard(R1, EXAM_2, 1024),
    ])
    const { moveCards } = mountMove()
    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C1, C2],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })
    return result as MoveResult & { ok: true }
  }

  it('移動した card が削除されていたら cards-missing', async () => {
    const moved = await moveOnce()
    await getClientDb().cards.delete(C2)
    const { undoMove } = mountMove()

    let undone: UndoResult | undefined
    await act(async () => {
      undone = await undoMove(moved)
    })

    expect(undone).toEqual({ ok: false, reason: 'cards-missing' })
    // 検証失敗時は mutation を発行しない (forward の 1 件のみ)。
    expect(await getClientDb().entity_mutations.count()).toBe(1)
    // 残った card も戻さない。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2 })
  })

  it('元 exam が削除されていたら source-exam-missing', async () => {
    const moved = await moveOnce()
    await getClientDb().exams.delete(EXAM_1)
    const { undoMove } = mountMove()

    let undone: UndoResult | undefined
    await act(async () => {
      undone = await undoMove(moved)
    })

    expect(undone).toEqual({ ok: false, reason: 'source-exam-missing' })
    expect(await getClientDb().entity_mutations.count()).toBe(1)
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2 })
  })

  it('card 欠けと元 exam 消滅が同時なら元 exam 消滅を優先して返す (exam 削除は配下 card も消すため)', async () => {
    const moved = await moveOnce()
    await getClientDb().exams.delete(EXAM_1)
    await getClientDb().cards.delete(C2)
    const { undoMove } = mountMove()

    let undone: UndoResult | undefined
    await act(async () => {
      undone = await undoMove(moved)
    })

    expect(undone).toEqual({ ok: false, reason: 'source-exam-missing' })
  })
})

// ===========================================================================
// Case 7: undo 往復 — originals の復元
// ===========================================================================

describe('useMoveCards — undo 往復', () => {
  it('cross-exam 移動を undo すると mirror が移動前に完全復元される', async () => {
    await seed([
      makeCard(C1, EXAM_1, 1024),
      makeCard(C2, EXAM_1, 2048),
      makeCard(R1, EXAM_2, 1024),
    ])
    const examsBefore = await getClientDb().exams.toArray()
    const { moveCards, undoMove } = mountMove()

    let moved: MoveResult | undefined
    await act(async () => {
      moved = await moveCards({
        cardIds: [C1, C2],
        targetExamId: EXAM_2,
        placement: { kind: 'start' },
      })
    })
    // 先頭挿入: 常駐 1024 の手前へ step=floor(1024/3)=341 刻み。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2, base_order: 341 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_2, base_order: 682 })

    let undone: UndoResult | undefined
    await act(async () => {
      undone = await undoMove(moved as MoveResult & { ok: true })
    })

    expect(undone).toEqual({ ok: true })
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1024 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2048 })

    // undo は補償機構ではなく通常の move 1 件 (forward と別 entity_id / mutation_id)。
    const rows = await moveRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].entity_type).toBe('card_move')
    expect(rows[1].op).toBe('move')
    expect(rows[1].patch.exam_id).toBe(EXAM_1)
    expect(sortedCards(rows[1].patch.cards)).toEqual([
      { id: C1, base_order: 1024 },
      { id: C2, base_order: 2048 },
    ])
    expect(rows[1].entity_id).not.toBe(rows[0].entity_id)
    expect(rows[1].mutation_id).not.toBe(rows[0].mutation_id)

    // exams mirror は read-only レーン: move / undo のどちらでも書かない。
    expect(await getClientDb().exams.toArray()).toEqual(examsBefore)
  })

  it('同一 exam 内 + 再採番を含む往復でも元の順序が復元される', async () => {
    await seed([
      makeCard(C1, EXAM_1, 1),
      makeCard(C2, EXAM_1, 2),
      makeCard(C3, EXAM_1, 3),
    ])
    const { moveCards, undoMove } = mountMove()

    let moved: MoveResult | undefined
    await act(async () => {
      moved = await moveCards({
        cardIds: [C3],
        targetExamId: EXAM_1,
        placement: { kind: 'after', anchorId: C1 },
      })
    })

    let undone: UndoResult | undefined
    await act(async () => {
      undone = await undoMove(moved as MoveResult & { ok: true })
    })

    expect(undone).toEqual({ ok: true })
    // 再採番された常駐も一緒に戻る (移動対象だけ戻すと順序が復元されない)。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2 })
    expect(await cardRow(C3)).toMatchObject({ exam_id: EXAM_1, base_order: 3 })

    const rows = await moveRows()
    expect(sortedCards(rows[1].patch.cards)).toEqual([
      { id: C1, base_order: 1 },
      { id: C2, base_order: 2 },
      { id: C3, base_order: 3 },
    ])
  })

  it('cross-exam + 再採番で「移動していない常駐」が削除されても undo は成功する (検証対象は undo patch に載る card だけ)', async () => {
    // broad な検証 (originals 全件) にすると、移動していない常駐の削除だけで undo が
    // cards-missing で拒否され、「移動したカードの一部が削除されています」という
    // 偽の理由を出してしまう。検証対象を undo patch の card に絞ってあることを pin する。
    await seed([
      makeCard(C1, EXAM_1, 3072),
      makeCard(R1, EXAM_2, 1),
      makeCard(R2, EXAM_2, 2),
    ])
    const { moveCards, undoMove } = mountMove()

    let moved: MoveResult | undefined
    await act(async () => {
      moved = await moveCards({
        cardIds: [C1],
        targetExamId: EXAM_2,
        placement: { kind: 'after', anchorId: R1 },
      })
    })
    // originals には移動先常駐 (R2) も含まれる = broad 検証なら欠けで拒否される対象。
    expect((moved as MoveResult & { ok: true }).originals.map((o) => o.id)).toContain(R2)

    // 移動していない常駐 R2 を削除してから undo。
    await getClientDb().cards.delete(R2)

    let undone: UndoResult | undefined
    await act(async () => {
      undone = await undoMove(moved as MoveResult & { ok: true })
    })

    expect(undone).toEqual({ ok: true })
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 3072 })
    const rows = await moveRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].patch.cards).toEqual([{ id: C1, base_order: 3072 }])
  })

  it('cross-exam + 再採番の undo は移動先常駐を戻さない (元 exam が source の分だけ)', async () => {
    await seed([
      makeCard(C1, EXAM_1, 3072),
      makeCard(R1, EXAM_2, 1),
      makeCard(R2, EXAM_2, 2),
    ])
    const { moveCards, undoMove } = mountMove()

    let moved: MoveResult | undefined
    await act(async () => {
      moved = await moveCards({
        cardIds: [C1],
        targetExamId: EXAM_2,
        placement: { kind: 'after', anchorId: R1 },
      })
    })
    // 常駐は再採番、移動対象はその間へ。
    expect(await cardRow(R1)).toMatchObject({ exam_id: EXAM_2, base_order: 1024 })
    expect(await cardRow(R2)).toMatchObject({ exam_id: EXAM_2, base_order: 2048 })
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2, base_order: 1536 })
    // originals は移動先常駐の元値も持つ (undo 対象ではないが割当対象なので控える)。
    expect((moved as MoveResult & { ok: true }).originals).toEqual(
      expect.arrayContaining([
        { id: R1, exam_id: EXAM_2, base_order: 1 },
        { id: R2, exam_id: EXAM_2, base_order: 2 },
        { id: C1, exam_id: EXAM_1, base_order: 3072 },
      ]),
    )

    await act(async () => {
      await undoMove(moved as MoveResult & { ok: true })
    })

    const rows = await moveRows()
    // undo patch は元 exam が source の card だけ。
    expect(rows[1].patch.exam_id).toBe(EXAM_1)
    expect(rows[1].patch.cards).toEqual([{ id: C1, base_order: 3072 }])
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 3072 })
    // 移動先常駐は再採番後の値のまま (戻す必要がない)。
    expect(await cardRow(R1)).toMatchObject({ exam_id: EXAM_2, base_order: 1024 })
    expect(await cardRow(R2)).toMatchObject({ exam_id: EXAM_2, base_order: 2048 })
  })
})

// ===========================================================================
// Case 8: tx 失敗 — reject する (throwOnError: true)
//
// 落ちると「実際には移動していないのに {ok:true, movedCount:N} が返り、
// 『N 枚を移動しました [元に戻す]』が出る」最悪の見え方になるため pin する。
// ===========================================================================

describe('useMoveCards — tx 失敗は reject する', () => {
  it('moveCards: enqueue throw で reject し、mirror も rollback される', async () => {
    await seed([makeCard(C1, EXAM_1, 1024), makeCard(C2, EXAM_1, 2048)])
    enqueueHandle.current = async () => {
      throw new Error('enqueue boom')
    }
    const { moveCards } = mountMove()

    await act(async () => {
      await expect(
        moveCards({
          cardIds: [C1, C2],
          targetExamId: EXAM_2,
          placement: { kind: 'end' },
        }),
      ).rejects.toThrow('enqueue boom')
    })

    // Dexie tx auto-rollback: mirror は移動前のまま (楽観更新が残らない)。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1024 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2048 })
    expect(await getClientDb().entity_mutations.count()).toBe(0)
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('undoMove: enqueue throw で reject し、mirror は移動後のまま (勝手に戻さない)', async () => {
    await seed([makeCard(C1, EXAM_1, 1024), makeCard(R1, EXAM_2, 1024)])
    const { moveCards, undoMove } = mountMove()

    let moved: MoveResult | undefined
    await act(async () => {
      moved = await moveCards({
        cardIds: [C1],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2, base_order: 2048 })

    enqueueHandle.current = async () => {
      throw new Error('undo enqueue boom')
    }

    await act(async () => {
      await expect(undoMove(moved as MoveResult & { ok: true })).rejects.toThrow(
        'undo enqueue boom',
      )
    })

    // undo 分の mutation は残らず、mirror も移動後の値のまま (部分適用なし)。
    expect(await getClientDb().entity_mutations.count()).toBe(1)
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_2, base_order: 2048 })
  })
})

// ===========================================================================
// Case 9: 重複 cardIds — schema の一意性 refine を破る patch を作らない
// ===========================================================================

describe('useMoveCards — 重複 cardIds', () => {
  it('同じ id が複数入っていても patch は一意 + movedCount は実枚数', async () => {
    await seed([makeCard(C1, EXAM_1, 1024), makeCard(C2, EXAM_1, 2048)])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C1, C1, C2, C1],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    // moveRows() は cardMovePatchSchema.parse を通すため、重複が残れば
    // 一意性 refine で parse が落ちる (= この test が red になる)。
    const rows = await moveRows()
    expect(rows).toHaveLength(1)
    expect(sortedCards(rows[0].patch.cards)).toEqual([
      { id: C1, base_order: 1024 },
      { id: C2, base_order: 2048 },
    ])
    expect((result as MoveResult & { ok: true }).movedCount).toBe(2)
    expect((result as MoveResult & { ok: true }).originals).toHaveLength(2)
  })
})

// ===========================================================================
// Case 10: 移動先 exam の検証 — 存在しない exam へ楽観移動しない
//
// 検査が無いと、常駐列 query が「0 件」を返すだけで mirror 書込 + enqueue に進み、
// server が failed を返した後も card は存在しない exam に所属したまま
// (= どのビューからも見えない) になる。
// ===========================================================================

describe('useMoveCards — 移動先 exam の検証', () => {
  it('移動先 exam が mirror に無ければ mutation を発行せず mirror も触らない (理由を判別できる)', async () => {
    // exams は EXAM_1 のみ seed (移動先 EXAM_2 は mirror に無い)。
    await seed([makeCard(C1, EXAM_1, 1024), makeCard(C2, EXAM_1, 2048)], [EXAM_1])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C1, C2],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    // ③ 呼出側が理由を判別できる (no-cards ではない)。
    expect(result).toEqual({ ok: false, reason: 'target-exam-missing' })
    // ① mutation 未発行。
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    expect(await getClientDb().entity_mutations.count()).toBe(0)
    // ② mirror の card は元の exam / base_order のまま。
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1024 })
    expect(await cardRow(C2)).toMatchObject({ exam_id: EXAM_1, base_order: 2048 })
  })

  it('移動先 exam が他 user のものなら同じく target-exam-missing (owner 一致まで見る)', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([makeExam(EXAM_1), makeExam(EXAM_2, OTHER_USER)])
    await db.cards.bulkPut([makeCard(C1, EXAM_1, 1024)])
    const { moveCards } = mountMove()

    let result: MoveResult | undefined
    await act(async () => {
      result = await moveCards({
        cardIds: [C1],
        targetExamId: EXAM_2,
        placement: { kind: 'end' },
      })
    })

    expect(result).toEqual({ ok: false, reason: 'target-exam-missing' })
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(await cardRow(C1)).toMatchObject({ exam_id: EXAM_1, base_order: 1024 })
  })
})
