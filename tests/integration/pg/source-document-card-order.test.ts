// Grid-3 Task 3: `getCardsForSourceDocument` の順序再裁定 (spec §4.4 / D-10) を実
// PostgreSQL で pin する。
//
// なぜ実 PG が要るか: 対象は SQL の `ORDER BY` 句そのもの (`.orderBy(cards.examId,
// cards.baseOrder, cards.id)`) の挙動で、mock db では ORDER 句を評価せず並び順を
// 検証できない (list.owner-isolation.test.ts の対応 test は WHERE 引数の pin に
// 留まるのはこのため)。
//
// 本 file が pin する範囲:
//   - card_move の導入で「1 source_document の cards は 1 exam に閉じる」前提が崩れた
//     後 (= 同一 source_document の cards が 2 exam に跨る状態) でも、
//     `getCardsForSourceDocument` が `(exam_id, base_order, id)` 順で返すこと。
// pin しない範囲:
//   - `getCardsForExam` (WHERE に exam_id 等価があり本変更の影響を受けない・不触)。
//   - snippet / optionCount の導出 (list.owner-isolation.test.ts が mock で pin 済)。

import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards, exams } from '@/lib/db/schema'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import { getCardsForSourceDocument } from '@/lib/exams/list'

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

async function insertCard(
  userId: string,
  examId: string,
  sourceDocumentId: string,
  baseOrder: number,
): Promise<string> {
  const id = randomUUID()
  await getFixtureOwnerDb()
    .insert(cards)
    .values({
      id,
      userId,
      examId,
      sourceDocumentId,
      title: `T${baseOrder}`,
      baseOrder,
      questionText: 'Q?',
      options: [],
      correctAnswerIds: [],
      ...FSRS,
    })
  return id
}

describe('getCardsForSourceDocument: 順序 = (exam_id, base_order, id) (Grid-3 spec §4.4 / D-10)', () => {
  it('1 source_document の cards が 2 exam に跨っても exam でグループ化 → 各 exam 内は基準順で返る', async () => {
    // seed 済 card (fx.a.cardId) はこの source_document に紐づく既定 1 枚。本 test は
    // 対象集合を完全に自分で決めるため、先に空にしてから入れる (card-order-agreement
    // 同様の原則)。
    await getFixtureOwnerDb()
      .execute(sql`DELETE FROM cards WHERE source_document_id = ${fx.a.sourceDocumentId}`)

    // 移動先の 2 つ目の exam (同一 user)。card_move は exam_id のみ動かし
    // source_document_id には触れない (spec 1.1-8) ため、移動後は 1 source_document の
    // cards が複数 exam に散った状態になる — それをここで直接作る。
    const examB = randomUUID()
    await getFixtureOwnerDb()
      .insert(exams)
      .values({ id: examB, userId: fx.a.userId, name: 'Exam A2' })

    // どちらの exam_id が文字列比較で小さいかを先に確定し、その役に応じて
    // base_order を意図的に「exam 境界をまたいで上下する」配置にする。
    // 具体的には exam グループ化した期待順で base_order 列を並べると
    // [1024, 3072, 1024, 3072] という非単調列になる — これは `ORDER BY base_order, id`
    // (exam_id 抜き) の結果が必ず base_order 昇順の単調列になることと構造的に矛盾するため、
    // exam_id を ORDER BY から外す変異は uuid 値によらず必ず red になる。
    const [examLow, examHigh] =
      fx.a.examId < examB ? [fx.a.examId, examB] : [examB, fx.a.examId]

    const lowSmall = await insertCard(fx.a.userId, examLow, fx.a.sourceDocumentId, 1024)
    const lowLarge = await insertCard(fx.a.userId, examLow, fx.a.sourceDocumentId, 3072)
    const highSmall = await insertCard(fx.a.userId, examHigh, fx.a.sourceDocumentId, 1024)
    const highLarge = await insertCard(fx.a.userId, examHigh, fx.a.sourceDocumentId, 3072)

    const result = await asTenant(fx.a.userId, (tx) =>
      getCardsForSourceDocument(fx.a.userId, fx.a.sourceDocumentId, tx),
    )

    expect(result.map((r) => r.id)).toEqual([lowSmall, lowLarge, highSmall, highLarge])
  })
})
