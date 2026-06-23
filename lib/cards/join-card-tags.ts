// join-card-tags — card × card_tags × categories × options の join 純関数。
// Dexie / getClientDb に依存しない (既読配列を受け取る)。
// サーバー・クライアント両側から利用可能、 unit テストも fake-indexeddb 不要。

import type { ClientCard, ClientCardTag, ClientTagCategory, ClientTagOption } from '@/lib/client-db'

export type CardWithTags = {
  card: ClientCard
  tags: Array<{ category: ClientTagCategory; option: ClientTagOption }>
}

/**
 * cards に card_tags / categories / options を join して CardWithTags[] を返す。
 *
 * skip 規則 (exam-card-table.tsx 由来): option 不在 → skip、 category 不在 → skip。
 * cards の順序は保持される。 タグなしカードは tags: [] で結果に含まれる。
 */
export function joinCardTags(
  cards: ClientCard[],
  cardTags: ClientCardTag[],
  categories: ClientTagCategory[],
  options: ClientTagOption[],
): CardWithTags[] {
  const tagsByCardId = new Map<string, CardWithTags['tags']>()
  for (const ct of cardTags) {
    const option = options.find((o) => o.id === ct.option_id)
    if (!option) continue
    const category = categories.find((c) => c.id === option.category_id)
    if (!category) continue
    const arr = tagsByCardId.get(ct.card_id) ?? []
    arr.push({ category, option })
    tagsByCardId.set(ct.card_id, arr)
  }
  return cards.map((c) => ({
    card: c,
    tags: tagsByCardId.get(c.id) ?? [],
  }))
}
