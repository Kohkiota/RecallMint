// Dash-1 Home v1 Task 8: `getWeakTagsSummary` (spec §10 の SQL 契約) の behavioral 実証。
//
// なぜ実 PG が要るか: 契約の全体が SQL の中にあり (window 関数による card 単位の全期間
// 番号付け / timestamptz 比較 / round / uuid の text 順 / cards 削除の cascade)、
// mock では 1 つも検証できない。
//
// 本 file が pin する範囲:
//   - 候補条件の両側境界 (対象カード 7/8・直近 30 日の復習イベント 14/15)
//   - 30 暦日窓の両側境界 (開始 instant ちょうどは入る / その 1 秒前は入らない)
//   - 初見 (card ごとの 1 件目) が分母・分子に入らないこと。**番号付けが全期間**で
//     行われること (窓の外に初見がある構成で、窓内番号付けなら候補が落ちる)
//   - 同時刻 event の初見判定が `event_id` 昇順で決まること
//   - applied = false が集計に入らないこと
//   - 複数タグが付いたカードが各タグへ重複算入されること (定義 doc §4-P)
//   - 同率判定の第 1 キーが **round 後の整数** であること (生の比率ではない)
//   - 同率の決定的順位 (対象カード数 降順 → option_id の text 昇順)
//   - 正答率昇順 + Top N (= WEAK_TAG_TOP_N) 打ち切り
//   - 試験スコープ (同 owner の別試験のカードが混ざらない) と他 owner の exam_id → 空
//   - カード削除で当該カードの履歴が集計から落ちる (spec §13.1 pin 13)
//
// pin しない範囲 (= 本 file から得られない保証):
//   - HTTP 層 (401/400/500/no-store/echo) — route unit の担当。
//   - `thirtyDayWindowStart` 自体の暦計算 — unit (weekly.test.ts) の担当。本 file は
//     その戻り値と SQL の比較演算子 (`>=`) の噛み合いだけを見る。
//   - 削除で「消える」ことの検出力の所在: card_tags は card_id ON DELETE CASCADE な
//     ので、削除で集計から落ちる主因は **schema の cascade** であり、query 側の変異
//     では red にならない。ただしこれは穴ではない — cascade が効く限り card_tags 行が
//     消えるので、`tagged` をどう書いても当該カードは寄与できない (= 除外を落とす
//     regression の形が存在しない)。逆に **`cards` が soft delete 化されたら** §3.3a は
//     壊れるのに本 test は green のまま通る (それが唯一の盲点)。
//
// 刺激 = asTenant (app role + tenant context)。観測 = 戻り値。seed は owner 接続。
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import { thirtyDayWindowStart } from '@/lib/dashboard/domain/weekly'
import { closeDb } from '@/lib/db'
import {
  answerEvents,
  cardTags,
  cards,
  exams,
  tagOptions,
} from '@/lib/db/schema'
import { getWeakTagsSummary } from '@/lib/db/weak-tags-summary'

import { asTenant } from './setup/as-tenant'
import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
  type TenantFixture,
} from './setup/fixture'

// JST 2026-08-19 12:00。窓 = 2026-07-21〜2026-08-19 の 30 暦日。
const NOW = new Date('2026-08-19T03:00:00.000Z')
// 窓開始の期待値をベタ書きする (helper と同じ関数で計算すると helper のバグを
// 見逃すため)。下の describe で thirtyDayWindowStart(NOW) との一致も pin する。
const WINDOW_START = new Date('2026-07-20T15:00:00.000Z')
// 初見イベントは窓の**外**に置く。これにより「窓の内側で番号付けした」実装は
// 窓内の 1 件目を初見と誤認し、復習イベント数が cardCount 分だけ目減りする。
const FIRST_AT = new Date('2026-06-01T00:00:00.000Z')
// 復習イベントの基準時刻 (窓の内側)。
const REVIEW_FROM = new Date('2026-08-10T00:00:00.000Z')
const FSRS = initialFsrsState(NOW)

let fx: TenantFixture

