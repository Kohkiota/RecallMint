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

/**
 * 移動 (Grid-3) の挿入位置。`after` の anchor は移動先 exam の**常駐列**
 * (= 移動先の card 群 ∖ 移動対象) に存在しなければならない。
 */
export type MovePlacement =
  | { kind: 'end' }
  | { kind: 'start' }
  | { kind: 'after'; anchorId: string }

// 割当 = 「この card の base_order をこの値にする」の絶対値表現。挿入値と再採番値を
// 区別しない (Grid-3 spec §2.1: どちらも同じ形で 1 mutation に載せる)。
type BaseOrderAssignment = {
  id: string
  base_order: number
}

/**
 * 移動 (MoveCards) の base_order 割当を計算する (Grid-3 spec §2.3 / Order-1 §2.3)。
 *
 * - `movedCards` は基準順 (`compareByBaseOrder`) に並べ替えてから値を割り当てる
 *   (表示順ではない — Grid-3 §2.3-1)。
 * - 常駐列 = `targetCards` ∖ `movedCards`。同一 exam 内移動では自分自身が抜けた列に
 *   対して挿入位置を解く (§2.3-2)。
 * - `renumbered = true` のとき `assignments` には常駐カードの再採番値も含む
 *   (再採番と挿入を同一 mutation に畳む — §2.3-4)。
 *
 * 呼出側契約: anchor は常駐列に存在すること。不在 (削除済 / 移動対象自身) は UI が
 * 除外済みのはずで、破れていれば呼出側のバグなので throw する。
 */
export function planMoveAssignments(input: {
  movedCards: OrderedCard[]
  targetCards: OrderedCard[]
  placement: MovePlacement
}): { assignments: BaseOrderAssignment[]; renumbered: boolean } {
  // 移動対象ゼロは no-op。位置解決に進むと重複隣接 gap (A = B) で step = 0 経路に
  // 落ち、「誰も動かないのに常駐列を全件再採番する」割当を返してしまう。
  if (input.movedCards.length === 0) {
    return { assignments: [], renumbered: false }
  }

  // sort は copy に対して行う (呼出元の配列を破壊しない)。filter は新配列を返すので
  // 常駐列側は copy が不要。
  const moved = [...input.movedCards].sort(compareByBaseOrder)
  const movedIds = new Set(moved.map((card) => card.id))
  // 常駐列の基準順への正規化は必須: 呼出側は Dexie mirror (`where('exam_id')` は
  // base_order でなく id 順で返す) など任意の順で渡してくる。未正規化のまま位置を
  // 解くと B − A が負になり step >= 1 の判定をすり抜けて、常駐列を誤った順序で
  // 再採番してしまう。
  const residents = input.targetCards
    .filter((card) => !movedIds.has(card.id))
    .sort(compareByBaseOrder)

  const k = moved.length
  // 挿入点 = 常駐列における「移動対象が入る位置」の index。A = その手前の card、
  // B = その位置の card。
  const splitIndex = resolveSplitIndex(residents, input.placement)
  const predecessor =
    splitIndex === 0 ? null : residents[splitIndex - 1].base_order
  const successor =
    splitIndex < residents.length ? residents[splitIndex].base_order : null

  // B が居ない = 末尾追加。Order-1 §2.3-1 の末尾式そのもの (先頭挿入で常駐列が
  // 空の場合もここに落ち、仮想下界 0 からの i·S になる)。
  if (successor === null) {
    return {
      assignments: zipAssignments(moved, nextBaseOrders(predecessor, k)),
      renumbered: false,
    }
  }

  // 先頭挿入は A = 0 の仮想下界 (Order-1 §2.3-2)。
  const a = predecessor ?? 0
  const step = insertionStep(a, successor, k)
  if (step >= 1) {
    return {
      assignments: zipAssignments(moved, insertionOrders(a, step, k)),
      renumbered: false,
    }
  }

  // ここから step = 0 (整数の空きが無い。A = B の重複隣接も含む)。
  if (k >= BASE_ORDER_STRIDE) {
    // 終端規則 (Grid-3 spec §2.3-4 / D-7): 再採番後の隣接 gap は S なので、k ≥ S では
    // 再計算しても step = 0 が再現し凍結式の再帰が停止しない。意図する最終列を
    // 合成して一括再採番する。
    const finalOrder = [
      ...residents.slice(0, splitIndex),
      ...moved,
      ...residents.slice(splitIndex),
    ]
    return {
      assignments: zipAssignments(
        finalOrder,
        nextBaseOrders(null, finalOrder.length),
      ),
      renumbered: true,
    }
  }

  // 常駐列を i·S に再採番 (Order-1 §2.3-3 = 仮想下界 0 からの末尾式) してから
  // 挿入を解き直す。再採番後の隣接 gap は常に S で、k ≤ S−1 なら step ≥ 1 が確定する。
  const residentOrders = nextBaseOrders(null, residents.length)
  const renumberedA = splitIndex === 0 ? 0 : residentOrders[splitIndex - 1]
  const renumberedStep = insertionStep(
    renumberedA,
    residentOrders[splitIndex],
    k,
  )
  return {
    assignments: [
      ...zipAssignments(residents, residentOrders),
      ...zipAssignments(moved, insertionOrders(renumberedA, renumberedStep, k)),
    ],
    renumbered: true,
  }
}

/**
 * undo (逆方向 MoveCards) の割当を返す (Grid-3 spec §5.4)。
 *
 * `originals` = forward の割当対象**全部**の元 `(exam_id, base_order)`。そのうち元
 * exam が source のものだけを戻す = 単一 exam への逆移動 1 件で表せる。同一 exam 内
 * 移動では再採番された常駐カードも source に属するため一緒に戻る (移動対象だけを
 * 戻すと 1024 刻みの列に旧値が置かれて元の順序が復元されない)。
 */
export function planUndoAssignments(
  originals: Array<{ id: string; exam_id: string; base_order: number }>,
  sourceExamId: string,
): BaseOrderAssignment[] {
  return originals
    .filter((original) => original.exam_id === sourceExamId)
    .map((original) => ({ id: original.id, base_order: original.base_order }))
}

// 常駐列のどこに挿入するか。返す index は「移動対象が占める先頭位置」。
function resolveSplitIndex(
  residents: OrderedCard[],
  placement: MovePlacement,
): number {
  if (placement.kind === 'start') return 0
  if (placement.kind === 'end') return residents.length
  const index = residents.findIndex((card) => card.id === placement.anchorId)
  if (index < 0) {
    throw new Error(
      `planMoveAssignments: anchor card ${placement.anchorId} is not in the target exam's resident cards`,
    )
  }
  return index + 1
}

// Order-1 §2.3-2 の step。A / B は挿入点で隣接する base_order。
function insertionStep(a: number, b: number, count: number): number {
  return Math.floor((b - a) / (count + 1))
}

// Order-1 §2.3-2 の `b_i = A + i·step` (i = 1..count)。
function insertionOrders(a: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => a + (i + 1) * step)
}

// cards[i] に orders[i] を対応させる。両者は常に同じ長さで呼ぶ。
function zipAssignments(
  cards: OrderedCard[],
  orders: number[],
): BaseOrderAssignment[] {
  return cards.map((card, i) => ({ id: card.id, base_order: orders[i] }))
}
