// Session aggregate (純粋 domain)。 「session 行の状態規則」+「event 処理の
// 不変条件」の単一 domain module (関数群・class にしない)。 runtime import は
// pure sibling のみ (replayCard / todayInJst)。 drizzle / @/lib/db / logger /
// next / zod は import しない (型は import type)。
//
// 挙動不変制約: 各関数は現 lib/reviews/ingest-review-events.ts の該当ロジックを
// verbatim (挙動同一) に移設したコピー。R phase は additive only — 本 module は
// 誰からも import されない (配線は W = 別 task)。行番号は spec §3.2 / brief の表を参照。

import { replayCard, type ReplayCardState } from '@/lib/cards/replay-card'
import type { RatingInt } from '@/lib/fsrs'
import { todayInJst } from '@/lib/jst'

// ---------------------------------------------------------------------------
// 入力型 — domain 内で最小 structural に定義 (zod infer 型に依存しない)。
// ingest の ParsedEvent が構造的に適合する形。
// ---------------------------------------------------------------------------

export interface AnswerEventInput {
  event_id: string
  card_id: string
  selected_answer_ids: string[]
  is_correct: boolean
  answered_at: string
  rating?: RatingInt
  elapsed_ms?: number
}

// replayCard fold の per-card group + reviews 行。
export interface ReviewRow {
  cardId: string
  rating: RatingInt
  reviewedAt: Date
}

// JST day ごとの count 集計 (distinct 集計 SQL は含めない = repository の責務)。
export interface DayCount {
  total: number
  correct: number
}

// ---------------------------------------------------------------------------
// deriveRating — FSRS rating を一元的に決める唯一の箇所 (P0 §A #7 凍結契約)。
// payload 指定を優先し、未指定は is_correct から derive (true→Good(3) / false→Again(1))。
// replay と study_days 集計の両方から呼び、2 箇所で derive ロジックがズレるのを防ぐ。
// ingest-review-events.ts:70-72 verbatim (シグネチャ不変)。
// ---------------------------------------------------------------------------

export function deriveRating(
  ev: Pick<AnswerEventInput, 'rating' | 'is_correct'>,
): RatingInt {
  return ev.rating ?? (ev.is_correct ? 3 : 1)
}

// ---------------------------------------------------------------------------
// buildCardOptionIndex — options jsonb を cardId → 実在 option id Set に正規化。
// options が非配列/壊れ値の既存データは空 Set 扱い (fail-closed — selected が非空なら
// admitEvents で reject)。壊れ要素 (null / id 欠落 / id 非 string) は element 単位で
// 握り潰す (要素単位で throw すると Phase 1 が巻き添えで failed になるため)。
// ingest-review-events.ts:158-175 verbatim。A-2(e) fail-closed を domain test で
// 直接見えるよう repo でなく domain に置く。
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
// admitEvents — 不変条件 #2 (orphan) + #7 (A-2 存在検証) の統合 admission。
// knownCards の key で orphan 判定 (!has(card_id))、value Set で A-2 判定
// (selected_answer_ids の全 id が Set に実在するか)。1 つでも欠ければ orphan と
// 同列の rejected へ (event_id flat 配列 = 現 wire failed[] と同形)。空 selected は pass。
// ingest-review-events.ts:179-196 verbatim。
// ---------------------------------------------------------------------------

export function admitEvents(
  events: AnswerEventInput[],
  knownCards: Map<string, Set<string>>,
): { applicable: AnswerEventInput[]; rejected: string[] } {
  const applicable: AnswerEventInput[] = []
  const rejected: string[] = []
  for (const ev of events) {
    if (!knownCards.has(ev.card_id)) {
      rejected.push(ev.event_id)
      continue
    }
    const validOptionIds = knownCards.get(ev.card_id)!
    const hasUnknownOption = ev.selected_answer_ids.some(
      (id) => !validOptionIds.has(id),
    )
    if (hasUnknownOption) {
      rejected.push(ev.event_id)
    } else {
      applicable.push(ev)
    }
  }
  return { applicable, rejected }
}