beforeEach(async () => {
  await truncateAllUserTables()
  fx = await seedTwoTenants()
})

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

interface EventSpec {
  cardId: string
  at: Date
  isCorrect: boolean
  applied?: boolean
  /** 同時刻 event の順序を決める uuid を明示したいときだけ指定する。 */
  eventId?: string
}

async function insertEvents(userId: string, specs: EventSpec[]): Promise<void> {
  if (specs.length === 0) return
  await getFixtureOwnerDb()
    .insert(answerEvents)
    .values(
      specs.map((s) => ({
        eventId: s.eventId ?? randomUUID(),
        userId,
        cardId: s.cardId,
        sessionId: randomUUID(),
        isCorrect: s.isCorrect,
        rating: (s.isCorrect ? 3 : 1) as 1 | 3,
        answeredAt: s.at,
        applied: s.applied ?? true,
        // CHECK answered_at <= created_at。全 event が NOW 以前。
        createdAt: NOW,
      })),
    )
}

async function insertCards(
  userId: string,
  examId: string,
  count: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID())
  await getFixtureOwnerDb()
    .insert(cards)
    .values(
      ids.map((id, i) => ({
        id,
        userId,
        examId,
        title: `C${i}`,
        baseOrder: 1024 * (i + 1),
        questionText: 'Q?',
        options: [
          { id: 'a', uid: randomUUID(), text: 'a', is_correct: true },
          { id: 'b', uid: randomUUID(), text: 'b', is_correct: false },
        ],
        correctAnswerIds: ['a'],
        ...FSRS,
      })),
    )
  return ids
}

interface TagSpec {
  userId: string
  examId: string
  categoryId: string
  optionId?: string
  name: string
  cardCount: number
  /** 窓内に置く復習イベント数 (card 群へ round-robin で配る)。 */
  reviewCount: number
  /** そのうち正答の件数 (先頭から)。 */
  correctReviews: number
  /** 初見イベントの正誤 (既定 = 誤答: 混入したら正答率が動く)。 */
  firstCorrect?: boolean
  /** 初見イベントの基準時刻 (既定 = 窓の外)。 */
  firstAt?: Date
}

/** タグ 1 件 + そのタグが付いた cardCount 枚 + 初見/復習イベントを seed する。 */
async function seedTag(spec: TagSpec): Promise<{ optionId: string; cardIds: string[] }> {
  const optionId = spec.optionId ?? randomUUID()
  await getFixtureOwnerDb().insert(tagOptions).values({
    id: optionId,
    userId: spec.userId,
    categoryId: spec.categoryId,
    name: spec.name,
  })
  const cardIds = await insertCards(spec.userId, spec.examId, spec.cardCount)
  await getFixtureOwnerDb()
    .insert(cardTags)
    .values(cardIds.map((cardId) => ({ cardId, optionId, userId: spec.userId })))

  const firstAt = spec.firstAt ?? FIRST_AT
  const events: EventSpec[] = cardIds.map((cardId, i) => ({
    cardId,
    at: new Date(firstAt.getTime() + i * 1000),
    isCorrect: spec.firstCorrect ?? false,
  }))
  for (let j = 0; j < spec.reviewCount; j++) {
    events.push({
      cardId: cardIds[j % cardIds.length],
      at: new Date(REVIEW_FROM.getTime() + j * 60_000),
      isCorrect: j < spec.correctReviews,
    })
  }
  await insertEvents(spec.userId, events)
  return { optionId, cardIds }
}

function run(userId: string, examId: string) {
  return asTenant(userId, (tx) => getWeakTagsSummary(userId, examId, tx, NOW))
}

describe('getWeakTagsSummary — 窓の前提', () => {
  it('30 暦日窓の開始は 2026-07-20T15:00Z (= JST 2026-07-21 00:00)', () => {
    expect(thirtyDayWindowStart(NOW).toISOString()).toBe(
      WINDOW_START.toISOString(),
    )
  })
})

