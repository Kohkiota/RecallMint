// tag (category / option) 表示順 comparator: sort_key 数値昇順 + tiebreak created_at ASC。
// popover (CardTagAddPopover / CardTagEditPopover) と manager (/app/tags) が同 IDB を同 comparator
// で読むことで、 「どちらで並べ替えても両画面が同じ並びを共有」 を成立させる共有 module
// (Tag-4c-2b §4.6, Rev1)。
//
// 不変条件: 有効数値 (Number 変換で finite) のみを順序の母数とし、 null / undefined / 非数値
// 文字列はすべて末尾に並べる。 後続 task T2.7 で実装する `nextSortKey` (末尾採番 helper) も
// この不変条件 (= 有効数値だけを母数に max + 1、 null/非数値は数えない) と整合し、 両 helper で
// sort_key 群の integrity を共有する。
// flicker 防止依存: drag drop 直後 `arrayMove` で構築した新順序が `'0','1',…,'N-1'` で mirror
// 書込された後、 Dexie useLiveQuery 経由で再 emit された list を popover が再 render 時に本
// comparator で再ソートする。 再ソート順が arrayMove 順と一致する不変条件は本 comparator の
// 数値比較に依存する (spec §4.6 末尾節 = 旧 string `<` 比較だと N≥10 で `'10' < '2'` で順序が
// ガクっと入れ替わる flicker が起き得る)。

/**
 * sort_key 数値昇順 (NaN / null / undefined は末尾)、 同位は created_at ASC (string 比較。
 * ISO 8601 lexicographic = 時系列で現行踏襲)。
 */
export function sortByKeyThenCreated<
  T extends { sort_key?: string | null; created_at: string },
>(a: T, b: T): number {
  // Number(null) === 0 を踏まない明示 NaN 化。 Number('') も 0 ではなく NaN にしたいが
  // JS は Number('') === 0 のため、 空文字列は別途末尾扱いにする。
  const an =
    a.sort_key === null || a.sort_key === undefined || a.sort_key === ''
      ? NaN
      : Number(a.sort_key)
  const bn =
    b.sort_key === null || b.sort_key === undefined || b.sort_key === ''
      ? NaN
      : Number(b.sort_key)
  const aValid = !Number.isNaN(an)
  const bValid = !Number.isNaN(bn)
  if (aValid && bValid) {
    if (an !== bn) return an < bn ? -1 : 1
  } else if (aValid) {
    return -1 // a は数値、 b は NaN/null → a 先 (NULLS LAST)
  } else if (bValid) {
    return 1
  }
  // 両方 NaN/null/undefined or 同 sort_key: created_at ASC
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}
