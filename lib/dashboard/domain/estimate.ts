// estimate — 定義 doc §4-N の推定所要時間・中央値計算。標本の取得(local_id 降順で
// ローカル answer_events を読む Dexie query)は I/O なので呼び出し元の責務。この module
// は「呼び出し元が新しい順(local_id 降順)で並べた候補配列」を受け取り、有効化条件の
// 判定・走査打ち切り・中央値だけを行う。
//
// PURE 制約(lib/*/domain 前例に倣う): I/O なし・DB / Dexie を import しない。

import {
  ESTIMATE_CAP_MS,
  ESTIMATE_DEFAULT_MS,
  ESTIMATE_SAMPLE_N,
  ESTIMATE_SCAN_LIMIT,
} from './metric-constants'

/**
 * `elapsed_ms` 候補の中央値(定義 doc §4-N)。
 *
 * - `candidates` は呼び出し元が新しい順(local_id 降順)で並べた生の値
 *   (未計測行は `null`/`undefined` で渡してよい)。この関数自体は並び替えない。
 * - 有効化条件: `0 < elapsed_ms <= ESTIMATE_CAP_MS`。上限超過は clamp でなく除外、
 *   `0` も除外(計測不能の縮退値であり実測 0ms ではない)。
 * - 走査は先頭から最大 `ESTIMATE_SCAN_LIMIT` 行までで打ち切り、その中で有効標本を
 *   最大 `ESTIMATE_SAMPLE_N` 件集めた時点でも打ち切る(「有効 100 件」「走査 1,000 行」
 *   のどちらか早い方 — 無効値が連続して全件走査に退化するのを防ぐ)。
 * - 中央値: 有効標本を昇順に並べ、奇数件は中央 1 件、偶数件は中央 2 件の算術平均。
 * - 有効標本が 0 件のときのみ `ESTIMATE_DEFAULT_MS` を返す(1 件以上あれば件数に
 *   よらず中央値を使う)。
 */
export function estimateMedianMs(
  candidates: readonly (number | null | undefined)[],
): number {
  const valid: number[] = []
  const scanLimit = Math.min(candidates.length, ESTIMATE_SCAN_LIMIT)

  for (let i = 0; i < scanLimit; i++) {
    const ms = candidates[i]
    if (ms == null) continue
    if (ms > 0 && ms <= ESTIMATE_CAP_MS) {
      valid.push(ms)
      if (valid.length >= ESTIMATE_SAMPLE_N) break
    }
  }

  if (valid.length === 0) return ESTIMATE_DEFAULT_MS

  const sorted = [...valid].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}
