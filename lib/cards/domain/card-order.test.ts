import { describe, expect, it } from 'vitest'
import {
  BASE_ORDER_STRIDE,
  compareByBaseOrder,
  compareByBaseOrderAcrossExams,
  compareByQuestionLabel,
  nextBaseOrders,
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
