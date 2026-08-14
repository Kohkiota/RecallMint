import { describe, expect, it } from 'vitest'
import {
  BASE_ORDER_STRIDE,
  compareByBaseOrder,
  compareByBaseOrderAcrossExams,
  compareByQuestionLabel,
  nextBaseOrders,
  planMoveAssignments,
  planUndoAssignments,
} from './card-order'

// UUID は小文字 canonical 前提 (spec §2.1)。文字列比較が PG uuid の byte order と
// 一致する性質を使うため、fixture も実際の生成形と同じ小文字 hex にする。
const ID_A = '0a1b2c3d-0000-4000-8000-000000000001'
const ID_B = '5f6e7d8c-0000-4000-8000-000000000002'
const ID_C = 'f0e1d2c3-0000-4000-8000-000000000003'

describe('BASE_ORDER_STRIDE', () => {
  it('spec §2.2 の stride は 1024', () => {
    expect(BASE_ORDER_STRIDE).toBe(1024)
  })
})

// ---------------------------------------------------------------------------
// nextBaseOrders
// ---------------------------------------------------------------------------

describe('nextBaseOrders', () => {
  it('空 exam (max=null) は stride から始まる', () => {
    expect(nextBaseOrders(null, 1)).toEqual([1024])
  })

  it('既存 max の続きから stride 刻みで採番する', () => {
    expect(nextBaseOrders(3072, 3)).toEqual([4096, 5120, 6144])
  })

  it('count=0 は空配列 (publish で採用カード 0 件は呼出側が短絡するが、式としては空)', () => {
    expect(nextBaseOrders(3072, 0)).toEqual([])
  })

  it('max=null と max=0 は同じ結果 (仮想下界 0 と一致する)', () => {
    expect(nextBaseOrders(0, 2)).toEqual(nextBaseOrders(null, 2))
  })
})

// ---------------------------------------------------------------------------
// compareByBaseOrder
// ---------------------------------------------------------------------------

describe('compareByBaseOrder', () => {
  it('base_order 昇順で並ぶ', () => {
    const rows = [
      { base_order: 3072, id: ID_A },
      { base_order: 1024, id: ID_B },
      { base_order: 2048, id: ID_C },
    ]
    expect([...rows].sort(compareByBaseOrder).map((r) => r.base_order)).toEqual([
      1024, 2048, 3072,
    ])
  })

  it('base_order 同値は id 昇順で解決する', () => {
    const rows = [
      { base_order: 1024, id: ID_C },
      { base_order: 1024, id: ID_A },
      { base_order: 1024, id: ID_B },
    ]
    expect([...rows].sort(compareByBaseOrder).map((r) => r.id)).toEqual([
      ID_A,
      ID_B,
      ID_C,
    ])
  })

  it('重複 base_order を含む集合でも入力順に依らず同一結果 (決定性)', () => {
    const rows = [
      { base_order: 1024, id: ID_C },
      { base_order: 2048, id: ID_A },
      { base_order: 1024, id: ID_A },
      { base_order: 2048, id: ID_B },
    ]
    const forward = [...rows].sort(compareByBaseOrder).map((r) => r.id)
    const reversed = [...rows].reverse().sort(compareByBaseOrder).map((r) => r.id)
    expect(forward).toEqual(reversed)
  })

  it('反対称: compare(a,b) の符号は compare(b,a) の反転', () => {
    const a = { base_order: 1024, id: ID_A }
    const b = { base_order: 2048, id: ID_B }
    expect(Math.sign(compareByBaseOrder(a, b))).toBe(
      -Math.sign(compareByBaseOrder(b, a)),
    )
  })

  it('同一 id (= 同一行) は 0', () => {
    const a = { base_order: 1024, id: ID_A }
    expect(compareByBaseOrder(a, { ...a })).toBe(0)
  })

  it('入力 object を破壊しない', () => {
    const a = { base_order: 2048, id: ID_A }
    const b = { base_order: 1024, id: ID_B }
    compareByBaseOrder(a, b)
    expect(a).toEqual({ base_order: 2048, id: ID_A })
    expect(b).toEqual({ base_order: 1024, id: ID_B })
  })
})

// ---------------------------------------------------------------------------
// compareByBaseOrderAcrossExams
// ---------------------------------------------------------------------------