describe('getWeakTagsSummary — 候補条件の境界', () => {
  it('対象カード 8 枚 + 復習 15 件 → 候補 (正答率は round された整数)', async () => {
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 7, // 7/15 = 46.66… → 47
    })
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: '循環器',
      category_name: 'Cat A', // fixture の category 名 (現在値をそのまま返す — §3.5)
      review_accuracy: 47,
      card_count: 8,
    })
  })

  it('対象カード 7 枚 (復習は 15 件) → 候補にならない', async () => {
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 7,
      reviewCount: 15,
      correctReviews: 7,
    })
    expect(await run(fx.a.userId, fx.a.examId)).toEqual([])
  })

  it('復習 14 件 (カードは 8 枚) → 候補にならない', async () => {
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 14,
      correctReviews: 7,
    })
    expect(await run(fx.a.userId, fx.a.examId)).toEqual([])
  })
})

describe('getWeakTagsSummary — 30 暦日窓の境界', () => {
  // 窓内 14 件 + 境界に 1 件。境界イベントが入れば 15 件 = 候補、入らなければ 14 件。
  async function seedWithBoundaryEvent(boundaryAt: Date): Promise<void> {
    const { cardIds } = await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 14,
      correctReviews: 14,
    })
    // 既に初見 + 復習を持つカードへ足すので、この 1 件も seq >= 2 (= 復習)。
    await insertEvents(fx.a.userId, [
      { cardId: cardIds[0], at: boundaryAt, isCorrect: true },
    ])
  }

  it('窓の開始 instant ちょうどのイベントは入る (>= 境界)', async () => {
    await seedWithBoundaryEvent(WINDOW_START)
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.review_accuracy).toBe(100)
  })

  it('窓の開始 1 秒前のイベントは入らない', async () => {
    await seedWithBoundaryEvent(new Date(WINDOW_START.getTime() - 1000))
    expect(await run(fx.a.userId, fx.a.examId)).toEqual([])
  })
})

describe('getWeakTagsSummary — 初見 / applied の除外', () => {
  it('初見 (card ごとの 1 件目) は分母にも分子にも入らない', async () => {
    // 初見 8 件を窓の**内側**に置き、全て誤答にする。窓で切っただけで初見を除外
    // していない実装なら 15/23 = 65% になる。
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 15,
      firstAt: new Date(REVIEW_FROM.getTime() - 3_600_000),
    })
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.review_accuracy).toBe(100)
  })

  it('同時刻 event の初見判定は event_id 昇順で決まる', async () => {
    // 各カードの最古が **同一 instant の 2 件** だけ、という構成にする。ここでのみ
    // row_number() の 2 段目 (event_id ASC) が「どちらが初見か」を分ける。
    // 低い uuid = 誤答 / 高い uuid = 正答 に固定してあるので:
    //   ASC  → 低い方 (誤答) が seq 1 = 初見として落ち、残る復習は全て正答 → 100%
    //   DESC → 高い方 (正答) が落ち、残るのは誤答だけ → 0%
    // 15 枚 × 1 復習で復習イベント数 15 (閾値ちょうど)・対象カード 15 枚。
    const optionId = randomUUID()
    await getFixtureOwnerDb().insert(tagOptions).values({
      id: optionId,
      userId: fx.a.userId,
      categoryId: fx.a.tagCategoryId,
      name: '同時刻',
    })
    const cardIds = await insertCards(fx.a.userId, fx.a.examId, 15)
    await getFixtureOwnerDb()
      .insert(cardTags)
      .values(cardIds.map((cardId) => ({ cardId, optionId, userId: fx.a.userId })))
    const tie = new Date(REVIEW_FROM.getTime() + 300_000)
    await insertEvents(
      fx.a.userId,
      cardIds.flatMap((cardId, i) => {
        const suffix = String(i).padStart(12, '0')
        return [
          {
            cardId,
            at: tie,
            isCorrect: false,
            eventId: `00000000-0000-4000-8000-${suffix}`,
          },
          {
            cardId,
            at: tie,
            isCorrect: true,
            eventId: `ffffffff-0000-4000-8000-${suffix}`,
          },
        ]
      }),
    )
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.card_count).toBe(15)
    expect(rows[0]?.review_accuracy).toBe(100)
  })

  it('applied = false のイベントは集計に入らない', async () => {
    const { cardIds } = await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 0, // 正答率 0%
    })
    // 未適用の正答を 10 件足す。集計に入れば 10/25 = 40% になる。
    await insertEvents(
      fx.a.userId,
      Array.from({ length: 10 }, (_, i) => ({
        cardId: cardIds[i % cardIds.length],
        at: new Date(REVIEW_FROM.getTime() + 3_600_000 + i * 1000),
        isCorrect: true,
        applied: false,
      })),
    )
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.review_accuracy).toBe(0)
  })
})

