// tag (category / option) D&D 並べ替え後の sort_key 差分計算 純関数。
// 引数 orderedIds の並び順で当該 list 全件を '0','1',…,'N-1' (0-based 整数文字列) に正規化し、
// 既存値 (`currentSortKeys.get(id) ?? null`) と異なる entity のみ updates として返す
// (Tag-4c-2b §4.2)。
//
// 不変条件の繋がり: 本関数が書き込む sort_key は常に有効数値 '0'..'N-1' であり、
// `lib/tags/sort-comparator.ts` の `sortByKeyThenCreated` (有効数値=順序の母数 /
// null・undefined・非数値・空文字列=末尾) と整合する値域だけを生成する。 reindex 後の list は
// 当該 list 内で必ず数値順で表示される。
//
// 同順 drag (= 既存並びをそのまま離した場合) の semantics: 全 id について
// `previousKey === nextKey` となるため戻り値は空配列、 呼出側は updates.length === 0 で
// Dexie tx 自体を skip して IDB 書込 / entity_mutations enqueue を起こさない (副作用ゼロ、
// 不要な outbox enqueue 抑止)。
//
// 副作用ゼロ + dnd-kit 非依存の純関数として manager 側 (今後 Tag-4c-2c) からも import 可能な
// 形に保つ (popover 固有の前提を持ち込まない)。

/**
 * sortable list を新順序で並べ替えた結果、 sort_key を更新すべき entity の差分を返す。
 *
 * @param orderedIds drag 後の表示順 (先頭が `'0'`、 末尾が `'N-1'` になる)
 * @param currentSortKeys 既存 sort_key map (id → string | null | undefined)。
 *   未登録 id は `get → undefined` 扱いで、 `?? null` 経由で `previousKey = null` として扱う。
 * @returns `previousKey !== nextKey` の entity だけを含む `{ id, sort_key }` 配列。
 *   同順 drag や既に '0'..'N-1' に正規化済の list は空配列を返す (no-op)。
 */
export function reindexSortKeys(
  orderedIds: string[],
  currentSortKeys: ReadonlyMap<string, string | null | undefined>,
): { id: string; sort_key: string }[] {
  const updates: { id: string; sort_key: string }[] = []
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]!
    const next = String(i)
    const prev = currentSortKeys.get(id) ?? null
    if (prev !== next) updates.push({ id, sort_key: next })
  }
  return updates
}