describe('compareByBaseOrderAcrossExams', () => {
  const EXAM_1 = '11111111-0000-4000-8000-000000000001'
  const EXAM_2 = '22222222-0000-4000-8000-000000000002'

  it('exam ごとにグループ化し、各 exam 内は基準順になる', () => {
    const rows = [
      { exam_id: EXAM_2, base_order: 1024, id: ID_A },
      { exam_id: EXAM_1, base_order: 2048, id: ID_B },
      { exam_id: EXAM_2, base_order: 2048, id: ID_B },
      { exam_id: EXAM_1, base_order: 1024, id: ID_A },
    ]
    expect(
      [...rows]
        .sort(compareByBaseOrderAcrossExams)
        .map((r) => [r.exam_id, r.base_order]),
    ).toEqual([
      [EXAM_1, 1024],
      [EXAM_1, 2048],
      [EXAM_2, 1024],
      [EXAM_2, 2048],
    ])
  })

  it('同 exam・同 base_order は id 昇順で解決する', () => {
    const rows = [
      { exam_id: EXAM_1, base_order: 1024, id: ID_B },
      { exam_id: EXAM_1, base_order: 1024, id: ID_A },
    ]
    expect(
      [...rows].sort(compareByBaseOrderAcrossExams).map((r) => r.id),
    ).toEqual([ID_A, ID_B])
  })

  it('反対称: compare(a,b) の符号は compare(b,a) の反転', () => {
    const a = { exam_id: EXAM_1, base_order: 2048, id: ID_B }
    const b = { exam_id: EXAM_2, base_order: 1024, id: ID_A }
    expect(Math.sign(compareByBaseOrderAcrossExams(a, b))).toBe(
      -Math.sign(compareByBaseOrderAcrossExams(b, a)),
    )
  })

  it('同一行は 0', () => {
    const a = { exam_id: EXAM_1, base_order: 1024, id: ID_A }
    expect(compareByBaseOrderAcrossExams(a, { ...a })).toBe(0)
  })

  it('入力 object を破壊しない', () => {
    const a = { exam_id: EXAM_2, base_order: 2048, id: ID_A }
    const b = { exam_id: EXAM_1, base_order: 1024, id: ID_B }
    compareByBaseOrderAcrossExams(a, b)
    expect(a).toEqual({ exam_id: EXAM_2, base_order: 2048, id: ID_A })
    expect(b).toEqual({ exam_id: EXAM_1, base_order: 1024, id: ID_B })
  })
})

// ---------------------------------------------------------------------------
// compareByQuestionLabel (ラベル列ソート専用)
// ---------------------------------------------------------------------------

describe('compareByQuestionLabel', () => {
  it('ラベル文字列を辞書順 ASC で並べる', () => {
    const rows = [
      { question_label: '010', base_order: 1024, id: ID_A },
      { question_label: '002', base_order: 2048, id: ID_B },
      { question_label: '001', base_order: 3072, id: ID_C },
    ]
    expect(
      [...rows].sort(compareByQuestionLabel).map((r) => r.question_label),
    ).toEqual(['001', '002', '010'])
  })

  it('辞書順であって数値順ではない (ラベルは自由テキスト)', () => {
    const rows = [
      { question_label: '10', base_order: 1024, id: ID_A },
      { question_label: '2', base_order: 2048, id: ID_B },
    ]
    expect(
      [...rows].sort(compareByQuestionLabel).map((r) => r.question_label),
    ).toEqual(['10', '2'])
  })

  it('null ラベルは末尾 (NULLS LAST)', () => {
    const rows = [
      { question_label: null, base_order: 1024, id: ID_A },
      { question_label: '001', base_order: 2048, id: ID_B },
    ]
    expect(
      [...rows].sort(compareByQuestionLabel).map((r) => r.question_label),
    ).toEqual(['001', null])
  })

  it('undefined は null と同じ扱い (どちらも末尾・相互は tiebreak で解決)', () => {
    const rows = [
      { question_label: undefined, base_order: 3072, id: ID_C },
      { question_label: '001', base_order: 1024, id: ID_A },
      { question_label: null, base_order: 2048, id: ID_B },
    ]
    const sorted = [...rows].sort(compareByQuestionLabel)
    expect(sorted.map((r) => r.base_order)).toEqual([1024, 2048, 3072])
  })

  it('同一ラベルは (base_order, id) で解決する — created_at は使わない', () => {
    const rows = [
      { question_label: '001', base_order: 3072, id: ID_A },
      { question_label: '001', base_order: 1024, id: ID_C },
      { question_label: '001', base_order: 1024, id: ID_A },
    ]
    expect(
      [...rows].sort(compareByQuestionLabel).map((r) => [r.base_order, r.id]),
    ).toEqual([
      [1024, ID_A],
      [1024, ID_C],
      [3072, ID_A],
    ])
  })

  it('反対称: compare(a,b) の符号は compare(b,a) の反転 (null 絡みでも)', () => {
    const a = { question_label: null, base_order: 1024, id: ID_A }
    const b = { question_label: '001', base_order: 2048, id: ID_B }
    expect(Math.sign(compareByQuestionLabel(a, b))).toBe(
      -Math.sign(compareByQuestionLabel(b, a)),
    )
  })

  it('同一行は 0', () => {
    const a = { question_label: '001', base_order: 1024, id: ID_A }
    expect(compareByQuestionLabel(a, { ...a })).toBe(0)
  })

  it('入力 object を破壊しない', () => {
    const a = { question_label: '002', base_order: 2048, id: ID_A }
    const b = { question_label: '001', base_order: 1024, id: ID_B }
    compareByQuestionLabel(a, b)
    expect(a).toEqual({ question_label: '002', base_order: 2048, id: ID_A })
    expect(b).toEqual({ question_label: '001', base_order: 1024, id: ID_B })
  })
})

