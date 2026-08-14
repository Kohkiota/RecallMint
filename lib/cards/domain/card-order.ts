// card-order — cards の順序契約 (spec 2026-08-14-order-1-base-order-design §2) を
// 実装する純粋 domain module。採番式と比較関数をここに 1 定義し、client / server の
// 両側が同じ定義を使う (二重実装を作らない)。
//
// PURE 制約 (lib/cards/domain の前例に従う): Dexie / React / zod / drizzle / next を
// import しない (許可は `import type` のみ)。副作用なし・入力のみに依存する。
//
// 引数の型を `ClientCard` でなく構造的型にしてあるのは、順序が「この 2〜3 列だけで
// 決まる」ことを型で示すためであり、server 行 / Dexie 行 / test fixture のどれでも
// 同じ関数を通せるようにするため。

// exam 内の隣接カード間に確保する既定の間隔。位置挿入 (Grid-3) がこの隙間に整数を
// 割り当てるため、末尾採番も同じ刻みで進める (spec §2.2)。
export const BASE_ORDER_STRIDE = 1024

/**
 * 末尾に `count` 枚を追加するときの base_order 列を返す (spec §2.3-1)。
 *
 * 呼出側契約 (関数内で検証しない): `maxExisting` は対象 exam の既存最大値 (1 以上の
 * 整数) または不在を表す null、`count` は 0 以上の整数。呼出元は SQL の `max()` /
 * mirror の max / 配列長のいずれかしか渡さないため、異常値は構造上生じない。
 */
export function nextBaseOrders(
  maxExisting: number | null,
  count: number,
): number[] {
  // null (空 exam) は仮想下界 0 として扱い、先頭が stride ちょうどになるようにする。
  const base = maxExisting ?? 0
  return Array.from({ length: count }, (_, i) => base + (i + 1) * BASE_ORDER_STRIDE)
}

// 順序を決めるのに要る最小の形。id は小文字 canonical UUID である前提で素の文字列
// 比較を使う (localeCompare は locale 依存で PG の uuid byte order と乖離しうる)。
type OrderedCard = {
  base_order: number
  id: string
}

// 同 base_order を決定的に解決する tiebreak。base_order は一意でない (並走採番を
// 許容する設計・spec §2.1) ため、この 1 段が全順序の成立条件になっている。
function compareById(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * exam 内の全順序 `(base_order ASC, id ASC)` (spec §2.1)。
 * server の `ORDER BY base_order, id` と同一結果になる。
 */
export function compareByBaseOrder(a: OrderedCard, b: OrderedCard): number {
  if (a.base_order !== b.base_order) return a.base_order - b.base_order
  return compareById(a.id, b.id)
}

/**
 * exam を跨ぐ決定的順序 `(exam_id ASC, base_order ASC, id ASC)` (spec §2.5)。
 * base_order は exam 内でしか意味を持たないため、まず exam でグループ化する。
 * カスタム演習の sequential (複数 exam 選択) 専用。
 */
export function compareByBaseOrderAcrossExams(
  a: OrderedCard & { exam_id: string },
  b: OrderedCard & { exam_id: string },
): number {
  if (a.exam_id !== b.exam_id) return a.exam_id < b.exam_id ? -1 : 1
  return compareByBaseOrder(a, b)
}

/**
 * 番号ラベル列のソート専用 comparator (spec §6.2)。ラベル文字列 ASC + NULLS LAST で、
 * 同値は基準順 `(base_order, id)` で解決する。
 *
 * 表示専用であり既定順ではない。ラベルは自由テキストなので比較は辞書順であって
 * 数値順ではない ("10" < "2")。未設定は null / undefined の両方で来うる (Dexie 行は
 * optional field、server 行は null) ので同一に扱う。
 */
export function compareByQuestionLabel(
  a: OrderedCard & { question_label?: string | null },
  b: OrderedCard & { question_label?: string | null },
): number {
  const aLabel = a.question_label ?? null
  const bLabel = b.question_label ?? null
  if (aLabel !== bLabel) {
    if (aLabel === null) return 1
    if (bLabel === null) return -1
    return aLabel < bLabel ? -1 : 1
  }
  return compareByBaseOrder(a, b)
}
