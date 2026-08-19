// home-aggregate — Home(/app)の共有集計(spec §3.1「性能(共有集計)」)。
// cards を読むウィジェット(W2 の n/m・W3 の 3 区分 + 持ち越し・W5 の母集合件数・
// W6 の 7 本)が個別に Dexie を走査しないよう、client root が 1 回読んだカード配列を
// **単一 pass** でまとめて数える。
//
// 判定規則そのものは持たない: 3 区分 / 持ち越し / 間違い / 未出題 / 苦手はすべて
// `card-classification.ts` の pure 述語(= client と server の唯一の定義)へ委譲し、
// 本 module は「どの母集合を何回数えるか」だけを担う(二重実装しない)。
//
// 出題プール(k・nextAvailableAt・実プール)は本 module では扱わない —
// `lib/cards/domain/session-pool.ts:selectSessionPool` が唯一の実装で、Home は
// その返り値をそのまま消費する(Ruling 4)。
//
// PURE 制約(lib/dashboard/domain の前例に従う): I/O なし・Dexie / DB / next / zod を
// import しない。`now` は必ず引数で受け取る。
//
// 他試験のカードを入力に含める理由: spec §3.1 の「他の試験: 復習 n 件」(ヘッダ直下
// 1 行)は選択試験の外を数えるため、選択試験だけを読む query では出せない。同じ
// 1 pass の中で `exam_id` を見て振り分けることで、read も走査も 1 回のままにする。

import { addDays } from '@/lib/streak-core'
import { jstDayRange, todayInJst } from '@/lib/jst'
import { FORECAST_DAYS } from './metric-constants'
import {
  classifyCard,
  isCarryoverAt,
  isMistake,
  isUnanswered,
  isWeak,
} from './card-classification'

/**
 * 集計に要る最小フィールド。命名は DB 列名(snake_case)に揃える —
 * `card-classification.ts` と同じ入力契約(呼出側が自分の表現から詰め替える)。
 */
export interface HomeAggregateCard {
  exam_id: string
  state: 0 | 1 | 2 | 3
  stability: number
  due: Date | string
  lapses: number
  answered: boolean
  last_correct?: boolean | null
}

export interface HomeAggregate {
  /** 選択試験の総カード数(§5「試験あり・カード 0」の判定)。 */
  totalCards: number
  /** 未学習(A)。 */
  newCards: number
  /** 学習中(B)。 */
  learningCards: number
  /** 定着(C)。 */
  matureCards: number
  /** m = 復習の持ち越し(D)。n の内数。 */
  carryover: number
  /** n = 復習(定義 doc W2)。`forecast[0]` と同値(定義 doc W6 の合算規則)。 */
  reviewDueToday: number
  /** W6 の 7 本(index 0 = 今日)。今日のバーは持ち越し合算。 */
  forecast: number[]
  /** W6 の母集合 = state !== 0 のカード数。0 ならウィジェットごと非表示。 */
  forecastPopulation: number
  /** W5「間違い」の母集合件数(E)。 */
  mistakeCards: number
  /** W5「未出題」の母集合件数(F)。 */
  unansweredCards: number
  /** W5「苦手」の母集合件数(H)。 */
  weakCards: number
  /** 選択試験以外の n の合計(spec §3.1 の他試験 1 行)。 */
  otherExamsReviewDueToday: number
}

export interface AggregateHomeCardsInput<T extends HomeAggregateCard> {
  /** owner scope の全カード(選択試験外を含む)。 */
  readonly cards: readonly T[]
  readonly examId: string
  readonly now: Date
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function aggregateHomeCards<T extends HomeAggregateCard>(
  input: AggregateHomeCardsInput<T>,
): HomeAggregate {
  const { cards, examId, now } = input
  const today = todayInJst(now)
  const todayStart = jstDayRange(today).startAt
  // 7 日ぶんの終端 instant。カードごとに再計算しないようループ外で 1 度だけ作る
  // (`isCarryoverAt` を使う理由と同じ — 境界は定数)。
  const dayEnds: Date[] = []
  for (let i = 0; i < FORECAST_DAYS; i++) {
    dayEnds.push(jstDayRange(addDays(today, i)).endAt)
  }

  const forecast = new Array<number>(FORECAST_DAYS).fill(0)
  let totalCards = 0
  let newCards = 0
  let learningCards = 0
  let matureCards = 0
  let carryover = 0
  let forecastPopulation = 0
  let mistakeCards = 0
  let unansweredCards = 0
  let weakCards = 0
  let otherExamsReviewDueToday = 0

  for (const c of cards) {
    if (c.exam_id !== examId) {
      // 他試験は n だけ数える(ヘッダ直下 1 行の合計)。
      if (c.state !== 0 && toDate(c.due) < dayEnds[0]) otherExamsReviewDueToday += 1
      continue
    }

    totalCards += 1
    switch (classifyCard(c)) {
      case 'new':
        newCards += 1
        break
      case 'learning':
        learningCards += 1
        break
      case 'mature':
        matureCards += 1
        break
    }

    if (isCarryoverAt(c, todayStart)) carryover += 1
    if (isMistake({ answered: c.answered, last_correct: c.last_correct ?? null }))
      mistakeCards += 1
    if (isUnanswered(c)) unansweredCards += 1
    if (isWeak(c)) weakCards += 1

    if (c.state === 0) continue
    forecastPopulation += 1
    const due = toDate(c.due)
    // 今日のバーだけは「今日の終わりまで」= 持ち越し合算(定義 doc W6)。以降は
    // 各日の [開始, 終了) で、前日の終了が翌日の開始と一致するため上端比較で足りる。
    for (let i = 0; i < FORECAST_DAYS; i++) {
      if (due < dayEnds[i]) {
        forecast[i] += 1
        break
      }
    }
  }

  return {
    totalCards,
    newCards,
    learningCards,
    matureCards,
    carryover,
    // n の定義(state!==0 かつ due < 今日の終わり)は W6 の今日バーと同一式なので、
    // 2 度数えず 1 つの値を共有する(定義 doc W6「今日のバー = W2 の n と一致する」)。
    reviewDueToday: forecast[0],
    forecast,
    forecastPopulation,
    mistakeCards,
    unansweredCards,
    weakCards,
    otherExamsReviewDueToday,
  }
}