// ---------------------------------------------------------------------------
// planMoveAssignments / planUndoAssignments (Grid-3 の移動計算)
// ---------------------------------------------------------------------------

const EXAM_SOURCE = 'aaaaaaaa-0000-4000-8000-000000000001'
const EXAM_TARGET = 'bbbbbbbb-0000-4000-8000-000000000002'

type TestCard = { base_order: number; exam_id: string; id: string }

// 連番 id (小文字 canonical・ゼロ埋め) は数値昇順 = 文字列昇順になるので、基準順の
// tiebreak が予測可能になる。fixture は原則この形で作る。
function cardId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function makeCards(examId: string, bases: number[], idFrom: number): TestCard[] {
  return bases.map((base_order, i) => ({
    base_order,
    exam_id: examId,
    id: cardId(idFrom + i),
  }))
}

// 割当を「世界」に適用する (割当対象は全て移動先 exam に属する — 常駐の再採番も含む)。
function applyAssignments(
  world: TestCard[],
  targetExamId: string,
  assignments: Array<{ id: string; base_order: number }>,
): TestCard[] {
  const next = new Map(assignments.map((a) => [a.id, a.base_order]))
  return world.map((card) => {
    const base_order = next.get(card.id)
    if (base_order === undefined) return card
    return { ...card, base_order, exam_id: targetExamId }
  })
}

// forward 適用前に控える undo 素材 = 割当対象**全部**の元 (exam_id, base_order)。
function captureOriginals(
  world: TestCard[],
  assignments: Array<{ id: string; base_order: number }>,
): Array<{ id: string; exam_id: string; base_order: number }> {
  const ids = new Set(assignments.map((a) => a.id))
  return world
    .filter((card) => ids.has(card.id))
    .map((card) => ({
      id: card.id,
      exam_id: card.exam_id,
      base_order: card.base_order,
    }))
}

function orderOf(world: TestCard[], examId: string): string[] {
  return world
    .filter((card) => card.exam_id === examId)
    .sort(compareByBaseOrder)
    .map((card) => card.id)
}

describe('planMoveAssignments — 末尾 (end)', () => {
  it('常駐列の max の続きに stride 刻みで割り当てる (Order-1 §2.3-1 の末尾式)', () => {
    const target = makeCards(EXAM_TARGET, [1024, 2048], 1)
    const moved = makeCards(EXAM_SOURCE, [1024, 2048], 10)

    const plan = planMoveAssignments({
      movedCards: moved,
      targetCards: target,
      placement: { kind: 'end' },
    })

    expect(plan).toEqual({
      assignments: [
        { id: cardId(10), base_order: 3072 },
        { id: cardId(11), base_order: 4096 },
      ],
      renumbered: false,
    })
    // 凍結式そのものであることを採番器と突き合わせる (式を再実装していない)。
    expect(plan.assignments.map((a) => a.base_order)).toEqual(
      nextBaseOrders(2048, 2),
    )
  })

  it('空 exam への末尾は stride 先頭から始まる', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [4096], 10),
      targetCards: [],
      placement: { kind: 'end' },
    })

    expect(plan).toEqual({
      assignments: [{ id: cardId(10), base_order: 1024 }],
      renumbered: false,
    })
  })
})

