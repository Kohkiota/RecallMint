// lib/tags/reindex-sort-keys.ts の純関数 reindexSortKeys のユニットテスト。
// Tag-4c-2b T2 (spec §4.2 / plan T2 完了条件) で必須の 5 ケース:
//   (a) 全 null 初回 → 全件 '0','1','2' 採番
//   (b) 整数化済 list の mid-list 1 行 drag → 移動分のみ updates、 同位 (a:'0') は除外
//   (c) 同順 drag → updates = [] (副作用ゼロ pin)
//   (d) 既存値 null + 数字混在 → 全件正規化 (string normalize 性質を pin)
//   (e) N=50 stress (1 件スワップ) → updates.length === 2、 残り 48 件は同位で除外
// + 防御的: 空入力 / currentSortKeys 未登録 id (undefined → null 扱い)
//
// 不変条件 (sort-comparator との繋がり): 生成値は常に '0'..'N-1' の有効数値文字列のため、
// `sortByKeyThenCreated` の "有効数値=母数 / それ以外=末尾" 不変条件と整合する。

import { describe, it, expect } from 'vitest'

import { reindexSortKeys } from './reindex-sort-keys'

describe('reindexSortKeys', () => {
  // (a) 全 null 初回: drag で初めて並び順を確定するケース。 全件 candidate に乗り
  //     '0','1',…,'N-1' で正規化される (= mixed null/数字 list を一掃する初回挙動)。
  it('(a) 全 null 初回: 全件 0-based 整数で正規化される', () => {
    const orderedIds = ['a', 'b', 'c']
    const currentSortKeys = new Map<string, string | null | undefined>([
      ['a', null],
      ['b', null],
      ['c', null],
    ])
    const updates = reindexSortKeys(orderedIds, currentSortKeys)
    expect(updates).toEqual([
      { id: 'a', sort_key: '0' },
      { id: 'b', sort_key: '1' },
      { id: 'c', sort_key: '2' },
    ])
  })

  // (b) 整数化済 list の mid-list 1 行 drag: 既に '0'..'4' に正規化された 5 件のうち
  //     b を末尾に移動した場合、 a は新 sort_key も '0' で同位 → updates 除外、
  //     c/d/e/b の 4 件のみ updates に乗る。 reindex の差分抽出効率を pin。
  it('(b) 整数化済 5 件: mid-list 1 行 drag で同位は除外、 移動分のみ updates', () => {
    const currentSortKeys = new Map<string, string | null | undefined>([
      ['a', '0'],
      ['b', '1'],
      ['c', '2'],
      ['d', '3'],
      ['e', '4'],
    ])
    // b を末尾へ移動
    const orderedIds = ['a', 'c', 'd', 'e', 'b']
    const updates = reindexSortKeys(orderedIds, currentSortKeys)
    expect(updates).toEqual([
      { id: 'c', sort_key: '1' },
      { id: 'd', sort_key: '2' },
      { id: 'e', sort_key: '3' },
      { id: 'b', sort_key: '4' },
    ])
    // a は '0' === '0' で除外
    expect(updates.find((u) => u.id === 'a')).toBeUndefined()
  })

  // (c) 同順 drag (= drop した位置が元と同じ): 全 id で previousKey === nextKey、
  //     updates = []。 呼出側 (T6 `handleReorderX`) はこれを見て tx 自体を skip し
  //     IDB 書込 / entity_mutations enqueue を起こさない (副作用ゼロ)。
  it('(c) 同順 drag: updates = [] (副作用ゼロ pin)', () => {
    const orderedIds = ['a', 'b', 'c']
    const currentSortKeys = new Map<string, string | null | undefined>([
      ['a', '0'],
      ['b', '1'],
      ['c', '2'],
    ])
    const updates = reindexSortKeys(orderedIds, currentSortKeys)
    expect(updates).toEqual([])
  })

  // (d) 既存値 null + 数字混在: manager 経由 create (sort_key: null) と popover 経由
  //     create (nextCardSortKey で '1','2',…) が混在した状態を初回 drag で一掃するケース。
  //     新値は orderedIds 順で '0','1','2'、 旧値 '5'/null/'1' は全て不一致 → 3 件全て
  //     updates に乗る。 「null も数字も整数文字列で正規化される」 性質を pin。
  it('(d) 既存値混在 (null + 数字): 全件 candidate のうち不一致 3 件が updates に乗る', () => {
    const orderedIds = ['c', 'a', 'b']
    const currentSortKeys = new Map<string, string | null | undefined>([
      ['a', '5'],
      ['b', null],
      ['c', '1'],
    ])
    const updates = reindexSortKeys(orderedIds, currentSortKeys)
    expect(updates).toEqual([
      { id: 'c', sort_key: '0' },
      { id: 'a', sort_key: '1' },
      { id: 'b', sort_key: '2' },
    ])
  })

  // (e) N=50 stress: '0'..'49' 整数化済 list で i25 と i26 をスワップ。
  //     2 件のみ previousKey !== nextKey、 残り 48 件は同位で updates 除外。
  //     大量 list でも差分抽出が効くこと (= 不要 enqueue を起こさない) を pin。
  it('(e) N=50 stress: i25 と i26 を入替 → updates.length === 2 のみ', () => {
    const N = 50
    const ids = Array.from({ length: N }, (_, i) => `i${i}`)
    const currentSortKeys = new Map<string, string | null | undefined>(
      ids.map((id, i) => [id, String(i)]),
    )
    const orderedIds = [...ids]
    // i25 と i26 をスワップ
    ;[orderedIds[25], orderedIds[26]] = [orderedIds[26]!, orderedIds[25]!]
    const updates = reindexSortKeys(orderedIds, currentSortKeys)
    expect(updates).toHaveLength(2)
    expect(updates).toEqual([
      { id: 'i26', sort_key: '25' },
      { id: 'i25', sort_key: '26' },
    ])
  })

  // 防御的 (1): 空入力 → 空配列。 早期 return を経由せず loop が空回りするだけだが
  //   呼出側の safety net として pin (drag-end で空 list が来る race を想定)。
  it('(defensive) 空 orderedIds → 空 updates', () => {
    const updates = reindexSortKeys([], new Map())
    expect(updates).toEqual([])
  })

  // 防御的 (2): orderedIds に currentSortKeys 未登録 id (= get → undefined) が混入。
  //   呼出側 (Tag-4c-2b T6 `handleReorderX`) は categories / options 配列から currentMap を
  //   構築 + 同 source の id 列を SortableContext.items 経由で orderedIds として受けるため、
  //   実運用では id 集合は一致する前提 (= unknown id は通常出現しない)。 本ケースは契約
  //   (unknown id → previousKey null 扱いで整数文字列に正規化) を pin するための test で、
  //   実 race を直接再現する目的ではない。 仮に何らかの理由で id 集合が乖離しても
  //   クラッシュせず safe に倒れる挙動を保証する。
  it('(defensive) currentSortKeys 未登録 id: previousKey = null として正規化', () => {
    const orderedIds = ['a', 'unknown', 'b']
    const currentSortKeys = new Map<string, string | null | undefined>([
      ['a', '0'],
      ['b', '1'],
      // 'unknown' は未登録 → get → undefined
    ])
    const updates = reindexSortKeys(orderedIds, currentSortKeys)
    expect(updates).toEqual([
      // 'a' は '0' === '0' で除外
      { id: 'unknown', sort_key: '1' },
      { id: 'b', sort_key: '2' },
    ])
  })
})
