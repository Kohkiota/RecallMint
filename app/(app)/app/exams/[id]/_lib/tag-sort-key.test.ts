// tag-sort-key.test.ts — S3-2 (a): tagSortKey 純関数の node test。
// fake-indexeddb 不要 (純関数 — DOM / IDB 依存なし)。
//
// 検証内容:
//   (a1) 空 tags → undefined
//   (a2) 先頭選択が sortByKeyThenCreated 最小 (category sort_key ASC → option sort_key ASC → created_at ASC)
//   (a3) 複数カテゴリ・複数 option で先頭が category comparator の最小
//   (a4) 返り値 = `{category.name}: {option.name}` 形式

import { describe, it, expect } from 'vitest'
import { tagSortKey } from './tag-sort-key'
import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function makeCategory(overrides: Partial<ClientTagCategory> = {}): ClientTagCategory {
  return {
    id: 'cat-1',
    user_id: 'u-test',
    name: 'カテゴリA',
    select_type: 'single',
    color: null,
    sort_key: '1',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeOption(overrides: Partial<ClientTagOption> = {}): ClientTagOption {
  return {
    id: 'opt-1',
    user_id: 'u-test',
    category_id: 'cat-1',
    name: 'オプションA',
    color: null,
    sort_key: '1',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// (a1) 空 tags → undefined
// ---------------------------------------------------------------------------

describe('tagSortKey: 空 tags → undefined', () => {
  it('tags 空配列で undefined を返す', () => {
    expect(tagSortKey([])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (a4) 返り値形式: `{category.name}: {option.name}`
// ---------------------------------------------------------------------------

describe('tagSortKey: 返り値形式', () => {
  it('1 タグの場合 `{category.name}: {option.name}` を返す', () => {
    const cat = makeCategory({ name: 'カテゴリ名', sort_key: '1' })
    const opt = makeOption({ name: 'オプション名', sort_key: '1' })
    const result = tagSortKey([{ category: cat, option: opt }])
    expect(result).toBe('カテゴリ名: オプション名')
  })
})

// ---------------------------------------------------------------------------
// (a2) 先頭選択が sortByKeyThenCreated 最小 (category sort_key ASC)
// ---------------------------------------------------------------------------

describe('tagSortKey: 先頭タグ = category sort_key 最小', () => {
  it('category sort_key が小さいタグが先頭 (代表値)', () => {
    const catA = makeCategory({ id: 'cat-a', name: 'カテゴリA', sort_key: '1' })
    const catB = makeCategory({ id: 'cat-b', name: 'カテゴリB', sort_key: '2' })
    const optA = makeOption({ id: 'opt-a', category_id: 'cat-a', name: 'OA', sort_key: '1' })
    const optB = makeOption({ id: 'opt-b', category_id: 'cat-b', name: 'OB', sort_key: '1' })
    // catA (sort_key=1) < catB (sort_key=2) → カテゴリA の optA が先頭
    const result = tagSortKey([
      { category: catB, option: optB },
      { category: catA, option: optA },
    ])
    expect(result).toBe('カテゴリA: OA')
  })

  it('category sort_key が大きいタグは代表値にならない', () => {
    const catA = makeCategory({ id: 'cat-a', name: 'カテゴリA', sort_key: '1' })
    const catB = makeCategory({ id: 'cat-b', name: 'カテゴリB', sort_key: '99' })
    const optA = makeOption({ id: 'opt-a', category_id: 'cat-a', name: 'OA', sort_key: '1' })
    const optB = makeOption({ id: 'opt-b', category_id: 'cat-b', name: 'OB', sort_key: '1' })
    // catB は sort_key=99 > catA sort_key=1 → catA が先
    const result = tagSortKey([
      { category: catB, option: optB },
      { category: catA, option: optA },
    ])
    expect(result).not.toBe('カテゴリB: OB')
    expect(result).toBe('カテゴリA: OA')
  })
})

// ---------------------------------------------------------------------------
// (a2) 同カテゴリ内 option sort_key ASC で先頭選択
// ---------------------------------------------------------------------------

describe('tagSortKey: 同カテゴリ内 option sort_key 最小が先頭', () => {
  it('同カテゴリの場合 option sort_key が小さいほうが代表値', () => {
    const cat = makeCategory({ id: 'cat-1', name: 'カテゴリ', sort_key: '1' })
    const opt1 = makeOption({ id: 'opt-1', category_id: 'cat-1', name: 'オプション1', sort_key: '1' })
    const opt2 = makeOption({ id: 'opt-2', category_id: 'cat-1', name: 'オプション2', sort_key: '2' })
    const result = tagSortKey([
      { category: cat, option: opt2 },
      { category: cat, option: opt1 },
    ])
    expect(result).toBe('カテゴリ: オプション1')
  })
})

// ---------------------------------------------------------------------------
// (a2) category sort_key null → NULLS LAST (有効数値カテゴリが先)
// ---------------------------------------------------------------------------

describe('tagSortKey: category sort_key null → NULLS LAST', () => {
  it('sort_key null カテゴリは末尾扱い — 有効 sort_key カテゴリが代表値', () => {
    const catNull = makeCategory({ id: 'cat-null', name: 'カテゴリNull', sort_key: null })
    const catNum = makeCategory({ id: 'cat-num', name: 'カテゴリNum', sort_key: '1' })
    const optNull = makeOption({ id: 'opt-null', category_id: 'cat-null', name: 'OptNull', sort_key: '1' })
    const optNum = makeOption({ id: 'opt-num', category_id: 'cat-num', name: 'OptNum', sort_key: '1' })
    const result = tagSortKey([
      { category: catNull, option: optNull },
      { category: catNum, option: optNum },
    ])
    // catNum (sort_key=1) < catNull (null = NULLS LAST) → catNum の optNum が先頭
    expect(result).toBe('カテゴリNum: OptNum')
  })
})

// ---------------------------------------------------------------------------
// (a3) 複数カテゴリ + 複数 option — 総合確認
// ---------------------------------------------------------------------------

describe('tagSortKey: 複数カテゴリ・複数 option での先頭選択', () => {
  it('category sort_key → option sort_key の複合 comparator で最小を選ぶ', () => {
    const catA = makeCategory({ id: 'cat-a', name: '動詞', sort_key: '1' })
    const catB = makeCategory({ id: 'cat-b', name: '名詞', sort_key: '2' })
    const optA1 = makeOption({ id: 'opt-a1', category_id: 'cat-a', name: 'walk', sort_key: '1' })
    const optA2 = makeOption({ id: 'opt-a2', category_id: 'cat-a', name: 'run', sort_key: '2' })
    const optB1 = makeOption({ id: 'opt-b1', category_id: 'cat-b', name: 'dog', sort_key: '1' })
    // catA (sort_key=1) < catB (sort_key=2)
    // 同カテゴリA: optA1 (sort_key=1) < optA2 (sort_key=2)
    // → 最小 = catA + optA1 = '動詞: walk'
    const result = tagSortKey([
      { category: catB, option: optB1 },
      { category: catA, option: optA2 },
      { category: catA, option: optA1 },
    ])
    expect(result).toBe('動詞: walk')
  })
})

// ---------------------------------------------------------------------------
// (a2) 元配列を変更しない (pure fn)
// ---------------------------------------------------------------------------

describe('tagSortKey: 元配列を変更しない', () => {
  it('入力配列の順序は変更されない (immutable)', () => {
    const cat = makeCategory({ name: 'カテゴリ', sort_key: '2' })
    const opt1 = makeOption({ id: 'opt-1', name: 'B', sort_key: '2' })
    const opt2 = makeOption({ id: 'opt-2', name: 'A', sort_key: '1' })
    const tags = [
      { category: cat, option: opt1 },
      { category: cat, option: opt2 },
    ]
    const originalFirst = tags[0]
    tagSortKey(tags)
    // 元配列の先頭は変わらない
    expect(tags[0]).toBe(originalFirst)
  })
})
