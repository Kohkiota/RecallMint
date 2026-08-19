// quick-preset-selection — クイック演習(/app/study/quick)の母集合・順序・件数選定
// (design doc §7 / 定義 doc W5)の唯一の実装。4 preset(mistakes/unanswered/weak/
// ten_min)+ tag entry(W4「この分野を10問」)の選定規則をここに 1 定義し、client
// host の I/O 層(`lib/cards/get-quick-preset-cards.ts`)から呼ばれる。
//
// tag entry と preset の関係(設計判断・記録): design doc §7 の URL grammar は tag を
// preset の任意付随パラメータのように書くが、W5「選出規則」の tag 段落は「母集合 =
// 当該タグが付く選択試験内カード」を完全に独立に再定義しており、mistakes/
// unanswered/weak の述語と交差させる記述が無い。定義 doc §5 の origin テーブルも
// `home_weak_tags` の入口を `/app/study/quick?tag=` と preset 抜きで示す。これらを
// 踏まえ、**tag が与えられたら preset の値を無視し、tag 単独で母集合・順序(due
// ASC)・件数(10)・origin(home_weak_tags)を決める、4 preset とは別枠の入口**として
// 扱う(host 側の分岐・§7 参照)。
//
// PURE 制約(lib/cards/domain の前例に従う): I/O なし・Dexie / drizzle / next / zod を
// import しない。`now` は必ず引数で受け取る。

import {
  isMistake,
  isUnanswered,
  isWeak,
} from '@/lib/dashboard/domain/card-classification'
import type { OriginValue } from '@/lib/dashboard/domain/origin-values'
import { compareByBaseOrderAcrossExams } from './card-order'
import { compareByDue, selectSessionPool, type SessionPoolCard } from './session-pool'

/** クイック演習(W5)の 4 preset(design doc §7)。 */
export const QUICK_PRESETS = ['mistakes', 'unanswered', 'weak', 'ten_min'] as const
export type QuickPreset = (typeof QUICK_PRESETS)[number]

/** 既知 4 値の判定(未知 preset は home へ戻す・§7)。 */
export function isQuickPreset(value: string): value is QuickPreset {
  return (QUICK_PRESETS as readonly string[]).includes(value)
}

/**
 * 選定に要る最小フィールド。`SessionPoolCard` を継承する(ten_min が
 * `selectSessionPool` をそのまま使うため)。`last_correct` は Dexie `ClientCard` の
 * 実体(optional field)に合わせて optional にしてある — `card-classification.ts`
 * (既存 pure module)の `CardClassificationInput.last_correct` は必須のため、本
 * module 内で `isMistake` を呼ぶ箇所だけ `?? null` で正規化する(既存 module の型
 * 契約は変更しない)。
 */
export interface QuickPresetCard extends SessionPoolCard {
  stability: number
  lapses: number
  answered: boolean
  last_correct?: boolean | null
}

export interface SelectQuickPopulationInput<T extends QuickPresetCard> {
  readonly cards: readonly T[]
  readonly examId: string
  readonly preset: QuickPreset
  /** ten_min(W2 の出題プール計算)専用。他 preset では無視される。 */
  readonly dailyNewTarget: number | null
  readonly now: Date
}

/**
 * preset の母集合(ten_min のみソート済・他は未ソート・cap 未適用)。ten_min は
 * W2 出題プール(`selectSessionPool`)をそのまま母集合として再利用する(二重実装
 * しない)。fix round 1/5 M-1: これは §4 W5「10分の母集合 = W2 の n+k」の**同一
 * 集合ではない** — `pool ⊆ n+k` である(§8.5 が `due > now` の Learning/
 * Relearning 未到来 step を pool から除く。前倒し出題を禁じるのが §8.5 の意図
 * そのものなので、この差は意図どおりの挙動であり bug ではない — 「同じもの」と
 * 書かないことが本コメントの目的)。呼出側(`get-quick-preset-cards.ts`)は
 * `selectSessionPool` の順序(復習部 due ASC → 新規部 base_order ASC の連結)を
 * 保持したまま cap を適用する(fix round 1/5 I-1 — 全体を due で再ソートしない)。
 */
export function selectQuickPresetPopulation<T extends QuickPresetCard>(
  input: SelectQuickPopulationInput<T>,
): T[] {
  const { cards, examId, preset, dailyNewTarget, now } = input

  if (preset === 'ten_min') {
    return selectSessionPool({ cards, examId, dailyNewTarget, now }).pool
  }

  const inExam = cards.filter((c) => c.exam_id === examId)
  switch (preset) {
    case 'mistakes':
      return inExam.filter((c) =>
        isMistake({ answered: c.answered, last_correct: c.last_correct ?? null }),
      )
    case 'unanswered':
      return inExam.filter((c) => isUnanswered(c))
    case 'weak':
      return inExam.filter((c) => isWeak(c))
  }
}

/** 並び順の種別。未出題のみ base_order、他は due(§4 W5「選出規則」)。 */
export type QuickOrderKind = 'due' | 'base_order'

/** preset → 並び順の種別。§8.4 の裁定: 未出題(全カード state=0)のみ base_order。 */
export function quickOrderKindFor(preset: QuickPreset): QuickOrderKind {
  return preset === 'unanswered' ? 'base_order' : 'due'
}

/**
 * `orderKind` に従って cards を並び替える(入力配列は破壊しない)。tag entry は
 * 常に 'due'(§4 W5 の tag 段落)。
 */
export function sortQuickCandidates<T extends QuickPresetCard>(
  orderKind: QuickOrderKind,
  cards: readonly T[],
): T[] {
  const sorted = [...cards]
  sorted.sort(orderKind === 'base_order' ? compareByBaseOrderAcrossExams : compareByDue)
  return sorted
}

/**
 * cap 適用後の件数(§4 W5「選出規則」): `user_settings.session_limit` が
 * defaultCount より小さければ session_limit が勝つ(明示設定は既定値より強い)。
 * null(上限なし)は defaultCount をそのまま使う。
 */
export function effectivePresetCount(
  defaultCount: number,
  sessionLimit: number | null,
): number {
  return sessionLimit === null ? defaultCount : Math.min(defaultCount, sessionLimit)
}

/**
 * 10分プリセットの件数(定義 doc §4-N + W5「10分」)。`perCardMedianMs` は
 * `estimateMedianMs` の戻り値をそのまま渡す。1 問 10 分超でも 0 問にはしない
 * (`floor` だけの帰結を `max(1, …)` で補正 — 定義 doc の明示要求)。
 */
export function tenMinCount(perCardMedianMs: number): number {
  return Math.max(1, Math.floor(600_000 / perCardMedianMs))
}

/**
 * origin 導出(design doc §7 / §11.1)。query の `origin` は一切見ない — 呼出側
 * (host)が preset の確定値だけを渡す。tag entry(host が別途 'home_weak_tags' を
 * 直接使う — 上部コメント参照)はこの関数の対象外: 「tag があれば preset を
 * 無視する」を型で表すため、本関数は常に有効な `QuickPreset` だけを受け取る
 * 4-way exhaustive switch にしてある(呼出条件を分岐で握らない)。
 */
export function deriveQuickOrigin(preset: QuickPreset): OriginValue {
  switch (preset) {
    case 'mistakes':
      return 'home_quick_mistakes'
    case 'unanswered':
      return 'home_quick_unanswered'
    case 'weak':
      return 'home_quick_weak'
    case 'ten_min':
      return 'home_quick_10min'
  }
}
