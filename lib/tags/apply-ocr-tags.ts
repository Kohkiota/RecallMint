// apply-ocr-tags — OCR が discover mode で抽出する custom_props を tag マスタ
// (tag_categories / tag_options / card_tags) に分解書込する server-only helper。
// process.ts (cards INSERT tx) から呼ばれ、 cards INSERT と同 tx で atomic に動く。
//
// 設計方針 (spec 2026-06-15-tag-3-design.md):
// - find-or-create 2 段 + ON CONFLICT DO NOTHING + 再 SELECT (§3.1)
//   既存 row hit は failed ではなく id 回収して再利用。 UNIQUE(category_id, name) race は
//   正常系 (rollback トリガーにしない、 spec §4)。 予期せぬ DB error のみ throw で tx 巻込。
// - per-upload Map で同名集約 (§3.2): 5 cards が同 '年度=2024' でも option は 1 INSERT。
//   Map key 区切りは ASCII US (`\x1f`) で固定 (NUL は git binary 誤判定回避)。
// - sort_key は nextSortKey 起点 + in-memory 累積 (§3.3、 manual race drift は受容)。
// - 新規 default: category select_type='multi' / color=null、 option color=null
//   (§3.4)、 sort_key は同 group 内末尾累積。
// - apply-tag-mutation.ts は再利用しない (id-specified / 衝突=failed セマンティクスが異なる、
//   spec §6.1)。

import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import { cardTags, tagCategories, tagOptions } from '@/lib/db/schema'
import { newId } from '@/lib/sync/new-id'
import { nextSortKey } from './next-sort-key'

// 同 upload 内 (category_id, trim(name)) Map の key separator。 ASCII US (Unit Separator)。
// NUL は git binary 誤判定があるため不使用 (commit 1492e24 教訓)。
const PAIR_SEP = String.fromCharCode(0x1f)

export type ExtractedCardWithId = {
  id: string
  custom_props?: Record<string, string | string[]>
}

/**
 * OCR の custom_props を tag_categories / tag_options / card_tags に分解書込する。
 *
 * 失敗時は throw で呼び出し元 tx を巻き込む (spec §4 atomic)。 UNIQUE(category_id, name)
 * race は ON CONFLICT DO NOTHING で握り、 再 SELECT で id 回収する正常系 (rollback しない)。
 */
