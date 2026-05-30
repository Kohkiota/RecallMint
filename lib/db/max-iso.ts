// ISO8601(UTC, ...Z) 文字列配列の最大値を返す。空配列は null。
// next-cursor (cards.updated_at / tombstones.deleted_at の max) 算出に使う共有 helper。
export function maxIso(values: string[]): string | null {
  let m: string | null = null
  for (const v of values) if (m === null || v > m) m = v
  return m
}
