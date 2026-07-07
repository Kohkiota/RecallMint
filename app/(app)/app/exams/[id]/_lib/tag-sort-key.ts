// tag-sort-key.ts — S3-2 D-3: tags 列ソートの代表値純関数。
// TagCell の表示順 (compareTagEntry) と同一 comparator を import 共有することで
// 「セルで最初に見えるチップ」= 代表値 の不変条件を保証する。

import { compareTagEntry } from '@/lib/tags/sort-comparator'
import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'

type TagEntry = {
  category: ClientTagCategory
  option: ClientTagOption
}

/**
 * タグ配列から代表値文字列を返す。
 * - tags.length === 0 → undefined (sortUndefined:'last' で末尾扱い)。
 * - 代表値 = TagCell 表示順 (compareTagEntry: category ASC → option ASC) で並べた
 *   先頭タグの `{category.name}: {option.name}`。
 * - 元配列は変更しない (スプレッドコピーでソート)。
 */
export function tagSortKey(tags: TagEntry[]): string | undefined {
  if (tags.length === 0) return undefined
  const first = [...tags].sort(compareTagEntry)[0]
  return `${first.category.name}: ${first.option.name}`
}
