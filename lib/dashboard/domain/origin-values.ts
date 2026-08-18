// origin-values — answer_events.origin の既知語彙の唯一の SSoT(design doc §11.1 / §11.3)。
// client(session launcher 系)と server(ingest の正規化)が同一 import を使うことで
// 語彙が 2 箇所化しない契約(design doc §11.3「語彙の正は ORIGIN_VALUES の 1 箇所」)。
//
// PURE 制約: I/O・ログを持たない。ここで logger.warn する design doc §11.3 の
// 「未知値 → null 正規化 + review_events.bulk.origin_normalized 観測」は ingest 層
// (server-only の orchestration)の責務であり、この module は client からも import
// されるため意図的に含めない — ここに logger を持ち込むと client bundle に infra が
// 混入する。

/** origin の既知値(design doc §11.1 の 8 値)。セッション開始経路を表すセッション定数。 */
export const ORIGIN_VALUES = [
  'home_today',
  'home_quick_mistakes',
  'home_quick_unanswered',
  'home_quick_weak',
  'home_quick_10min',
  'home_weak_tags',
  'smart',
  'custom',
] as const

export type OriginValue = (typeof ORIGIN_VALUES)[number]

/**
 * 既知集合の判定 + 型の絞り込み。未知値・欠落値は null(design doc §11.3 の
 * 正規化ルールそのもの)。ログ出力はしない(ingest 層が観測イベントとして発火する)。
 */
export function normalizeOriginValue(
  raw: string | undefined | null,
): OriginValue | null {
  if (raw == null) return null
  return (ORIGIN_VALUES as readonly string[]).includes(raw)
    ? (raw as OriginValue)
    : null
}
