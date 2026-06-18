// build-next-tag-set — toggle 後の次の option_id セットを計算する純粋関数。
//
// Grid-2 T4: 旧 card-tags-section.tsx:67 のローカル定義をそのまま切り出して共有 module 化。
// 単票 (use-card-tag-toggle) と bulk helper (use-bulk-card-tags) で 1 つの toggle ロジックを共有する。
// card-tags-section.tsx は本 module から re-export し、 既存 importer / 既存 test の import path を保つ。
//
// ロジックは移設前と 1 文字も変えていない (純粋移設、 単票挙動完全不変)。

import { type ClientTagCategory } from '@/lib/client-db'

/**
 * toggle 後の次の option_id セットを計算する純粋関数。
 * whole-set 不変条件 (他カテゴリ落とし回避) を保証する。
 *
 * @param category - toggle 対象カテゴリ (select_type で multi/single を判定)
 * @param allAssignedOptionIds - 本 card 全カテゴリ横断の現在の付与済み option_id 配列
 * @param sameCategoryOptionIds - 同カテゴリに属する全 option_id の集合 (Set)
 * @param clickedOptionId - toggle する option_id
 * @returns { next: 次の全付与済み option_id 配列, toAdd: 追加する id 配列, toRemove: 削除する id 配列 }
 */
export function buildNextTagSet(
  category: Pick<ClientTagCategory, 'select_type'>,
  allAssignedOptionIds: string[],
  sameCategoryOptionIds: Set<string>,
  clickedOptionId: string,
): { next: string[]; toAdd: string[]; toRemove: string[] } {
  const oldSet = new Set(allAssignedOptionIds)
  const newSet = new Set(allAssignedOptionIds)

  if (category.select_type === 'multi') {
    if (newSet.has(clickedOptionId)) newSet.delete(clickedOptionId)
    else newSet.add(clickedOptionId)
  } else {
    // single: 同カテゴリ既存 clear → 元々付いてなければ add (入れ替え) /
    // 元々付いてたら add せず 0 個に戻る
    const wasAssigned = oldSet.has(clickedOptionId)
    for (const id of sameCategoryOptionIds) newSet.delete(id)
    if (!wasAssigned) newSet.add(clickedOptionId)
  }

  const toAdd: string[] = []
  const toRemove: string[] = []
  for (const id of newSet) if (!oldSet.has(id)) toAdd.push(id)
  for (const id of oldSet) if (!newSet.has(id)) toRemove.push(id)

  return { next: [...newSet], toAdd, toRemove }
}