describe('planMoveAssignments — 先頭 (start)', () => {
  it('A = 0 の仮想下界と先頭 card の間を step で等分する (Order-1 §2.3-2)', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [1024, 2048], 10),
      targetCards: makeCards(EXAM_TARGET, [1024, 2048], 1),
      placement: { kind: 'start' },
    })

    // step = floor((1024 - 0) / 3) = 341
    expect(plan).toEqual({
      assignments: [
        { id: cardId(10), base_order: 341 },
        { id: cardId(11), base_order: 682 },
      ],
      renumbered: false,
    })
  })

  it('常駐列が空なら先頭指定でも末尾式に落ちる (B が存在しない)', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [4096, 8192], 10),
      targetCards: [],
      placement: { kind: 'start' },
    })

    expect(plan).toEqual({
      assignments: [
        { id: cardId(10), base_order: 1024 },
        { id: cardId(11), base_order: 2048 },
      ],
      renumbered: false,
    })
  })
})

describe('planMoveAssignments — 直後 (after)', () => {
  it('anchor と次の card の間を step で等分する', () => {
    const target = makeCards(EXAM_TARGET, [1024, 2048, 3072], 1)

    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [512, 1024, 1536], 10),
      targetCards: target,
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    // step = floor((2048 - 1024) / 4) = 256
    expect(plan).toEqual({
      assignments: [
        { id: cardId(10), base_order: 1280 },
        { id: cardId(11), base_order: 1536 },
        { id: cardId(12), base_order: 1792 },
      ],
      renumbered: false,
    })
  })

  it('anchor が常駐列の末尾なら末尾式になる (B が存在しない)', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [1024, 2048], 10),
      targetCards: makeCards(EXAM_TARGET, [1024, 2048], 1),
      placement: { kind: 'after', anchorId: cardId(2) },
    })

    expect(plan).toEqual({
      assignments: [
        { id: cardId(10), base_order: 3072 },
        { id: cardId(11), base_order: 4096 },
      ],
      renumbered: false,
    })
  })

  it('anchor が移動先に不在なら throw する (呼出側のバグ検出)', () => {
    expect(() =>
      planMoveAssignments({
        movedCards: makeCards(EXAM_SOURCE, [1024], 10),
        targetCards: makeCards(EXAM_TARGET, [1024], 1),
        placement: { kind: 'after', anchorId: cardId(999) },
      }),
    ).toThrow(/anchor card/)
  })

  it('anchor が移動対象自身なら throw する (常駐列から除かれるため)', () => {
    const moved = makeCards(EXAM_TARGET, [2048], 2)
    expect(() =>
      planMoveAssignments({
        movedCards: moved,
        targetCards: [...makeCards(EXAM_TARGET, [1024], 1), ...moved],
        placement: { kind: 'after', anchorId: cardId(2) },
      }),
    ).toThrow(/anchor card/)
  })
})

