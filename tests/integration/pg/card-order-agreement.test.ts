// Order-1: 全順序 `(base_order ASC, id ASC)` について **server の SQL と client の
// comparator が同じ列を返す**ことを実 PostgreSQL で pin する (spec §2.1)。
//
// なぜ実 PG が要るか: この一致は「JS の素の文字列比較が PG の `uuid` 型の byte order と
// 一致する」という前提の上に立っており (spec D-3)、PG 側を unit test で模せないため。
//
// 本 file が pin する範囲:
//   - **小文字 canonical UUID の集合において** PG の uuid 順 == JS の素の文字列順であること。
//   - `ORDER BY base_order, id` と `compareByBaseOrder` の結果列が完全一致すること。
//     **重複 base_order を含む集合でも**一致すること。
//   - question_label の update_field が base_order を動かさないこと (末尾の decision 6 節)。
// pin しない範囲 (= ここに書いてある保証は本 file から得られない):
//   - **`localeCompare` への差し替えの検出**。小文字 canonical UUID では ICU 照合順が素比較と
//     一致するため本 file は素通しする (実測確認済)。D-3 の「localeCompare 禁止」は規約 +
//     review が担保しており、機械強制ではない。
//   - **id 生成形の変化の検出**(大文字混在等)。本 file は fixture の id を `randomUUID()` で
//     自作しており、本番の id 生成経路を通らない。なお大文字が混ざると素比較と localeCompare は
//     実際に乖離する (= 前提が崩れるのはこちら側)。
//   - **server が実際にこの句を発行すること**。本 file は SQL を literal で持つだけで
//     `lib/exams/list.ts` の `.orderBy(...)` とは結ばれておらず、そちらの変更は検出しない。
//   - 並走採番の結果どういう base_order 分布になるか(= 仕様であって順序契約の外)。
//   - `getCardsForExam` が SELECT 句に base_order を含めること(型検査の担当)。

import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import { compareByBaseOrder } from '@/lib/cards/domain/card-order'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'

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

beforeEach(async () => {
  await truncateAllUserTables()
  fx = await seedTwoTenants()
})

const FSRS = initialFsrsState(new Date('2026-08-14T00:00:00.000Z'))

type Row = { id: string; base_order: number }

/**
 * 決定的な base_order 列を作る。**重複を 2 組意図的に混ぜる** — 重複こそが id tiebreak
 * を発火させる唯一の入力で、そこが server/client でズレると表示順が環境依存になる。
 */
function makeRows(count: number): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    // 5 の倍数の位置で 1 つ前と同値にする → 重複ペアが複数できる。
    const baseOrder = (i % 5 === 0 && i > 0 ? i : i + 1) * 1024
    rows.push({ id: randomUUID(), base_order: baseOrder })
  }
  return rows
}

async function insertCards(userId: string, examId: string, rows: Row[]): Promise<void> {
  // seedTwoTenants が exam に 1 枚 card を作るため、先に空にしてから入れる
  // (対象 exam の中身を本 test が完全に決めていないと「一致した」の意味が濁る)。
  await getFixtureOwnerDb().execute(sql`DELETE FROM cards WHERE exam_id = ${examId}`)
  // seed は owner 接続 (RLS bypass)。刺激ではなく前提の作り込みなので既存 iso の
  // 使い分け原則どおり owner で入れる。
  await getFixtureOwnerDb()
    .insert(cards)
    .values(
      rows.map((r) => ({
        id: r.id,
        userId,
        examId,
        title: 'T',
        questionLabel: null,
        baseOrder: r.base_order,
        questionText: 'Q?',
        options: [],
        correctAnswerIds: [],
        ...FSRS,
      })),
    )
}

describe('order agreement: server ORDER BY vs client comparator', () => {
  it('50 行(重複 base_order 込み)で PG の `ORDER BY base_order, id` と compareByBaseOrder が完全一致する', async () => {
    const rows = makeRows(50)
    // 重複が実際に入っていること自体を先に確かめる(入力が退化していたら
    // 「一致した」に意味が無くなる)。
    const distinct = new Set(rows.map((r) => r.base_order))
    expect(distinct.size).toBeLessThan(rows.length)

    await insertCards(fx.a.userId, fx.a.examId, rows)

    const pgOrder = await getFixtureOwnerDb().execute<{ id: string }>(
      sql`SELECT id FROM cards WHERE exam_id = ${fx.a.examId} ORDER BY base_order, id`,
    )
    const jsOrder = [...rows].sort(compareByBaseOrder)

    expect(pgOrder.map((r) => r.id)).toEqual(jsOrder.map((r) => r.id))
  })

  it('全件が同一 base_order でも一致する(tiebreak だけで全順序が決まる極端形)', async () => {
    const rows = Array.from({ length: 20 }, () => ({ id: randomUUID(), base_order: 1024 }))
    await insertCards(fx.a.userId, fx.a.examId, rows)

    const pgOrder = await getFixtureOwnerDb().execute<{ id: string }>(
      sql`SELECT id FROM cards WHERE exam_id = ${fx.a.examId} ORDER BY base_order, id`,
    )
    expect(pgOrder.map((r) => r.id)).toEqual([...rows].sort(compareByBaseOrder).map((r) => r.id))
  })

  it('uuid の文字列比較が PG の uuid byte order と一致する(spec D-3 の前提そのもの)', async () => {
    const ids = Array.from({ length: 30 }, () => randomUUID())
    const pgSorted = await getFixtureOwnerDb().execute<{ id: string }>(
      sql`SELECT u AS id FROM unnest(${sql.raw(
        `ARRAY[${ids.map((i) => `'${i}'`).join(',')}]::uuid[]`,
      )}) AS u ORDER BY u`,
    )
    const jsSorted = [...ids].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
    expect(pgSorted.map((r) => r.id)).toEqual(jsSorted)
  })
})

// ---------------------------------------------------------------------------
// spec 決定 6: 番号ラベルの編集で行は動かない
// ---------------------------------------------------------------------------
// card-field-handlers の unit は SET 句の**形**を assert する(ORM 生成形に依存)。
// こちらは実 PG で「編集前後の base_order が同値」という**仕様そのもの**を見るので、
// handler の実装形式が変わっても保証が残る。
describe('question_label の update_field は base_order を動かさない (spec 決定 6)', () => {
  it('編集前後で base_order が不変(既定順は変わらない)', async () => {
    const cardId = randomUUID()
    await insertCards(fx.a.userId, fx.a.examId, [{ id: cardId, base_order: 7168 }])

    const applied = await asTenant(fx.a.userId, (tx) =>
      CARD_FIELD_HANDLERS.question_label(tx, cardId, fx.a.userId, '問99'),
    )
    expect(applied).toBe('applied')

    const after = await getFixtureOwnerDb().execute<{
      base_order: number
      question_label: string | null
    }>(sql`SELECT base_order, question_label FROM cards WHERE id = ${cardId}`)
    expect(after[0]!.question_label).toBe('問99')
    expect(after[0]!.base_order).toBe(7168)
  })
})
