// card-tag-constraint — card の card_tags 集合が single カテゴリ制約に違反するかを
// 判定する純粋 domain module。 F3-R5 (additive): card-field-handlers.ts の A-1 判定を
// verbatim 抽出して所在整理する (配線は R6・現状は handler 内の inline 定義が正)。
//
// PURE 制約 (lib/cards domain 前例): SelectType は import type のみで持ち込み、
// runtime import はゼロ。 zod / drizzle / next / Dexie / React / @/lib/db は import しない。

import type { SelectType } from '@/lib/tags/domain/tag-values'

/**
 * card の card_tags 集合が single カテゴリ制約に違反するか判定する pure 述語。
 * (card-field-handlers.ts の A-1 判定を verbatim 抽出。single 制約は Card 所有 = 判断 3。)
 *
 * 入力契約: assigned / categories は呼び出し側で owner-scope + 存在検証済みの前提
 * (未検証入力の防御分岐は domain に持たない — 検証は handler 責務・spec §3.2)。
 *
 * @param assigned  この card に付与される option の {categoryId}[]（重複排除済み valid 集合）
 * @param categories assigned が属する category の {id, selectType}[]
 * @returns single カテゴリに 2 個以上の option が含まれれば true
 */
export function hasSingleCategoryOverflow(
  assigned: ReadonlyArray<{ categoryId: string }>,
  categories: ReadonlyArray<{ id: string; selectType: SelectType }>,
): boolean {
  const countByCategory = new Map<string, number>()
  for (const a of assigned) {
    countByCategory.set(a.categoryId, (countByCategory.get(a.categoryId) ?? 0) + 1)
  }
  return categories.some(
    (c) => c.selectType === 'single' && (countByCategory.get(c.id) ?? 0) >= 2,
  )
}