describe('planMoveAssignments — step = 0 の再採番畳み込み (Grid-3 §2.3-4)', () => {
  it('整数の空きが無い列では常駐再採番と挿入を同一 assignments に畳む', () => {
    const target = makeCards(EXAM_TARGET, [1, 2, 3], 1)

    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [1024], 10),
      targetCards: target,
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    // step = floor((2 - 1) / 2) = 0 → 常駐を i·S に再採番 → step = floor(1024/2) = 512
    expect(plan).toEqual({
      assignments: [
        { id: cardId(1), base_order: 1024 },
        { id: cardId(2), base_order: 2048 },
        { id: cardId(3), base_order: 3072 },
        { id: cardId(10), base_order: 1536 },
      ],
      renumbered: true,
    })

    const world = applyAssignments(
      [...target, ...makeCards(EXAM_SOURCE, [1024], 10)],
      EXAM_TARGET,
      plan.assignments,
    )
    expect(orderOf(world, EXAM_TARGET)).toEqual([
      cardId(1),
      cardId(10),
      cardId(2),
      cardId(3),
    ])
  })

  it('A = B の重複隣接も step = 0 として再採番に落ちる', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [4096], 10),
      targetCards: makeCards(EXAM_TARGET, [1024, 1024], 1),
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    expect(plan).toEqual({
      assignments: [
        { id: cardId(1), base_order: 1024 },
        { id: cardId(2), base_order: 2048 },
        { id: cardId(10), base_order: 1536 },
      ],
      renumbered: true,
    })
  })

  it('先頭挿入で step = 0 のときも A = 0 のまま再採番後に解き直す', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [4096], 10),
      targetCards: makeCards(EXAM_TARGET, [1, 2], 1),
      placement: { kind: 'start' },
    })

    // step = floor((1 - 0) / 2) = 0 → 再採番 → step = floor((1024 - 0) / 2) = 512
    expect(plan).toEqual({
      assignments: [
        { id: cardId(1), base_order: 1024 },
        { id: cardId(2), base_order: 2048 },
        { id: cardId(10), base_order: 512 },
      ],
      renumbered: true,
    })
  })
})

