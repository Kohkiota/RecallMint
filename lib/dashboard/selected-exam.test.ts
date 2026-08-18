// selected-exam.test — resolveSelectedExam(spec §6)の pure resolver を pin する。
// Dexie / React 一切なし(import ゼロの pure module ゆえ純粋な値の table test)。

import { describe, it, expect } from 'vitest'
import { resolveSelectedExam } from './selected-exam'

const EXAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EXAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EXAM_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DELETED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' // uuid 形式は正しいが examIds に無い(削除済み想定)
const NOT_UUID = 'not-a-uuid'

describe('resolveSelectedExam — 4 段解決(spec §6)', () => {
  it('① URL の exam id が現存 exam に実在 → url 採用・urlNeedsUpdate=false', () => {
    const r = resolveSelectedExam({
      urlExamId: EXAM_A,
      storedExamId: undefined,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toEqual({
      outcome: 'resolved',
      examId: EXAM_A,
      source: 'url',
      urlNeedsUpdate: false,
      storeNeedsUpdate: true, // 保存値未設定 → 保存要
    })
  })

  it('② URL が無く保存値が実在 → stored 採用・urlNeedsUpdate=true(URL へ反映)', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: EXAM_B,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toEqual({
      outcome: 'resolved',
      examId: EXAM_B,
      source: 'stored',
      urlNeedsUpdate: true,
      storeNeedsUpdate: false,
    })
  })

  it('③ URL も保存値も無く試験がちょうど 1 件 → single 採用・URL/保存とも要書込', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: undefined,
      examIds: [EXAM_A],
    })
    expect(r).toEqual({
      outcome: 'resolved',
      examId: EXAM_A,
      source: 'single',
      urlNeedsUpdate: true,
      storeNeedsUpdate: true,
    })
  })

  it('④ URL も保存値も無く試験が複数 → selection-required・urlNeedsUpdate=false(除去対象なし)', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: undefined,
      examIds: [EXAM_A, EXAM_B, EXAM_C],
    })
    expect(r).toEqual({ outcome: 'selection-required', urlNeedsUpdate: false })
  })

  it('④ 試験が 0 件でも selection-required に落ちる(0 exams の表示分岐は呼出側の別関心事)', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: undefined,
      examIds: [],
    })
    expect(r).toEqual({ outcome: 'selection-required', urlNeedsUpdate: false })
  })
})