describe('getWeakTagsSummary — 順位', () => {
  it('正答率 昇順 + Top 3 打ち切り', async () => {
    const accuracies: Array<[string, number]> = [
      ['A20', 3],
      ['B40', 6],
      ['C60', 9],
      ['D80', 12],
    ]
    for (const [name, correct] of accuracies) {
      await seedTag({
        userId: fx.a.userId,
        examId: fx.a.examId,
        categoryId: fx.a.tagCategoryId,
        name,
        cardCount: 8,
        reviewCount: 15,
        correctReviews: correct,
      })
    }
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows.map((r) => r.name)).toEqual(['A20', 'B40', 'C60'])
    expect(rows.map((r) => r.review_accuracy)).toEqual([20, 40, 60])
  })

  it('同率は 対象カード数 降順 (option_id 昇順より優先)', async () => {
    // id は「option_id 昇順」なら few (a…) が先に来る並びにしておく。
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      optionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      name: 'few',
      cardCount: 8,
      reviewCount: 16,
      correctReviews: 8, // 50%
    })
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      optionId: 'ffffffff-0000-4000-8000-000000000002',
      name: 'many',
      cardCount: 9,
      reviewCount: 16,
      correctReviews: 8, // 50%
    })
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows.map((r) => r.name)).toEqual(['many', 'few'])
    expect(rows.map((r) => r.card_count)).toEqual([9, 8])
  })

  it('同率判定は round 後の整数で行う (生の比率では並びが逆になる構成)', async () => {
    // X = 7/15 = 46.66…% / Y = 8/17 = 47.05…%。round すると **どちらも 47** なので
    // 同率 → 対象カード数 降順で Y(9 枚) → X(8 枚)。生の比率で並べると X < Y で
    // 順序が逆転する。ORDER BY の第 1 キーが「表示値 (round 後)」であることの pin。
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: 'X-46.67',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 7,
    })
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: 'Y-47.06',
      cardCount: 9,
      reviewCount: 17,
      correctReviews: 8,
    })
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows.map((r) => r.review_accuracy)).toEqual([47, 47])
    expect(rows.map((r) => r.name)).toEqual(['Y-47.06', 'X-46.67'])
  })

  it('正答率・カード数とも同値なら option_id の text 昇順', async () => {
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      optionId: 'ffffffff-0000-4000-8000-000000000002',
      name: 'last',
      cardCount: 8,
      reviewCount: 16,
      correctReviews: 8,
    })
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      optionId: '00000000-0000-4000-8000-000000000001',
      name: 'first',
      cardCount: 8,
      reviewCount: 16,
      correctReviews: 8,
    })
    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows.map((r) => r.option_id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      'ffffffff-0000-4000-8000-000000000002',
    ])
  })
})