export async function applyOcrTags(
  tx: DbExecutor,
  userId: string,
  cards: ExtractedCardWithId[],
): Promise<void> {
  // -------------------------------------------------------------------------
  // 0. custom_props を per-upload で集約。 空文字 / 空白のみ key/value は skip。
  // -------------------------------------------------------------------------
  // categoryNames: 入力 OCR 全体で出現した category 名 (trim 後) の unique 集合。
  // optionsByCategory: category 名 (trim) → option 名 (trim) の unique 集合。
  // cardAssignments: card_id → (category 名 (trim), option 名 (trim)) ペア list。
  const categoryNames = new Set<string>()
  const optionsByCategory = new Map<string, Set<string>>()
  const cardAssignments: { cardId: string; category: string; option: string }[] = []

  for (const card of cards) {
    if (!card.custom_props) continue
    for (const [rawKey, rawVal] of Object.entries(card.custom_props)) {
      const cat = rawKey.trim()
      if (cat === '') continue
      const values = Array.isArray(rawVal) ? rawVal : [rawVal]
      for (const raw of values) {
        const opt = typeof raw === 'string' ? raw.trim() : ''
        if (opt === '') continue
        categoryNames.add(cat)
        if (!optionsByCategory.has(cat)) optionsByCategory.set(cat, new Set())
        optionsByCategory.get(cat)!.add(opt)
        cardAssignments.push({ cardId: card.id, category: cat, option: opt })
      }
    }
  }

  if (categoryNames.size === 0) return

  // -------------------------------------------------------------------------
  // 1. tag_categories find-or-create
  // -------------------------------------------------------------------------
  // Map: trim(name) → category_id
  const categoryByName = new Map<string, string>()

  // Step 1: 既存 SELECT (find)。 user-scope + name IN (...) で 1 回。
  const candidateCats = Array.from(categoryNames)
  const existingCats = await tx
    .select({
      id: tagCategories.id,
      name: tagCategories.name,
      sortKey: tagCategories.sortKey,
    })
    .from(tagCategories)
    .where(
      and(
        eq(tagCategories.userId, userId),
        inArray(tagCategories.name, candidateCats),
      ),
    )

  for (const row of existingCats) {
    categoryByName.set(row.name, row.id)
  }

  // Step 2: 未存在 category を INSERT ... ON CONFLICT DO NOTHING (race 安全)。
  const missingCats = candidateCats.filter((n) => !categoryByName.has(n))
  if (missingCats.length > 0) {
    // sort_key 採番の base = ユーザ全 category 中の最大値。 in-memory に「いま採番した最大」
    // を保持して累積するため、 既存 row も母数に含める (1 回 SELECT で済ます)。 候補 name の
    // 既存 sort_key だけだと manual で作った異名 category の max を取りこぼすため user 全体を
    // 見る。 missing 0 件なら走らせない (find-only path の SELECT 回数 = spec §7 b-ii 契約 2 回)。
    const allCatSortKeys = await tx
      .select({ sortKey: tagCategories.sortKey })
      .from(tagCategories)
      .where(eq(tagCategories.userId, userId))
    let nextCatSort = Number(nextSortKey(allCatSortKeys.map((r) => r.sortKey)))

    const inserts = missingCats.map((name) => {
      const id = newId()
      const sortKey = String(nextCatSort)
      nextCatSort += 1
      categoryByName.set(name, id) // 楽観的 (race ヒット時は Step 3 で上書き)
      return {
        id,
        userId,
        name,
        selectType: 'multi' as const,
        color: null,
        sortKey,
      }
    })
    await tx.insert(tagCategories).values(inserts).onConflictDoNothing()

    // Step 3: PostgreSQL READ COMMITTED + 同 tx 視認性前提。 並走 tx の commit 済 row を
    // 再 SELECT で回収する (spec §3.1)。 「自分の INSERT が DO NOTHING された」 ケースの
    // id 回収。 missing 名のみ再 SELECT。 並走で別 id の row が確定していれば自分の予測 id は
    // 誤りなので上書きする (caller tx 内 INSERT は ROLLBACK されるため孤立 row になる懸念なし)。
    const reselect = await tx
      .select({ id: tagCategories.id, name: tagCategories.name })
      .from(tagCategories)
      .where(
        and(
          eq(tagCategories.userId, userId),
          inArray(tagCategories.name, missingCats),
        ),
      )
    for (const row of reselect) {
      categoryByName.set(row.name, row.id)
    }
  }

  // -------------------------------------------------------------------------
  // 2. tag_options find-or-create
  // -------------------------------------------------------------------------
  // Map key: `${category_id}${US}${trim(name)}` → option_id
  const optionByPair = new Map<string, string>()

  // Step 1: 既存 SELECT。 user-scope + category_id IN (...) + name IN (...) で一括 fetch。
  // category 内の name 不一致 row も返るが、 Map で (category_id, name) ペア一致のみ拾う。
  const categoryIds = Array.from(new Set(categoryByName.values()))
  const optionNames = new Set<string>()
  for (const names of optionsByCategory.values()) {
    for (const n of names) optionNames.add(n)
  }

  // find 用 SELECT。 inArray(name, optionNames) で絞られるため、 「(category_id, name) ペア
  // 一致」 を Map に積むためだけに使う。 sort_key 採番母数としては **不十分** (OCR 候補に
  // 含まれない既存 option を漏らすため)、 採番には allOptsForCats を別途使う。
  const existingOpts = await tx
    .select({
      id: tagOptions.id,
      name: tagOptions.name,
      categoryId: tagOptions.categoryId,
      sortKey: tagOptions.sortKey,
    })
    .from(tagOptions)
    .where(
      and(
        eq(tagOptions.userId, userId),
        inArray(tagOptions.categoryId, categoryIds),
        inArray(tagOptions.name, Array.from(optionNames)),
      ),
    )

  for (const row of existingOpts) {
    optionByPair.set(`${row.categoryId}${PAIR_SEP}${row.name}`, row.id)
  }

  // Step 2: 未存在 option を INSERT ... ON CONFLICT DO NOTHING。
  const missingOpts: { id: string; categoryId: string; name: string; sortKey: string }[] = []
  // missing を計算するために、 まず unique pair 集合を組み立てる (sort_key 採番は missing 有る
  // 時のみ走るため、 母数 SELECT を guard 内に置く前に missing を確定させる必要がある)。
  const missingPairs: { catId: string; optName: string }[] = []
  for (const [catName, optNames] of optionsByCategory) {
    const catId = categoryByName.get(catName)
    if (!catId) continue // 理論上発生しない (Step 1-3 で全 category 名は id を持つ)
    for (const optName of optNames) {
      const key = `${catId}${PAIR_SEP}${optName}`
      if (optionByPair.has(key)) continue
      missingPairs.push({ catId, optName })
    }
  }

  if (missingPairs.length > 0) {
    // category 内 sort_key 末尾累積用の base。 「対象 category 群内の **全** option」 を 1 回
    // 取得して category_id ごとに max を出す。 existingOpts は name IN (...) で絞られるため
    // sort_key 採番母数としては不足する (OCR 候補に無い既存 option を取りこぼす)。 missing 0
    // 件なら走らせない (find-only path の SELECT 回数 = spec §7 b-ii 契約 2 回)。
    const allOptsForCats = await tx
      .select({
        categoryId: tagOptions.categoryId,
        sortKey: tagOptions.sortKey,
      })
      .from(tagOptions)
      .where(
        and(
          eq(tagOptions.userId, userId),
          inArray(tagOptions.categoryId, categoryIds),
        ),
      )
    const allOptSortByCategory = new Map<string, (string | null)[]>()
    for (const row of allOptsForCats) {
      if (!allOptSortByCategory.has(row.categoryId)) {
        allOptSortByCategory.set(row.categoryId, [])
      }
      allOptSortByCategory.get(row.categoryId)!.push(row.sortKey)
    }
    // category ごとの「いま採番した最大」 cursor
    const nextOptSortByCategory = new Map<string, number>()
    for (const catId of categoryIds) {
      const keys = allOptSortByCategory.get(catId) ?? []
      nextOptSortByCategory.set(catId, Number(nextSortKey(keys)))
    }

    for (const { catId, optName } of missingPairs) {
      const id = newId()
      const next = nextOptSortByCategory.get(catId) ?? 0
      const sortKey = String(next)
      nextOptSortByCategory.set(catId, next + 1)
      optionByPair.set(`${catId}${PAIR_SEP}${optName}`, id)
      missingOpts.push({ id, categoryId: catId, name: optName, sortKey })
    }

    await tx
      .insert(tagOptions)
      .values(
        missingOpts.map((m) => ({
          id: m.id,
          userId,
          categoryId: m.categoryId,
          name: m.name,
          color: null,
          sortKey: m.sortKey,
        })),
      )
      .onConflictDoNothing()

    // Step 3: PostgreSQL READ COMMITTED + 同 tx 視認性前提。 並走 tx の commit 済 row を
    // 再 SELECT で回収する (spec §3.1)。 missing pair のみ再 SELECT。
    const missingNames = Array.from(new Set(missingOpts.map((m) => m.name)))
    const missingCatIds = Array.from(new Set(missingOpts.map((m) => m.categoryId)))
    const reselect = await tx
      .select({
        id: tagOptions.id,
        name: tagOptions.name,
        categoryId: tagOptions.categoryId,
      })
      .from(tagOptions)
      .where(
        and(
          eq(tagOptions.userId, userId),
          inArray(tagOptions.categoryId, missingCatIds),
          inArray(tagOptions.name, missingNames),
        ),
      )
    for (const row of reselect) {
      optionByPair.set(`${row.categoryId}${PAIR_SEP}${row.name}`, row.id)
    }
  }

  // -------------------------------------------------------------------------
  // 3. card_tags bulk INSERT
  // -------------------------------------------------------------------------
  // (card_id, option_id) PK で構造的に重複不可。 同 upload 内重複は Set で事前排除。
  const cardTagSet = new Set<string>()
  const cardTagRows: { cardId: string; optionId: string; userId: string }[] = []
  for (const a of cardAssignments) {
    const catId = categoryByName.get(a.category)
    if (!catId) continue
    const optionId = optionByPair.get(`${catId}${PAIR_SEP}${a.option}`)
    if (!optionId) continue
    const pairKey = `${a.cardId}${PAIR_SEP}${optionId}`
    if (cardTagSet.has(pairKey)) continue
    cardTagSet.add(pairKey)
    cardTagRows.push({ cardId: a.cardId, optionId, userId })
  }

  if (cardTagRows.length > 0) {
    // PK (card_id, option_id) 衝突は構造上発生しない (同 upload で cardTagSet 排除済 + 既存
    // card の card_tags は OCR 新規 card 作成経路のため不可触)。 spec §6.1 「ON CONFLICT 不要」。
    await tx.insert(cardTags).values(cardTagRows)
  }
}
