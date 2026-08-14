// Grid-3: card_move.move の apply を実 PostgreSQL で pin する (spec §10-2/4/5)。
//
// 本 file が pin する範囲:
//   - 割当 N 件が **1 tx** で反映され、`ORDER BY base_order, id` の readback が
//     client の意図した順になること (server は順序を計算せず絶対値を適用するだけ)。
//   - 移動で **exam_id / base_order / updated_at 以外の列が動かない**こと。行全体を
//     SELECT * で前後比較し、加えて card_tags / answer_events / card_asset_refs の
//     関連行が不変であることを見る (kickoff 決定 8)。
//   - 不在 card の skip / 全滅時の空適用 / 移動先 exam 不在の failed (spec §4.2)。
//   - 他 tenant の card / exam を混ぜてもその行が動かないこと (**RLS 込みの** tenant 境界。
//     app 層 `user_id` 述語単独の検出力は unit の SQL shape assert 側が持つ)。
//   - 同一 patch の再適用が結果を変えないこと (絶対値ゆえの semantic 冪等)。
//   - 新語彙 (`card_move` / `move`) の log 行が DB CHECK を通り、mutation_id UNIQUE で
//     1 行に畳まれること (migration 0038 と bulk route の log INSERT の噛み合わせ)。
// pin しない範囲:
//   - route の per-mutation 成否判定 (registry lookup / patch zod / 冪等 gate)。
//     これは app/api/entity-mutations/bulk/route.test.ts が mock 経路で見る。
//   - 発行 SQL の形 (SET 句 3 列 / VALUES join) は lib/cards/apply-card-move.test.ts。

import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { applyCardMove } from '@/lib/cards/apply-card-move'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import { closeDb } from '@/lib/db'
import { cards, entityMutations, exams } from '@/lib/db/schema'

import { asTenant } from './setup/as-tenant'
import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

let fx: TenantFixture
let targetExamId: string

beforeEach(async () => {
  await truncateAllUserTables()
  fx = await seedTwoTenants()
  // 移動先 exam (tenant A の 2 つ目)。seed は owner 接続 = 前提の作り込み。
  targetExamId = randomUUID()
  await getFixtureOwnerDb()
    .insert(exams)
    .values({ id: targetExamId, userId: fx.a.userId, name: 'Exam A2' })
})

const FSRS = initialFsrsState(new Date('2026-08-14T00:00:00.000Z'))

// 追加 card を owner 接続で入れる (seed 済の fx.a.cardId には触らない)。
async function insertCard(
  userId: string,
  examId: string,
  baseOrder: number,
): Promise<string> {
  const id = randomUUID()
  await getFixtureOwnerDb()
    .insert(cards)
    .values({
      id,
      userId,
      examId,
      title: `T${baseOrder}`,
      baseOrder,
      questionText: 'Q?',
      options: [],
      correctAnswerIds: [],
      ...FSRS,
    })
  return id
}

async function readRow(cardId: string): Promise<Record<string, unknown>> {
  const rows = await getFixtureOwnerDb().execute<Record<string, unknown>>(
    sql`SELECT * FROM cards WHERE id = ${cardId}`,
  )
  return rows[0]!
}

async function readOrder(examId: string): Promise<string[]> {
  const rows = await getFixtureOwnerDb().execute<{ id: string }>(
    sql`SELECT id FROM cards WHERE exam_id = ${examId} ORDER BY base_order, id`,
  )
  return rows.map((r) => r.id)
}

