// session-pool — スマート復習(/app/study/smart)の出題プール選定の唯一の実装
// (Dash-1 Home v1 design doc §8.4 / §8.5)。
//
// 「W2 の表示」と「CTA の実出題」が食い違わないことが本 module の存在理由なので、
// client(Dexie)/ server(fallback)/ Home の 3 消費者が **1 回の呼び出しで必要な
// 値を全部受け取る**形にしてある(pool / reviewCount / newCount / nextAvailableAt)。
// 分けて計算させると条件が 2 箇所に増えて必ずずれる(spec §8.5「client / server
// fallback の同値性」)。
//
// PURE 制約(lib/cards/domain の前例に従う): I/O なし・Dexie / drizzle / next / zod を
// import しない。`now` は必ず引数で受け取る(内部で `new Date()` を呼ばない)。
// 日界は既存 `lib/jst.ts` の 2 関数のみを使う(新規定義しない)。

import { DAILY_NEW_DEFAULT } from '@/lib/dashboard/domain/metric-constants'
import { jstDayRange, todayInJst } from '@/lib/jst'
import { compareByBaseOrderAcrossExams } from '@/lib/cards/domain/card-order'

/**
 * プール選定に要る最小フィールド。命名は DB 列名(snake_case)に揃える —
 * server(drizzle)は camelCase、client(Dexie `ClientCard`)は snake_case なので、
 * 呼び出し元が自分の側でこの形に詰め替える(`card-classification.ts` と同じ入力契約。
 * 表現差の吸収は境界で行い、選定ロジックは分岐させない)。
 *
 * `due` / `first_reviewed_at` が `Date | string` の両対応なのも同じ理由
 * (Dexie は ISO 文字列、server は `Date`)。
 */
export interface SessionPoolCard {
  id: string
  exam_id: string
  state: 0 | 1 | 2 | 3
  due: Date | string
  base_order: number
  first_reviewed_at?: Date | string | null
}

export interface SelectSessionPoolInput<T extends SessionPoolCard> {
  /** 候補カード。選択試験以外・不要な行が混ざっていてよい(本関数が絞る)。 */
  readonly cards: readonly T[]
  /** 選択中の試験(spec §8.5: スマート復習は全試験横断でなく選択試験スコープ)。 */
  readonly examId: string
  /** K = `exams.daily_new_target`。null は「未設定」で `DAILY_NEW_DEFAULT` に追従。 */
  readonly dailyNewTarget: number | null
  readonly now: Date
}

export interface SessionPoolResult<T extends SessionPoolCard> {
  /** 復習部(due ASC)+ 新規部(base_order ASC)の連結。`session_limit` cap は未適用。 */
  readonly pool: T[]
  /** 復習部の件数。W2 の n(= 今日の終わりまでの全 state≠0)とは一致しない(§8.5 の既知差)。 */
  readonly reviewCount: number
  /** 新規部の件数 = k = min(max(K − u, 0), 新規カード数)。W2 内訳の k と同値。 */
  readonly newCount: number
  /** 未到来ゆえプール外に落ちた Learning/Relearning の最小 due(該当なしは null)。 */
  readonly nextAvailableAt: Date | null
}

// 既存 timestamp の表現変換のみ(「今」の生成ではないので PURE 制約に抵触しない)。
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

// 復習部の全順序 `(due ASC, id ASC)`。id の tiebreak が無いと Dexie の行順(PK 順)と
// server の行順(SQL 未指定順)で結果が変わりうる = 同値性 pin が守れない。
function compareByDue(a: SessionPoolCard, b: SessionPoolCard): number {
  const aDue = toDate(a.due).getTime()
  const bDue = toDate(b.due).getTime()
  if (aDue !== bDue) return aDue - bDue
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * 出題プールを選ぶ(spec §8.5 の state 別条件 + §8.4 の新規 k 件)。
 *
 * 復習部(state ≠ 0):
 * - Review(state 2)は `due < 今日の終わり(JST)` — 当日 later-due の前倒しを許す
 *   (Review の due は日粒度運用が標準で、W2 の n も 1 日単位で数えるため)。
 * - Learning / Relearning(state 1 / 3)は `due <= now` のみ — 分〜時間単位の短期
 *   step を前倒しすると FSRS の短期スケジュールそのものを壊す(朝に夜の step を
 *   出してしまう)。未到来分は `nextAvailableAt` として返し、UI が「次の復習は
 *   ◯時頃」を出せるようにする。
 *
 * 新規部(state = 0)は base_order 昇順(教材順)で k 件。
 * `k = min(max(K − u, 0), 新規カード数)`、u = 当該 JST 日に導入済み
 * (`first_reviewed_at` が今日)のカード数 = daily-new-limit の残り枠。
 *
 * u を引数で受けず本関数が同じ `cards` から数えるのは、呼び出し元ごとに u の
 * 数え方がずれる余地を消すため(soft limit の強制点は選定時のみ — §8.3)。
 */
export function selectSessionPool<T extends SessionPoolCard>(
  input: SelectSessionPoolInput<T>,
): SessionPoolResult<T> {
  const { cards, examId, dailyNewTarget, now } = input
  const { startAt, endAt } = jstDayRange(todayInJst(now))

  const reviewPart: T[] = []
  const newCandidates: T[] = []
  let introducedToday = 0
  let nextAvailableAt: Date | null = null

  for (const card of cards) {
    if (card.exam_id !== examId) continue

    // u(当日導入数)。カード移動 = 現在の exam_id で数える(spec §8.3 の現在状態
    // 意味論)ため、exam scope の絞り込みの内側で数える。
    if (card.first_reviewed_at != null) {
      const firstReviewedAt = toDate(card.first_reviewed_at)
      if (firstReviewedAt >= startAt && firstReviewedAt < endAt) introducedToday += 1
    }

    if (card.state === 0) {
      newCandidates.push(card)
      continue
    }

    const due = toDate(card.due)
    if (card.state === 2) {
      if (due < endAt) reviewPart.push(card)
      continue
    }

    // state 1 / 3(Learning / Relearning)。
    if (due <= now) {
      reviewPart.push(card)
    } else if (nextAvailableAt === null || due < nextAvailableAt) {
      // 「まだ出せない」で落ちた候補だけを数える。Review の翌日以降 due は
      // 「今日の対象ではない」であって「まもなく出せる」ではないため含めない
      // (spec §8.5: nextAvailableAt = 未到来 Learning/Relearning の最小 due)。
      nextAvailableAt = due
    }
  }

  reviewPart.sort(compareByDue)

  const dailyNewLimit = dailyNewTarget ?? DAILY_NEW_DEFAULT
  const remainingBudget = Math.max(dailyNewLimit - introducedToday, 0)
  const newPart = newCandidates
    .sort(compareByBaseOrderAcrossExams)
    .slice(0, remainingBudget)

  return {
    pool: [...reviewPart, ...newPart],
    reviewCount: reviewPart.length,
    newCount: newPart.length,
    nextAvailableAt,
  }
}