describe('resolveSelectedExam — 無効 ID は各段で破棄して次段へ進む', () => {
  it('① URL が非 uuid 文字列 → 破棄して ②(保存値)へ', () => {
    const r = resolveSelectedExam({
      urlExamId: NOT_UUID,
      storedExamId: EXAM_B,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toMatchObject({ outcome: 'resolved', examId: EXAM_B, source: 'stored' })
  })

  // 上のケースは NOT_UUID が examIds に存在しないため、実は「not-in-list」チェックだけでも
  // 同じ結果になり「非 uuid」チェックの有無を独立に検出できない(examIds は実運用では
  // 常に uuid のみを含むため validIds.has(NOT_UUID) は元々 false)。 uuid 形式チェックの
  // 存在そのものを pin するため、 examIds に非 uuid 文字列を(意図的に不自然な fixture として)
  // 混在させ、 それが URL 値と完全一致していても「uuid でない」ことを理由に破棄されることを
  // 確認する — この test だけが isUuid() 呼出の有無を観測できる。
  it('① URL が examIds に文字列として存在しても非 uuid なら破棄する(uuid 形式チェックの独立 pin)', () => {
    const r = resolveSelectedExam({
      urlExamId: NOT_UUID,
      storedExamId: EXAM_B,
      examIds: [NOT_UUID, EXAM_B],
    })
    expect(r).toMatchObject({ outcome: 'resolved', examId: EXAM_B, source: 'stored' })
  })

  it('① URL が uuid 形式だが examIds に無い(削除済み)→ 破棄して ②(保存値)へ', () => {
    const r = resolveSelectedExam({
      urlExamId: DELETED,
      storedExamId: EXAM_B,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toMatchObject({ outcome: 'resolved', examId: EXAM_B, source: 'stored' })
    // 破棄された URL 値と最終値が異なるので正規化が要る。
    expect(r).toMatchObject({ urlNeedsUpdate: true })
  })

  it('② 保存値が非 uuid 文字列 → 破棄して ③(単一自動選択)へ', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: NOT_UUID,
      examIds: [EXAM_A],
    })
    expect(r).toMatchObject({ outcome: 'resolved', examId: EXAM_A, source: 'single' })
  })

  // ① の独立 pin と同じ理由: examIds に非 uuid 文字列を混在させ、 保存値と文字列一致しても
  // 「uuid でない」ことを理由に破棄されることを isUuid() 呼出の有無で独立に検出する。
  it('② 保存値が examIds に文字列として存在しても非 uuid なら破棄する(uuid 形式チェックの独立 pin)', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: NOT_UUID,
      examIds: [NOT_UUID, EXAM_A],
    })
    expect(r).toMatchObject({ outcome: 'selection-required' })
  })

  it('② 保存値が uuid 形式だが examIds に無い(削除済み)→ 破棄して ③(単一自動選択)へ', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: DELETED,
      examIds: [EXAM_A],
    })
    expect(r).toMatchObject({ outcome: 'resolved', examId: EXAM_A, source: 'single' })
  })

  it('① と ② がともに無効(削除済み)、試験も複数 → ④ selection-required・URL 正規化要', () => {
    const r = resolveSelectedExam({
      urlExamId: DELETED,
      storedExamId: NOT_UUID,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toEqual({ outcome: 'selection-required', urlNeedsUpdate: true })
  })
})

describe('resolveSelectedExam — URL 正規化フラグ', () => {
  it('URL が既に最終値と一致(① 採用)→ urlNeedsUpdate=false', () => {
    const r = resolveSelectedExam({
      urlExamId: EXAM_A,
      storedExamId: EXAM_A,
      examIds: [EXAM_A],
    })
    expect(r).toMatchObject({ urlNeedsUpdate: false })
  })

  it('URL 不在・保存値も無効・試験複数 → urlNeedsUpdate=false(除去対象が無い)', () => {
    const r = resolveSelectedExam({
      urlExamId: undefined,
      storedExamId: DELETED,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toEqual({ outcome: 'selection-required', urlNeedsUpdate: false })
  })

  it('URL に無効値が残っている・選択不能 → urlNeedsUpdate=true(除去が要る)', () => {
    const r = resolveSelectedExam({
      urlExamId: NOT_UUID,
      storedExamId: undefined,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toEqual({ outcome: 'selection-required', urlNeedsUpdate: true })
  })
})

describe('resolveSelectedExam — 「有効な URL 値は保存値に上書きされない」不変条件(spec §6)', () => {
  it('URL と保存値がともに有効な別試験を指す → 必ず URL 側(①)が勝つ', () => {
    const r = resolveSelectedExam({
      urlExamId: EXAM_A,
      storedExamId: EXAM_B,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toMatchObject({ outcome: 'resolved', examId: EXAM_A, source: 'url' })
  })

  it('URL 採用時、保存値が別物なら保存値を URL 側へ追随更新する(storeNeedsUpdate=true)', () => {
    const r = resolveSelectedExam({
      urlExamId: EXAM_A,
      storedExamId: EXAM_B,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toMatchObject({ storeNeedsUpdate: true })
  })

  it('URL 採用時、保存値が既に同一なら storeNeedsUpdate=false(無駄書き防止)', () => {
    const r = resolveSelectedExam({
      urlExamId: EXAM_A,
      storedExamId: EXAM_A,
      examIds: [EXAM_A, EXAM_B],
    })
    expect(r).toMatchObject({ storeNeedsUpdate: false })
  })
})