describe('card_move: 割当の一括適用と順序', () => {
  it('3 枚を 1 tx で移動し、readback が client の意図順になる (相対順を反転させても従う)', async () => {
    const c1 = await insertCard(fx.a.userId, fx.a.examId, 1024)
    const c2 = await insertCard(fx.a.userId, fx.a.examId, 2048)
    const c3 = await insertCard(fx.a.userId, fx.a.examId, 3072)

    // 意図順 = c3, c2, c1 (元の順の反転)。server が自前で採番するなら再現しない。
    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: targetExamId,
        cards: [
          { id: c1, base_order: 3072 },
          { id: c2, base_order: 2048 },
          { id: c3, base_order: 1024 },
        ],
      }),
    )

    expect(result).toBe('applied')
    expect(await readOrder(targetExamId)).toEqual([c3, c2, c1])
    // 移動元には seed 済 card だけが残る
    expect(await readOrder(fx.a.examId)).toEqual([fx.a.cardId])
  })

  it('呼出側 tx が rollback すると 1 枚も動かない (割当 N 件が同一 tx)', async () => {
    // seed 済 card の base_order (1024) を避ける — 同値だと id tiebreak で
    // readback 順が uuid 依存になり、この test の主張と無関係に揺れる。
    const c1 = await insertCard(fx.a.userId, fx.a.examId, 2048)
    const c2 = await insertCard(fx.a.userId, fx.a.examId, 3072)

    await expect(
      asTenant(fx.a.userId, async (tx) => {
        await applyCardMove(tx, fx.a.userId, randomUUID(), {
          exam_id: targetExamId,
          cards: [
            { id: c1, base_order: 1024 },
            { id: c2, base_order: 2048 },
          ],
        })
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')

    expect(await readOrder(targetExamId)).toEqual([])
    expect(await readOrder(fx.a.examId)).toEqual([fx.a.cardId, c1, c2])
  })
})

describe('card_move: 不変条件 readback (kickoff 決定 8)', () => {
  it('exam_id / base_order / updated_at 以外の全列が bit 単位で不変', async () => {
    // seed 済 card は FSRS 列・source_document_id・options・images default を持つ。
    const before = await readRow(fx.a.cardId)

    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: targetExamId,
        cards: [{ id: fx.a.cardId, base_order: 4096 }],
      }),
    )
    expect(result).toBe('applied')

    const after = await readRow(fx.a.cardId)

    // 動くべき 3 列
    expect(after['exam_id']).toBe(targetExamId)
    expect(after['base_order']).toBe(4096)
    // raw execute の timestamptz は文字列で返る (owner db に schema 型を渡していない)
    expect(new Date(String(after['updated_at'])).getTime()).toBeGreaterThan(
      new Date(String(before['updated_at'])).getTime(),
    )

    // 残り全列 (FSRS 一式 / answered / current_streak / title / question_text /
    // options / images / source_document_id / content_version / created_at ...) は不変。
    // 列名を手書き列挙せず差分で見る = 将来 列が増えても pin が効き続ける。
    const mutable = new Set(['exam_id', 'base_order', 'updated_at'])
    const beforeRest = Object.fromEntries(
      Object.entries(before).filter(([k]) => !mutable.has(k)),
    )
    const afterRest = Object.fromEntries(
      Object.entries(after).filter(([k]) => !mutable.has(k)),
    )
    expect(afterRest).toEqual(beforeRest)
    // 入力が退化していない (= 比較対象の列が実在する) ことの確認
    expect(Object.keys(beforeRest).length).toBeGreaterThan(20)
    expect(beforeRest['content_version']).toBe(0)
    expect(beforeRest['source_document_id']).toBe(fx.a.sourceDocumentId)
  })

  it('card_tags / answer_events / card_asset_refs の関連行が不変', async () => {
    const readRelated = async () => ({
      tags: await getFixtureOwnerDb().execute<Record<string, unknown>>(
        sql`SELECT * FROM card_tags WHERE card_id = ${fx.a.cardId}`,
      ),
      events: await getFixtureOwnerDb().execute<Record<string, unknown>>(
        sql`SELECT * FROM answer_events WHERE card_id = ${fx.a.cardId}`,
      ),
      refs: await getFixtureOwnerDb().execute<Record<string, unknown>>(
        sql`SELECT * FROM card_asset_refs WHERE card_id = ${fx.a.cardId}`,
      ),
    })

    const before = await readRelated()
    // seed が実際に関連行を持っていること (空同士の一致で緑になるのを防ぐ)
    expect(before.tags).toHaveLength(1)
    expect(before.events).toHaveLength(1)
    expect(before.refs).toHaveLength(1)

    await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: targetExamId,
        cards: [{ id: fx.a.cardId, base_order: 4096 }],
      }),
    )

    expect(await readRelated()).toEqual(before)
  })
})