describe('planMoveAssignments — k = S 前後の境界 (終端規則 D-7)', () => {
  const target = makeCards(EXAM_TARGET, [1, 2], 1)

  it('k = 1023 は再採番後に step ≥ 1 で収まる (終端規則に落ちない)', () => {
    const moved = makeCards(
      EXAM_SOURCE,
      Array.from({ length: BASE_ORDER_STRIDE - 1 }, (_, i) => i + 1),
      10,
    )

    const plan = planMoveAssignments({
      movedCards: moved,
      targetCards: target,
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    // 再採番後 A=1024 / B=2048 → step = floor(1024 / 1024) = 1
    expect(plan.renumbered).toBe(true)
    expect(plan.assignments).toHaveLength(2 + (BASE_ORDER_STRIDE - 1))
    expect(plan.assignments.slice(0, 2)).toEqual([
      { id: cardId(1), base_order: 1024 },
      { id: cardId(2), base_order: 2048 },
    ])
    // 端点が A / B の内側にあり、値が重複しない (= 1025..2047 の 1023 通りが全て
    // 使われる) ところまでを pin する。個々の隣接差までは見ていない。
    const movedOrders = plan.assignments.slice(2).map((a) => a.base_order)
    expect(movedOrders[0]).toBe(1025)
    expect(movedOrders.at(-1)).toBe(2047)
    expect(new Set(movedOrders).size).toBe(BASE_ORDER_STRIDE - 1)
  })

  it('k = 1024 は合成列一括 i·S に切り替わる (凍結式の再帰が停止しない域)', () => {
    const moved = makeCards(
      EXAM_SOURCE,
      Array.from({ length: BASE_ORDER_STRIDE }, (_, i) => i + 1),
      10,
    )

    const plan = planMoveAssignments({
      movedCards: moved,
      targetCards: target,
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    expect(plan.renumbered).toBe(true)
    expect(plan.assignments).toHaveLength(1026)
    // 割当順 = 意図する最終列 (anchor まで + 移動対象 + 残り)。
    expect(plan.assignments.map((a) => a.id)).toEqual([
      cardId(1),
      ...moved.map((card) => card.id),
      cardId(2),
    ])
    // 値は i·1024 の一括再採番。期待値は実装の採番器を通さずリテラルで置く
    // (同じ誤りが実装と期待値の両側に入って空振りするのを避ける)。
    const orders = plan.assignments.map((a) => a.base_order)
    expect(orders[0]).toBe(1024) // anchor
    expect(orders[1]).toBe(2048) // 移動対象の先頭
    expect(orders[1024]).toBe(1049600) // 移動対象の末尾 (1025 番目)
    expect(orders[1025]).toBe(1050624) // 残りの常駐 (1026 番目)
    expect(new Set(orders.slice(1).map((value, i) => value - orders[i]))).toEqual(
      new Set([1024]),
    )
  })
})

describe('planMoveAssignments — 割当順と常駐列の決定', () => {
  it('移動対象は入力順でなく基準順 (base_order, id) で割り当てる', () => {
    const plan = planMoveAssignments({
      // base_order 同値は id で解決される (ID_A < ID_B < ID_C)。
      movedCards: [
        { base_order: 2048, id: ID_C },
        { base_order: 1024, id: ID_B },
        { base_order: 2048, id: ID_A },
      ],
      targetCards: [],
      placement: { kind: 'end' },
    })

    expect(plan.assignments).toEqual([
      { id: ID_B, base_order: 1024 },
      { id: ID_A, base_order: 2048 },
      { id: ID_C, base_order: 3072 },
    ])
  })

  it('同一 exam 内移動では常駐列から移動対象自身を除いて位置を解く', () => {
    const cards = makeCards(EXAM_TARGET, [1024, 2048, 3072], 1)

    const plan = planMoveAssignments({
      movedCards: [cards[1]],
      targetCards: cards,
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    // 常駐 = [1024, 3072] なので step = floor((3072 - 1024) / 2) = 1024。
    // 自身を除かずに解くと B = 2048 (自分の値) になり 1536 になってしまう。
    expect(plan).toEqual({
      assignments: [{ id: cardId(2), base_order: 2048 }],
      renumbered: false,
    })
  })

  it('常駐列は入力順に依らず基準順に正規化される', () => {
    // 呼出側の実態: Dexie mirror の `where('exam_id')` は base_order 順ではなく
    // id 順で返すので、入力は「id 昇順・base_order はバラバラ」で来る。
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [1024], 10),
      targetCards: [
        { base_order: 3072, id: cardId(1) },
        { base_order: 1024, id: cardId(2) },
        { base_order: 2048, id: cardId(3) },
      ],
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    // 基準順では anchor (3072) が常駐列の末尾 → 末尾式で 4096。正規化しないと
    // B = 1024 で B − A = −2048 となり、step >= 1 の判定をすり抜けて常駐列全件が
    // 入力順のまま再採番される。
    expect(plan).toEqual({
      assignments: [{ id: cardId(10), base_order: 4096 }],
      renumbered: false,
    })
  })

  it('常駐列の正規化は先頭挿入の B (常駐列の最小値) にも効く', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [4096], 10),
      targetCards: [
        { base_order: 3072, id: cardId(1) },
        { base_order: 1024, id: cardId(2) },
        { base_order: 2048, id: cardId(3) },
      ],
      placement: { kind: 'start' },
    })

    // B = 1024 (基準順の先頭) → step = floor(1024 / 2) = 512。正規化しないと
    // B = 3072 と読んで 1536 = 既存 1024 の後ろに置かれてしまう。
    expect(plan).toEqual({
      assignments: [{ id: cardId(10), base_order: 512 }],
      renumbered: false,
    })
  })

  it('常駐列の正規化は base_order 同値の並びも id で解決する', () => {
    const plan = planMoveAssignments({
      movedCards: makeCards(EXAM_SOURCE, [4096], 10),
      targetCards: [
        { base_order: 1024, id: cardId(5) },
        { base_order: 1024, id: cardId(1) },
      ],
      placement: { kind: 'after', anchorId: cardId(5) },
    })

    // 基準順は cardId(1) → cardId(5) なので anchor は末尾 = 末尾式で 2048。
    // id tiebreak が無いと入力順のまま cardId(5) が先頭に残り、A = B = 1024 の
    // step = 0 経路 (常駐再採番) に落ちる。
    expect(plan).toEqual({
      assignments: [{ id: cardId(10), base_order: 2048 }],
      renumbered: false,
    })
  })

  it('移動対象ゼロは no-op を返す (常駐列を再採番しない)', () => {
    const plan = planMoveAssignments({
      movedCards: [],
      targetCards: makeCards(EXAM_TARGET, [1024, 1024], 1),
      placement: { kind: 'after', anchorId: cardId(1) },
    })

    // A = B = 1024 なので、early return が無いと step = 0 経路に落ちて常駐 2 枚の
    // 再採番だけが返る (誰も動いていないのに順序値が動く)。
    expect(plan).toEqual({ assignments: [], renumbered: false })
  })

  it('入力配列と要素を破壊しない', () => {
    const moved = makeCards(EXAM_SOURCE, [2048, 1024], 10)
    const target = makeCards(EXAM_TARGET, [2, 1], 1)
    const movedSnapshot = structuredClone(moved)
    const targetSnapshot = structuredClone(target)

    planMoveAssignments({
      movedCards: moved,
      targetCards: target,
      placement: { kind: 'start' },
    })

    expect(moved).toEqual(movedSnapshot)
    expect(target).toEqual(targetSnapshot)
  })
})

describe('planUndoAssignments', () => {
  it('元 exam が source の割当だけを絶対値で返す', () => {
    const originals = [
      { id: cardId(1), exam_id: EXAM_TARGET, base_order: 1 },
      { id: cardId(10), exam_id: EXAM_SOURCE, base_order: 1024 },
      { id: cardId(11), exam_id: EXAM_SOURCE, base_order: 2048 },
    ]

    expect(planUndoAssignments(originals, EXAM_SOURCE)).toEqual([
      { id: cardId(10), base_order: 1024 },
      { id: cardId(11), base_order: 2048 },
    ])
  })

  it('cross-exam 移動の undo は移動対象のみを返す (移動先の再採番常駐は戻さない)', () => {
    const source = makeCards(EXAM_SOURCE, [1024, 2048], 10)
    const target = makeCards(EXAM_TARGET, [1, 2], 1)
    const world = [...source, ...target]

    const plan = planMoveAssignments({
      movedCards: source,
      targetCards: target,
      placement: { kind: 'after', anchorId: cardId(1) },
    })
    // step = floor((2 - 1) / 3) = 0 → 常駐再採番 → step = floor(1024 / 3) = 341
    expect(plan).toEqual({
      assignments: [
        { id: cardId(1), base_order: 1024 },
        { id: cardId(2), base_order: 2048 },
        { id: cardId(10), base_order: 1365 },
        { id: cardId(11), base_order: 1706 },
      ],
      renumbered: true,
    })

    const originals = captureOriginals(world, plan.assignments)
    const moved = applyAssignments(world, EXAM_TARGET, plan.assignments)
    const undo = planUndoAssignments(originals, EXAM_SOURCE)

    expect(undo).toEqual([
      { id: cardId(10), base_order: 1024 },
      { id: cardId(11), base_order: 2048 },
    ])

    const restored = applyAssignments(moved, EXAM_SOURCE, undo)
    expect(orderOf(restored, EXAM_SOURCE)).toEqual(orderOf(world, EXAM_SOURCE))
    // 移動先に残る再採番は相対順を変えないので戻す必要がない。
    expect(orderOf(restored, EXAM_TARGET)).toEqual(orderOf(world, EXAM_TARGET))
  })

  it('同一 exam 内 + step = 0 再採番の undo が元の順序を完全復元する', () => {
    const world = makeCards(EXAM_TARGET, [1, 2, 3, 4], 1)
    const before = orderOf(world, EXAM_TARGET)

    const plan = planMoveAssignments({
      movedCards: [world[3]],
      targetCards: world,
      placement: { kind: 'after', anchorId: cardId(1) },
    })
    expect(plan.renumbered).toBe(true)

    const originals = captureOriginals(world, plan.assignments)
    const moved = applyAssignments(world, EXAM_TARGET, plan.assignments)
    expect(orderOf(moved, EXAM_TARGET)).toEqual([
      cardId(1),
      cardId(4),
      cardId(2),
      cardId(3),
    ])

    // undo 対象は再採番された常駐カードも含む (元 exam_id が source に一致するため)。
    const undo = planUndoAssignments(originals, EXAM_TARGET)
    expect(undo.map((a) => a.id)).toEqual([
      cardId(1),
      cardId(2),
      cardId(3),
      cardId(4),
    ])
    expect(orderOf(applyAssignments(moved, EXAM_TARGET, undo), EXAM_TARGET)).toEqual(
      before,
    )

    // 反例 (spec §5.4): 移動対象だけを旧値に戻すと、1024 刻みに再採番済みの常駐列の
    // 中に旧来の小さい値が置かれ、元の順序は復元されない。
    const movedOnly = undo.filter((a) => a.id === cardId(4))
    expect(
      orderOf(applyAssignments(moved, EXAM_TARGET, movedOnly), EXAM_TARGET),
    ).not.toEqual(before)
  })
})
