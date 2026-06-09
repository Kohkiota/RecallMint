// tag (category / option) 新規作成時の末尾採番 helper。 起点は '0' (0-based)。
// 既存 sort_key 群から有効数値のみを母数として max(Number(v)) + 1 の整数文字列を返す。
//
// 起点 '0' の根拠 (Tag-4c-2b §4.7): D&D 並べ替え後の reindex (`reindexSortKeys`,
// `lib/tags/reindex-sort-keys.ts`) が当該 list 全件を `'0'..'N-1'` に正規化するため、
// 末尾採番の起点も 0-based に揃えることで「新規作成 → 末尾追加 → reindex 後の値域とも整合」
// が成立する。 また `lib/tags/sort-comparator.ts` の `sortByKeyThenCreated` 不変条件
// (有効数値=順序母数 / null・undefined・非数値・空文字=末尾) と integrity を共有する
// (有効数値のみを母数に max + 1、 null/非数値は母数から除外)。
//
// 既存 `lib/cards/next-card-sort-key.ts` (card 用、 起点 '1' + 非数値 fallback あり) とは
// 意味論が異なるため、 共通化せず別 helper として保持する (card sort_key は自由度を許容する
// fallback ありの採番、 tag sort_key は本 sprint 以降 0-based 整数のみの値域で運用)。

/**
 * 既存 sort_key 群から末尾採番した整数文字列を返す。
 *
 * @param existing 既存 sort_key 配列 (`string | null | undefined` を許容)。
 *   有効数値 = `Number(v)` が有限数 (NaN でない)、 かつ `v` が `null`/`undefined`/空文字 (`''`)
 *   ではないもののみを母数とする。 `null` / `undefined` / `''` / 非数値文字列 (`'abc'`) は
 *   母数から除外する (`Number(null) === 0` / `Number('') === 0` を踏まない明示処理)。
 * @returns 有効数値があれば `String(max + 1)`、 母数が空なら起点 `'0'`。
 *   戻り値は常に整数文字列 (sort_key TEXT 列、 spec §3 確認済)。
 */
export function nextSortKey(existing: (string | null | undefined)[]): string {
  let max = -1
  let hasValid = false
  for (const v of existing) {
    // null / undefined / 空文字列は母数除外 (Number(null) === 0 / Number('') === 0 を踏まない)
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    if (n > max) max = n
    hasValid = true
  }
  if (!hasValid) return '0'
  return String(max + 1)
}