describe('card_move: skip / failed の境界 (spec §4.2)', () => {
  it('patch 内の 1 枚が先行削除済 → 残りを適用して applied', async () => {
    const alive = await insertCard(fx.a.userId, fx.a.examId, 1024)
    const deleted = randomUUID() // 存在しない card id

    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: targetExamId,
        cards: [
          { id: deleted, base_order: 1024 },
          { id: alive, base_order: 2048 },
        ],
      }),
    )

    expect(result).toBe('applied')
    expect(await readOrder(targetExamId)).toEqual([alive])
  })

  it('対象が全件不在 → 空適用で applied (outbox を掃かせる)', async () => {
    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: targetExamId,
        cards: [{ id: randomUUID(), base_order: 1024 }],
      }),
    )

    expect(result).toBe('applied')
    expect(await readOrder(targetExamId)).toEqual([])
  })

  it('移動先 exam が不在 → failed で 1 行も動かない', async () => {
    const c1 = await insertCard(fx.a.userId, fx.a.examId, 1024)

    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: randomUUID(),
        cards: [{ id: c1, base_order: 2048 }],
      }),
    )

    expect(result).toBe('failed')
    const row = await readRow(c1)
    expect(row['exam_id']).toBe(fx.a.examId)
    expect(row['base_order']).toBe(1024)
  })

  // 下 2 件が pin するのは **RLS 込みの tenant 境界**(app 層述語 + policy の合成結果)。
  // app 層の `user_id` 述語だけを消しても RLS が同じ結果に倒すため green のままで、
  // app 層単独の検出力はここには無い — それは unit 側の SQL shape assert
  // (lib/cards/apply-card-move.test.ts の owner-scope WHERE 描画) が持つ。
  it('移動先が他 tenant の exam → failed (RLS 込みの境界)', async () => {
    const c1 = await insertCard(fx.a.userId, fx.a.examId, 1024)

    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: fx.b.examId,
        cards: [{ id: c1, base_order: 2048 }],
      }),
    )

    expect(result).toBe('failed')
    expect((await readRow(c1))['exam_id']).toBe(fx.a.examId)
  })

  it('他 tenant の card id を混ぜても其行は不変 (RLS 込みの境界・残りは適用)', async () => {
    const mine = await insertCard(fx.a.userId, fx.a.examId, 1024)
    const otherBefore = await readRow(fx.b.cardId)

    const result = await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), {
        exam_id: targetExamId,
        cards: [
          { id: fx.b.cardId, base_order: 8192 },
          { id: mine, base_order: 2048 },
        ],
      }),
    )

    expect(result).toBe('applied')
    expect(await readOrder(targetExamId)).toEqual([mine])
    expect(await readRow(fx.b.cardId)).toEqual(otherBefore)
  })
})

describe('card_move: 冪等', () => {
  it('同一 patch を別 mutation として再適用しても結果は変わらない (絶対値ゆえの semantic 冪等)', async () => {
    const c1 = await insertCard(fx.a.userId, fx.a.examId, 1024)
    const patch = { exam_id: targetExamId, cards: [{ id: c1, base_order: 5120 }] }

    await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), patch),
    )
    const afterFirst = await readRow(c1)

    await asTenant(fx.a.userId, (tx) =>
      applyCardMove(tx, fx.a.userId, randomUUID(), patch),
    )
    const afterSecond = await readRow(c1)

    // updated_at だけは 2 度目の now() で進む (pull 伝播のため必須の bump)
    expect(afterSecond['exam_id']).toBe(targetExamId)
    expect(afterSecond['base_order']).toBe(5120)
    const mutable = new Set(['updated_at'])
    expect(
      Object.fromEntries(Object.entries(afterSecond).filter(([k]) => !mutable.has(k))),
    ).toEqual(
      Object.fromEntries(Object.entries(afterFirst).filter(([k]) => !mutable.has(k))),
    )
  })

  it('log 行は新語彙 (card_move / move) で DB CHECK を通り、同 mutation_id 再送は 1 行に畳まれる', async () => {
    // bulk route の log INSERT (skipLog なし + onConflictDoNothing) と同形。
    // migration 0038 の CHECK 拡張が実 DB で効いていることの直接確認でもある。
    const mutationId = randomUUID()
    const moveId = randomUUID()
    const insertLog = () =>
      asTenant(fx.a.userId, (tx) =>
        tx
          .insert(entityMutations)
          .values({
            mutationId,
            entityType: 'card_move',
            entityId: moveId,
            userId: fx.a.userId,
            op: 'move',
            patch: { exam_id: targetExamId, cards: [] },
            editedAt: new Date('2026-08-14T00:00:00.000Z'),
            appliedAt: sql`now()`,
          })
          .onConflictDoNothing({ target: entityMutations.mutationId }),
      )

    await insertLog()
    await insertLog()

    const rows = await getFixtureOwnerDb().execute<{ count: string }>(
      sql`SELECT count(*)::int AS count FROM entity_mutations WHERE mutation_id = ${mutationId}`,
    )
    expect(rows[0]!.count).toBe(1)
  })
})