// ---------------------------------------------------------------------------
// planReplay — 不変条件 #1 の replay gating + intra-payload dedup + #3 の
// payload 順 per-card group。
//   - insertedEventIds にある → 新規 insert 確定 → apply
//   - ない → duplicate (既処理) → skip
//   - consumedSet: 同 payload 内の重複 event_id を最初の出現のみ apply
// group Map は insertion order (payload 順) で card_id 初出順を保持する。
// ingest-review-events.ts:225-255 verbatim。
// ---------------------------------------------------------------------------

export function planReplay(
  applicable: AnswerEventInput[],
  insertedEventIds: Set<string>,
): Map<string, AnswerEventInput[]> {
  const consumedSet = new Set<string>()
  const eventsToApply = applicable.filter((ev) => {
    if (!insertedEventIds.has(ev.event_id)) return false // duplicate → skip
    if (consumedSet.has(ev.event_id)) return false // intra-payload dedup
    consumedSet.add(ev.event_id)
    return true
  })

  // グループ化 (insertion order で Map → payload 順保持)
  const grouped = new Map<string, AnswerEventInput[]>()
  for (const ev of eventsToApply) {
    const arr = grouped.get(ev.card_id) ?? []
    arr.push(ev)
    grouped.set(ev.card_id, arr)
  }
  return grouped
}

// ---------------------------------------------------------------------------
// replaySession — per-card group を replayCard で fold し、finalStates と
// reviewRows を組む。reviews 行は groupEvents と reviewsOut を zip して
// eventsToApply 順に戻す。replayCard は pure sibling import。
// ingest-review-events.ts:257-274 verbatim。
// ---------------------------------------------------------------------------

export function replaySession(
  cardStates: Map<string, ReplayCardState>,
  groups: Map<string, AnswerEventInput[]>,
): { finalStates: Map<string, ReplayCardState>; reviewRows: ReviewRow[] } {
  const reviewRows: ReviewRow[] = []
  const finalStates = new Map<string, ReplayCardState>()

  for (const [cardId, groupEvents] of groups) {
    const initial = cardStates.get(cardId)!
    const replayEvents = groupEvents.map((ev) => ({
      // payload rating 優先、未指定は is_correct から derive
      rating: deriveRating(ev),
      answeredAt: new Date(ev.answered_at),
    }))
    const { final, reviews: reviewsOut } = replayCard(initial, replayEvents)
    finalStates.set(cardId, final)
    // reviews 行を eventsToApply 順に戻すため groupEvents と reviewsOut を zip
    for (let i = 0; i < groupEvents.length; i++) {
      reviewRows.push({
        cardId,
        rating: reviewsOut[i].rating,
        reviewedAt: reviewsOut[i].reviewedAt,
      })
    }
  }
  return { finalStates, reviewRows }
}

// ---------------------------------------------------------------------------
// aggregateStudyDays — 不変条件 #5 の JST 集計 core。answered_at を JST date で
// グループ化して count 集計 (total = 全件、correct = rating>=2)。distinct 集計 SQL は
// 含めない (それは repository)。todayInJst は pure sibling。
// ingest-review-events.ts:357-366 verbatim。
// ---------------------------------------------------------------------------

export function aggregateStudyDays(
  eventsToApply: AnswerEventInput[],
): Map<string, DayCount> {
  const dayMap = new Map<string, DayCount>()
  for (const ev of eventsToApply) {
    const day = todayInJst(new Date(ev.answered_at))
    const rating = deriveRating(ev)
    const existing = dayMap.get(day) ?? { total: 0, correct: 0 }
    existing.total += 1
    if (rating >= 2) existing.correct += 1
    dayMap.set(day, existing)
  }
  return dayMap
}
