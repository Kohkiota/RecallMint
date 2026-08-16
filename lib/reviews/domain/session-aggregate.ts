// 復習 event の fold domain (純粋)。runtime import は pure sibling (replayCard) のみ —
// drizzle / @/lib/db / logger / next / zod は import しない (型は import type)。
//
// 責務は 2 つだけ:
//   planFold   — 適用対象の選別 (card ロック済み + A-2 option 実在) と per-card 整列
//   foldSession — 順序ガード (>=) 付きの FSRS fold
// 冪等 (event_id) / 直列化 (FOR UPDATE) / 集計 (study_days) は infra 側の責務。

import { replayCard, type ReplayCardState } from '@/lib/cards/replay-card'
import type { RatingInt } from '@/lib/fsrs'
import type { ReviewLog as FsrsReviewLog } from 'ts-fsrs'

// ---------------------------------------------------------------------------
// 入力型 — domain 内で最小 structural に定義 (zod infer 型に依存しない)。
// answered_at は clamp 済みの Date (clamp は orchestrator の責務・spec §2.3)。
// ---------------------------------------------------------------------------

export interface FoldEvent {
  eventId: string
  cardId: string
  selectedAnswerIds: string[]
  isCorrect: boolean
  rating: RatingInt
  answeredAt: Date
}

// applied=false の理由。構造化 log にそのまま載せる (列は増やさない — spec 裁定)。
export type FoldSkipReason = 'card_not_locked' | 'unknown_option'

export interface FoldPlan {
  /** cardId → answered_at 昇順 (同時刻は入力順) の適用候補。 */
  groups: Map<string, FoldEvent[]>
  skipped: { eventId: string; cardId: string; reason: FoldSkipReason }[]
}

// ---------------------------------------------------------------------------
// buildCardOptionIndex — options jsonb を cardId → 実在 option id Set に正規化。
// options が非配列/壊れ値の既存データは空 Set 扱い (fail-closed — selected が非空なら
// planFold で applied=false)。壊れ要素 (null / id 欠落 / id 非 string) は element 単位で
// 握り潰す (要素単位で throw すると payload 全体が巻き添えで失敗するため)。
// ---------------------------------------------------------------------------

export function buildCardOptionIndex(
  rows: { id: string; options: unknown }[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const row of rows) {
    const options = row.options
    index.set(
      row.id,
      new Set(
        Array.isArray(options)
          ? (options as unknown[])
              .map((o) =>
                o != null && typeof (o as { id?: unknown }).id === 'string'
                  ? (o as { id: string }).id
                  : null,
              )
              .filter((id): id is string => id !== null)
          : [],
      ),
    )
  }
  return index
}

// ---------------------------------------------------------------------------
// planFold — 適用対象の選別と per-card 整列 (spec §2.2 手順 5 前半)。
//
// 非適用は reject ではなく **applied=false への降格** (event 行は既に insert 済み)。
//   - card_not_locked: 対象 card が owner-scope の FOR UPDATE で返らなかった
//     (削除済み / 他 user / dangling)。
//   - unknown_option:  selected_answer_ids に card の options に無い id が混ざる (A-2)。
// option の読み元は同一 tx でロック済みの cards 行なので、option 編集とも直列化済み。
//
// 整列は answered_at 昇順の stable sort (同時刻は入力順 = payload 順)。順序ガードの
// tie-break を決定的にする (spec §2.4)。
// ---------------------------------------------------------------------------

export function planFold(
  events: FoldEvent[],
  lockedCardIds: Set<string>,
  optionIndex: Map<string, Set<string>>,
): FoldPlan {
  const groups = new Map<string, FoldEvent[]>()
  const skipped: FoldPlan['skipped'] = []

  for (const ev of events) {
    if (!lockedCardIds.has(ev.cardId)) {
      skipped.push({ eventId: ev.eventId, cardId: ev.cardId, reason: 'card_not_locked' })
      continue
    }
    const validOptionIds = optionIndex.get(ev.cardId) ?? new Set<string>()
    if (ev.selectedAnswerIds.some((id) => !validOptionIds.has(id))) {
      skipped.push({ eventId: ev.eventId, cardId: ev.cardId, reason: 'unknown_option' })
      continue
    }
    const group = groups.get(ev.cardId) ?? []
    group.push(ev)
    groups.set(ev.cardId, group)
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime())
  }

  return { groups, skipped }
}

// review_logs 永続化 (R0 Task 3) 向けに fold 過程で回収する 1 event 分の ReviewLog。
// eventId/cardId は帰属、log は rate() の生 ReviewLog (before 値を含む)、after は
// 適用直後の card state から抜いた 3 値 (spec §3.3 — 同時刻 event の導出曖昧性回避
// のため log 自体からは after を導出せず fold 側で持つ)。
// **Task 2 時点では消費者が存在しない過渡的な戻り値** (書込は Task 3)。
export type AppliedReviewLog = {
  eventId: string
  cardId: string
  log: FsrsReviewLog
  after: { state: 0 | 1 | 2 | 3; stability: number; difficulty: number }
}

// ---------------------------------------------------------------------------
// foldSession — 順序ガード付き FSRS fold (spec §2.2 手順 5 後半 / §2.4)。
//
// 適用条件 = `lastReview === null || answeredAt >= lastReview`。境界は `>=` —
// 同時刻は時系列逆転ではないため適用する (重複排除は event_id PK が担う)。
// 厳密に古い event だけが skip され applied=false のまま残る。
//
// finalStates には **1 件以上適用された card のみ** を入れる (全 skip の card を
// 入れると無変化 UPDATE を発行することになるため)。
//
// appliedLogs は適用された event と 1:1 (skip された event は入らない) —
// replayCard を event 1 件ずつ呼ぶため logs[0] が常にその event の log になる。
// ---------------------------------------------------------------------------

export function foldSession(
  cardStates: Map<string, ReplayCardState>,
  plan: FoldPlan,
): {
  finalStates: Map<string, ReplayCardState>
  appliedEventIds: Set<string>
  appliedLogs: AppliedReviewLog[]
} {
  const finalStates = new Map<string, ReplayCardState>()
  const appliedEventIds = new Set<string>()
  const appliedLogs: AppliedReviewLog[] = []

  for (const [cardId, groupEvents] of plan.groups) {
    // planFold が lockedCardIds で絞った後なので cardStates には必ず存在する
    // (両者とも同じ FOR UPDATE 結果から組まれる)。
    let current = cardStates.get(cardId)!
    let applied = false
    for (const ev of groupEvents) {
      if (
        current.lastReview !== null &&
        ev.answeredAt.getTime() < current.lastReview.getTime()
      ) {
        continue
      }
      const result = replayCard(current, [
        { rating: ev.rating, isCorrect: ev.isCorrect, answeredAt: ev.answeredAt },
      ])
      current = result.state
      appliedEventIds.add(ev.eventId)
      appliedLogs.push({
        eventId: ev.eventId,
        cardId,
        log: result.logs[0],
        after: {
          state: current.state,
          stability: current.stability,
          difficulty: current.difficulty,
        },
      })
      applied = true
    }
    if (applied) finalStates.set(cardId, current)
  }

  return { finalStates, appliedEventIds, appliedLogs }
}
