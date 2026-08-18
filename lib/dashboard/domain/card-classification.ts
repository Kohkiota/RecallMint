// card-classification — 定義 doc §4-A/B/C(3 区分 MECE 分類)+ §4-D/E/F/H(述語)の
// 唯一の実装(定義 doc §7.1「分類関数… client のカウンタと server のタグ別集計が同一
// 関数を import する」)。
//
// PURE 制約(lib/*/domain 前例に倣う): I/O なし・DB / Dexie / next / zod / logger を
// import しない。日界は既存 `lib/jst.ts` の 2 関数のみを使う(§3.1 — 新規定義しない)。
// `now` は必ず引数で受け取る(`new Date()` を内部で呼ばない)。

import { jstDayRange, todayInJst } from '@/lib/jst'
import { S_MATURE, WEAK_LAPSES_MIN } from './metric-constants'

/**
 * card 1 件の分類に必要な最小フィールド。命名は定義 doc / DB 列名(snake_case)に揃える
 * — server(drizzle)は camelCase の JS プロパティ、client(Dexie `ClientCard`)は
 * snake_case なので、どちらの呼び出し元も自分の側でこの形へ詰め替えて渡す(本 module 側
 * では変換しない・二重実装を避けるための唯一の入力契約)。
 *
 * `due` は `Date | string` を受け付ける: Dexie は ISO 文字列で保存し、server(drizzle
 * `timestamp`)は `Date` を返す。両呼び出し元が変換なしで自分のネイティブ表現を渡せる
 * ようにするための意図的な広い型(型変換は本 module 内(`toDate`)でのみ行い、呼び出し
 * 側に重複させない)。
 */
export interface CardClassificationInput {
  state: 0 | 1 | 2 | 3
  stability: number
  due: Date | string
  lapses: number
  answered: boolean
  last_correct: boolean | null
}

/** 3 区分 MECE(定義 doc §4-A/B/C)。「復習の持ち越し」はこの 3 区分と直交するため含まない。 */
export type CardClassification = 'new' | 'learning' | 'mature'

function toDate(value: Date | string): Date {
  // `due` の型変換(現在時刻の生成ではなく、既存データの表現変換)。ここでの
  // `new Date(iso)` はハード ルール「`new Date()` を内部で呼ばない」の対象外
  // (対象は「今」の捏造であって、既存 timestamp のパースは含まない)。
  return value instanceof Date ? value : new Date(value)
}

/**
 * 未学習(state=0) / 学習中(state=1,3、または state=2 かつ stability<S_MATURE) /
 * 定着(state=2 かつ stability>=S_MATURE) の 3 値分類(定義 doc §4-A/B/C)。
 */
export function classifyCard(
  card: Pick<CardClassificationInput, 'state' | 'stability'>,
): CardClassification {
  if (card.state === 0) return 'new'
  if (card.state === 2 && card.stability >= S_MATURE) return 'mature'
  return 'learning'
}

/**
 * 復習の持ち越し(定義 doc §4-D)。`state !== 0` かつ `due < 今日の開始(JST)`。
 * 境界は厳密 `<`(今日の開始ちょうどは持ち越しに含めない)。新規カードは
 * `due = 作成時刻` のため `state !== 0` を含めないと大量誤検出する(R-5)。
 *
 * 仕様記述に対応する canonical signature(`now` を渡す)。多数カードに繰り返し
 * 適用する呼び出し元(fix round 1/5 M-4 で想定された T11 の W3/W6 集計等 — 試験内
 * 全カードを毎回 re-render で走査する)は、カードごとに `jstDayRange(todayInJst(now))`
 * を再計算させないよう `isCarryoverAt` + 事前計算した `todayStart` を使うこと
 * (`todayStart` はループ外で 1 度だけ計算すればよい — 定数な境界)。
 */
export function isCarryover(
  card: Pick<CardClassificationInput, 'state' | 'due'>,
  now: Date,
): boolean {
  return isCarryoverAt(card, jstDayRange(todayInJst(now)).startAt)
}

/**
 * `isCarryover` の boundary 事前計算版(定義 doc §4-D と同一判定・fix round 1/5 M-4)。
 * `todayStart` はループ外で 1 度だけ `jstDayRange(todayInJst(now)).startAt` を計算した
 * ものを渡す。判定ロジックの唯一の実装であり `isCarryover` はこちらに委譲する。
 */
export function isCarryoverAt(
  card: Pick<CardClassificationInput, 'state' | 'due'>,
  todayStart: Date,
): boolean {
  if (card.state === 0) return false
  return toDate(card.due) < todayStart
}

/** 間違い(定義 doc §4-E)。「直近が不正解」であって「過去に間違えたことがある」ではない。 */
export function isMistake(
  card: Pick<CardClassificationInput, 'answered' | 'last_correct'>,
): boolean {
  return card.answered === true && card.last_correct === false
}

/** 未出題(定義 doc §4-F)。未学習(A)と同値の集合だが UI 文脈が異なるため名称を分ける。 */
export function isUnanswered(
  card: Pick<CardClassificationInput, 'answered'>,
): boolean {
  return card.answered === false
}

/**
 * 苦手カード(定義 doc §4-H・案 1 確定)。`lapses >= WEAK_LAPSES_MIN && !定着`。
 * lapses は「評価直前の FSRS state が Review の回答を Again と評価した回数」であり、
 * Learning / Relearning での Again では増えない(N-7)— 学習中に苦戦していても
 * Review に到達していなければ lapses は 0 のまま拾わない(§4-H の受容済み限界)。
 */
export function isWeak(
  card: Pick<CardClassificationInput, 'state' | 'stability' | 'lapses'>,
): boolean {
  return card.lapses >= WEAK_LAPSES_MIN && classifyCard(card) !== 'mature'
}