describe('getWeakTagsSummary — 複数タグの重複算入 (定義 doc §4-P)', () => {
  it('2 つのタグが付いたカードは、両方のタグに同じイベントが算入される', async () => {
    // 同じ 8 枚・同じ 15 復習が P/Q 両方に効く。カードをタグ 1 つに畳む実装
    // (DISTINCT ON (card_id) / タグ優先度で 1 つ選ぶ 等) なら片方が欠ける。
    const { cardIds } = await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      optionId: '00000000-0000-4000-8000-0000000000aa',
      name: 'P',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 7,
    })
    const optionQ = 'ffffffff-0000-4000-8000-0000000000bb'
    await getFixtureOwnerDb().insert(tagOptions).values({
      id: optionQ,
      userId: fx.a.userId,
      categoryId: fx.a.tagCategoryId,
      name: 'Q',
    })
    await getFixtureOwnerDb()
      .insert(cardTags)
      .values(
        cardIds.map((cardId) => ({
          cardId,
          optionId: optionQ,
          userId: fx.a.userId,
        })),
      )

    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows.map((r) => r.name)).toEqual(['P', 'Q'])
    expect(rows.map((r) => r.card_count)).toEqual([8, 8])
    expect(rows.map((r) => r.review_accuracy)).toEqual([47, 47])
  })
})

describe('getWeakTagsSummary — スコープ', () => {
  it('同 owner の別試験のカードは対象カード数にも復習にも混ざらない', async () => {
    const otherExamId = randomUUID()
    await getFixtureOwnerDb()
      .insert(exams)
      .values({ id: otherExamId, userId: fx.a.userId, name: 'Other' })

    const optionId = randomUUID()
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      optionId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 0,
    })
    // 同じタグを別試験の 5 枚にも付け、そちらは全問正答の復習を持たせる。
    const otherCards = await insertCards(fx.a.userId, otherExamId, 5)
    await getFixtureOwnerDb()
      .insert(cardTags)
      .values(otherCards.map((cardId) => ({ cardId, optionId, userId: fx.a.userId })))
    await insertEvents(
      fx.a.userId,
      otherCards.flatMap((cardId, i) => [
        { cardId, at: new Date(FIRST_AT.getTime() + 10_000 + i * 1000), isCorrect: true },
        { cardId, at: new Date(REVIEW_FROM.getTime() + 7_200_000 + i * 1000), isCorrect: true },
      ]),
    )

    const rows = await run(fx.a.userId, fx.a.examId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.card_count).toBe(8)
    expect(rows[0]?.review_accuracy).toBe(0)
  })

  it('他 owner の exam_id → 空 (存在有無を漏らさない)', async () => {
    await seedTag({
      userId: fx.b.userId,
      examId: fx.b.examId,
      categoryId: fx.b.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 0,
    })
    // 自分の試験には候補が居る状態で他 owner の exam_id を尋ねる。scope が緩むと
    // 「空のはずが自分の候補が出る」形で red になる (空 fixture だと vacuous)。
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '自分の候補',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 0,
    })
    expect(await run(fx.a.userId, fx.b.examId)).toEqual([])
  })

  it('実在しない exam_id → 空', async () => {
    await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '自分の候補',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 0,
    })
    expect(await run(fx.a.userId, randomUUID())).toEqual([])
  })
})

describe('getWeakTagsSummary — 削除 (spec §13.1 pin 13)', () => {
  it('カードを削除すると、その履歴ごと集計から落ちる', async () => {
    const { cardIds } = await seedTag({
      userId: fx.a.userId,
      examId: fx.a.examId,
      categoryId: fx.a.tagCategoryId,
      name: '循環器',
      cardCount: 8,
      reviewCount: 15,
      correctReviews: 7,
    })
    const before = await run(fx.a.userId, fx.a.examId)
    expect(before).toHaveLength(1)
    expect(before[0]?.card_count).toBe(8)

    // 本番の card 削除も **cards 行の hard DELETE**
    // (`lib/cards/apply-card-mutation.ts:161-163` — tombstone 追記 + owner-scoped
    // DELETE)。この fixture は本番経路と同じ形の削除を再現している。
    await getFixtureOwnerDb().delete(cards).where(eq(cards.id, cardIds[0]))

    // 対象カードが 7 枚に落ちて候補から外れる。answer_events 側は FK が無いので
    // 行自体は残るが (定義 doc §3.3a)、現存カードとの join から外れて集計に効かない。
    expect(await run(fx.a.userId, fx.a.examId)).toEqual([])
  })
})
