// get-quick-preset-cards — クイック演習(/app/study/quick)の Dexie 選定入口(design
// doc §7)。選定ロジックそのものは `lib/cards/domain/quick-preset-selection.ts`
// (pure)が持ち、本 module は「Dexie から行を読み、owner/試験 scope を確定し、
// server Card 型へ変換する」ことだけを担う(`get-dexie-session-cards.ts` と同型の
// 役割分担・二重実装回避)。
//
// tag entry(W4「この分野を10問」)は preset を無視する独立入口(pure module の
// コメント参照)。母集合が 0 件のときは「タグが存在しない」「選択試験内のどの
// カードにも付いていない」の両方を区別せず 'invalid' を返す(§7 の裁定: tag の
// 不正は home へ戻す)。4 preset の母集合 0 は 'invalid' にせず cards=[] を返す
// — host 側はこの場合を既存 empty UI(SessionLauncher の emptyState)に落とす。

import { getClientDb } from '@/lib/client-db'
import { estimateMedianMs } from '@/lib/dashboard/domain/estimate'
import {
  ESTIMATE_SCAN_LIMIT,
  QUICK_PRESET_N,
} from '@/lib/dashboard/domain/metric-constants'
import { toCard } from '@/lib/db/cards-mapper'
import type { Card } from '@/lib/db/schema'
import {
  effectivePresetCount,
  isQuickPreset,
  quickOrderKindFor,
  selectQuickPresetPopulation,
  sortQuickCandidates,
  tenMinCount,
  type QuickPreset,
} from './domain/quick-preset-selection'

export type QuickSelectionOutcome =
  | { kind: 'cards'; cards: Card[] }
  | { kind: 'invalid' }

/**
 * 自 owner の `answer_events` を local_id 降順(= 新しい順・定義 doc §4-N)で読む。
 * export しているのは Home(W2 の「約◯分」/ W5 の 10分件数)が同じ標本を要るため —
 * 標本の取り方(順序キー・走査上限・owner 絞り)を 2 箇所に書かない。
 * `answer_events` に user_id 単体 index が無いため(`[user_id+sync_status]` のみ)、
 * primary key(local_id)の逆走査 + filter で絞る。`limit` は
 * `ESTIMATE_SCAN_LIMIT`(estimateMedianMs 自身が内部でも同じ上限を再適用するため
 * 二重適用は無害)で無限成長する table の全件走査を避ける。
 */
export async function getRecentElapsedMsSamples(
  userId: string,
): Promise<(number | undefined)[]> {
  const rows = await getClientDb()
    .answer_events.orderBy('local_id')
    .reverse()
    .filter((row) => row.user_id === userId)
    .limit(ESTIMATE_SCAN_LIMIT)
    .toArray()
  return rows.map((row) => row.elapsed_ms)
}

/**
 * preset(4 値)または tag(独立入口)の母集合を選定し、server Card 型で返す。
 *
 * @param preset       4 値のいずれか。`tagOptionId` が与えられているときは無視
 *                     される。未知値 / undefined は(tag も無ければ)'invalid'。
 * @param tagOptionId  W4「この分野を10問」の option_id。与えられたら preset を
 *                     無視して tag 単独母集合を使う。
 */
export async function getQuickPresetCardsFromDexie(
  userId: string,
  examId: string,
  preset: string | undefined,
  tagOptionId: string | undefined,
  sessionLimit: number | null,
  now: Date = new Date(),
): Promise<QuickSelectionOutcome> {
  const db = getClientDb()
  const clientCards = await db.cards
    .where('[user_id+exam_id]')
    .equals([userId, examId])
    .toArray()

  if (tagOptionId !== undefined) {
    // owner scope は mirror の hygiene(sign-out purge / sign-in sweep)が構造的に
    // 保証する(brief 前提)ため、ここでは選択試験スコープのみを検証する: card_tags
    // を option_id で引いた後、examId 内の card id 集合との積を取ることで「タグは
    // 付いているが別試験のカード」を自然に除外する。
    const cardTags = await db.card_tags
      .where('option_id')
      .equals(tagOptionId)
      .toArray()
    const examCardIds = new Set(clientCards.map((c) => c.id))
    const taggedIds = new Set(
      cardTags.filter((t) => examCardIds.has(t.card_id)).map((t) => t.card_id),
    )
    const candidates = clientCards.filter((c) => taggedIds.has(c.id))
    if (candidates.length === 0) return { kind: 'invalid' }
    const sorted = sortQuickCandidates('due', candidates)
    const count = effectivePresetCount(QUICK_PRESET_N, sessionLimit)
    return { kind: 'cards', cards: sorted.slice(0, count).map(toCard) }
  }

  if (preset === undefined || !isQuickPreset(preset)) return { kind: 'invalid' }
  const validPreset: QuickPreset = preset

  if (validPreset === 'ten_min') {
    // exams は PK 読みで owner 固定にならないため、K を採用する前に owner を確認
    // する(get-dexie-session-cards.ts と同方針: 不一致なら未設定扱い = 既定 K)。
    const exam = await db.exams.get(examId)
    const dailyNewTarget =
      exam && exam.user_id === userId ? (exam.daily_new_target ?? null) : null
    const population = selectQuickPresetPopulation({
      cards: clientCards,
      examId,
      preset: validPreset,
      dailyNewTarget,
      now,
    })
    const samples = await getRecentElapsedMsSamples(userId)
    const median = estimateMedianMs(samples)
    const count = effectivePresetCount(tenMinCount(median), sessionLimit)
    // fix round 1/5 I-1: `population` は selectSessionPool の pool(復習部 due ASC
    // → 新規部 base_order ASC の連結)そのものであり、W5 の due ASC 全体再ソートを
    // 適用しない。全体を due で再ソートすると新規カードの due(= 作成時刻)が既存
    // 復習の due より常に古くなり(R-5)、10分プリセットの上位が新規カードで
    // 埋まって復習が 1 件も出題されなくなる(§8.4/§8.5 が定めた順序の逆転)。
    // 定義 doc W5 が「未出題プリセットの順序としてこれで良いかは §6-⑥ の新規選出順
    // と同時に Dash-1 で確認」と留保していた問いの残り半分(§8.4 が未出題側に
    // base_order を裁定した)への回答として、ten_min は selectSessionPool の順序を
    // そのまま採用する(controller ruling・fix round 1/5)。
    return { kind: 'cards', cards: population.slice(0, count).map(toCard) }
  }

  const population = selectQuickPresetPopulation({
    cards: clientCards,
    examId,
    preset: validPreset,
    dailyNewTarget: null,
    now,
  })
  const sorted = sortQuickCandidates(quickOrderKindFor(validPreset), population)
  const count = effectivePresetCount(QUICK_PRESET_N, sessionLimit)
  return { kind: 'cards', cards: sorted.slice(0, count).map(toCard) }
}
