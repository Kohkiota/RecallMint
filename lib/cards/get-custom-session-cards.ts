// get-custom-session-cards — Dexie 全 exam 横断で custom session 用 card を選定する
// pure lib module (S2.3 T3)。 'use client' 不要: getClientDb がブラウザ専用だが
// lib module として server-side で呼ばれた場合は getClientDb が自然に throw する。
//
// 処理順序 (仕様確定、変更禁止):
//   1. Dexie からテナント cards 全件 + tag master + card_tags を読む
//   2. joinCardTags で card × tags を結合
//   3. 述語 AND (exam / tag / answerState / streak) で絞り込む
//   4. 順序付け: sequential → sortLikeServer / random → Fisher-Yates(rng)
//   5. limit cap (null = 全件)
//   6. toCard で server Card 型に変換 (LAST ステップ)

import { getClientDb } from '@/lib/client-db'
import { joinCardTags, type CardWithTags } from '@/lib/cards/join-card-tags'
import {
  matchesExamFilter,
  matchesTagFilter,
  matchesAnswerState,
  matchesStreakFilter,
  type TagFilterValue,
  type AnswerStateFilter,
  type StreakFilterValue,
} from '@/lib/cards/card-filter-predicates'
import { toCard } from '@/lib/db/cards-mapper'
import { sortLikeServer } from '@/lib/cards/sort-like-server'
import type { Card } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// 入力型
// ---------------------------------------------------------------------------

export type CustomSessionCriteria = {
  userId: string
  /** 絞り込む exam の id 集合。 空配列 = 全 exam (絞り込みなし)。 */
  examIds: string[]
  tagFilter: TagFilterValue
  answerState: AnswerStateFilter
  streakFilter: StreakFilterValue | null
  order: 'random' | 'sequential'
  /** null = 全件 (cap 無効)。 */
  limit: number | null
}

// ---------------------------------------------------------------------------
// Fisher-Yates in-place shuffle
// ---------------------------------------------------------------------------

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  // Knuth shuffle: 末尾から前方へ、 [0, i] の範囲から乱択して swap
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 選定コア: Dexie 読込 → joinCardTags → 述語 AND → 順序 → cap。
 * tags を保持した CardWithTags[] を返す (toCard しない)。
 * プレビュー表示がタグ付き出題リストを得るために抽出。
 *
 * @param c   セッション選定基準
 * @param rng 乱数生成器 (order='random' 時の Fisher-Yates に使用)。 既定 Math.random。
 */
export async function selectCustomSessionRows(
  c: CustomSessionCriteria,
  rng: () => number = Math.random,
): Promise<CardWithTags[]> {
  const db = getClientDb()

  // Step 1: Dexie 読み込み (due gate なし — 全 exam 横断)
  const allCards = await db.cards.where('user_id').equals(c.userId).toArray()

  const [categories, options] = await Promise.all([
    db.tag_categories.toArray(),
    db.tag_options.toArray(),
  ])

  // card_tags は対象 card_id 集合に絞る (T-B5 と同方針: 他 exam の card_tags を無駄読みしない)
  const cardIds = allCards.map((card) => card.id)
  const cardTags =
    cardIds.length === 0
      ? []
      : await db.card_tags.where('card_id').anyOf(cardIds).toArray()

  // Step 2: join
  const withTags = joinCardTags(allCards, cardTags, categories, options)

  // Step 3: 述語 AND 絞り込み
  const filtered = withTags.filter(
    ({ card, tags }) =>
      matchesExamFilter(card, c.examIds) &&
      matchesTagFilter(tags, c.tagFilter) &&
      matchesAnswerState(card, c.answerState) &&
      matchesStreakFilter(card.current_streak, c.streakFilter),
  )

  // Step 4: 順序付け (CardWithTags[] ごと操作してタグを保持。 toCard は Step 6 まで行わない)
  if (c.order === 'sequential') {
    filtered.sort((a, b) => sortLikeServer(a.card, b.card))
  } else {
    shuffleInPlace(filtered, rng)
  }

  // Step 5: limit cap
  return c.limit === null ? filtered : filtered.slice(0, c.limit)
}

/**
 * Dexie から全 exam 横断で custom session 用 Card[] を返す。
 * selectCustomSessionRows のラッパー: 戻り値を server Card 型に変換して返す。
 *
 * @param c   セッション選定基準
 * @param rng 乱数生成器 (order='random' 時の Fisher-Yates に使用)。 既定 Math.random。
 *            テストで確定的な並び順を検証する際は決定論的な関数を注入する。
 */
export async function getCustomSessionCards(
  c: CustomSessionCriteria,
  rng: () => number = Math.random,
): Promise<Card[]> {
  // Step 6: server Card 型に変換 (LAST)
  const rows = await selectCustomSessionRows(c, rng)
  return rows.map((r) => toCard(r.card))
}
