// build-next-tag-set: 純粋関数ユニットテスト。
// Grid-2 T4 で card-tags-section.test.tsx の buildNextTagSet describe を本 module へ移設・拡充。
// 既存 card-tags-section.test.tsx の buildNextTagSet test は re-export 経由で引き続き pass する
// (二重定義ではなく同一実体を参照)。

import { describe, it, expect } from 'vitest'

import { buildNextTagSet } from './build-next-tag-set'

describe('buildNextTagSet — multi カテゴリ', () => {
  it('未付与 option を toggle → toAdd に追加される', () => {
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1']
    const sameCat = new Set(['o1', 'o2', 'o3'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o2')
    expect(result.toAdd).toEqual(['o2'])
    expect(result.toRemove).toHaveLength(0)
    expect(result.next).toEqual(expect.arrayContaining(['o1', 'o2']))
  })

  it('付与済み option を toggle → toRemove に追加される', () => {
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1', 'o2']
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o1')
    expect(result.toRemove).toEqual(['o1'])
    expect(result.toAdd).toHaveLength(0)
    expect(result.next).toEqual(['o2'])
  })

  it('multi: 複数付与から 1 件 remove (他 option は残る)', () => {
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1', 'o2', 'o3']
    const sameCat = new Set(['o1', 'o2', 'o3'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o2')
    expect(result.toRemove).toEqual(['o2'])
    expect(result.toAdd).toHaveLength(0)
    expect(result.next).toEqual(['o1', 'o3'])
  })

  it('multi: 他カテゴリの option_id は next に残る (whole-set 不変条件)', () => {
    // catA に o1 (assigned)、 catB に o3 (assigned)。 catA の o1 を外しても o3 は残る。
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1', 'o3'] // o1 は catA、 o3 は catB
    const sameCatA = new Set(['o1', 'o2']) // catA のみ
    const result = buildNextTagSet(category, allAssigned, sameCatA, 'o1')
    expect(result.next).toContain('o3') // catB の option は保持
    expect(result.next).not.toContain('o1') // catA の option は削除
    expect(result.toRemove).toEqual(['o1'])
  })
})

describe('buildNextTagSet — single カテゴリ', () => {
  it('未付与 option を toggle → 同カテゴリ既存を削除して新規追加 (sibling 置換)', () => {
    const category = { select_type: 'single' as const }
    const allAssigned = ['o1'] // o1 は同カテゴリの既存選択
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o2')
    expect(result.toAdd).toEqual(['o2'])
    expect(result.toRemove).toEqual(['o1'])
    expect(result.next).toEqual(['o2'])
  })

  it('single: 既付与 option を再 toggle → 0 個に戻る (remove)', () => {
    const category = { select_type: 'single' as const }
    const allAssigned = ['o1']
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o1')
    expect(result.toRemove).toEqual(['o1'])
    expect(result.toAdd).toHaveLength(0)
    // 同カテゴリ内は 0 個
    const catOptions = ['o1', 'o2']
    const catNext = result.next.filter((id) => catOptions.includes(id))
    expect(catNext).toHaveLength(0)
  })

  it('single: 未付与カテゴリへ初付与 → toAdd のみ (toRemove なし)', () => {
    const category = { select_type: 'single' as const }
    const allAssigned: string[] = []
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o1')
    expect(result.toAdd).toEqual(['o1'])
    expect(result.toRemove).toHaveLength(0)
    expect(result.next).toEqual(['o1'])
  })

  it('single: 他カテゴリの option_id は next に残る (whole-set 不変条件)', () => {
    const category = { select_type: 'single' as const }
    const allAssigned = ['o1', 'o3'] // o1 は catA、 o3 は catB
    const sameCatA = new Set(['o1', 'o2']) // catA のみ
    const result = buildNextTagSet(category, allAssigned, sameCatA, 'o2')
    expect(result.next).toContain('o3') // catB の option は保持
    expect(result.next).toContain('o2') // catA は o2 に入れ替わり
    expect(result.next).not.toContain('o1') // catA の o1 は削除
    expect(result.toAdd).toEqual(['o2'])
    expect(result.toRemove).toEqual(['o1'])
  })
})
