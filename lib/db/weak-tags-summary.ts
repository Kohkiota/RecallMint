// weak-tags-summary — W4「優先して復習」(苦手タグ Top3)の server 集計
// (Dash-1 Home v1 spec §10 の SQL 契約 / 定義 doc §4-P)。v1 で唯一の L3 集計。
//
// 役割境界: route (`app/api/stats/summary/route.ts`) は auth / param 検証 / wire 整形
// だけを行い、SQL はこの module に閉じる (study-days-pull.ts と同じ分離)。tenant 絞り
// 込みは withTenantTx の RLS に任せきりにせず、全 CTE で `user_id = ?` を明示する
// (CLAUDE.md の絶対ルール — RLS は二層目)。
//
// 契約の要点 (spec §10 をそのまま実装する。逸脱は仕様変更):
//   - 復習イベント = applied な answer_events を **card ごとに全期間で**
//     (answered_at ASC, event_id ASC) 番号付けした seq >= 2。番号付けを 30 日窓の
//     内側でやると、窓に入った 2 件目以降が「初見」に化けて分割が壊れる。
//   - 30 日窓は番号付けの **後** に適用する (上の理由の裏返し)。境界は今日を含む
//     30 暦日 = thirtyDayWindowStart(receivedAt)。ローリング 720 時間ではない。
//   - 対象カード = 現存 cards ⋈ card_tags (削除カードは自然に落ちる — 定義 doc §3.3a)。
//     name / category_name は集計時点の現在値 (§3.5)。
//   - 閾値・件数は shared 定数を bind する (SQL に数値を直書きしない)。
//
// 使用 index: `answer_events_user_card_answered_idx (user_id, card_id, answered_at,
// event_id)` — 下の row_number() の PARTITION/ORDER と同順のため sort なしで走れる
// (migration 0040 でこの集計のために追加した)。

import { sql } from 'drizzle-orm'

import {
  WEAK_TAG_MIN_CARDS,
  WEAK_TAG_MIN_REVIEWS,
  WEAK_TAG_TOP_N,
} from '@/lib/dashboard/domain/metric-constants'
import { thirtyDayWindowStart } from '@/lib/dashboard/domain/weekly'

import type { TenantTx } from './tenant-tx'

/** 応答 1 行 (wire 形。snake_case は spec §10 の応答契約そのもの)。 */
export interface WeakTagSummaryRow {
  option_id: string
  name: string
  category_name: string
  /** 0-100 の整数 (round 済)。候補条件 (>= WEAK_TAG_MIN_REVIEWS) により 0 除算は構造的に起きない。 */
  review_accuracy: number
  card_count: number
}

/**
 * 選択中試験の苦手タグを最大 WEAK_TAG_TOP_N 件、復習正答率 昇順で返す。
 *
 * `receivedAt` は呼出側 (handler 冒頭) が 1 回だけ取った評価時刻を渡す — この関数は
 * 時計を読まない (窓の境界が呼出ごとに動かないことを型で強制する)。
 *
 * 実在しない / 他 owner の examId でも例外にせず空配列を返す (exam_cards が空になる
 * だけ — 存在有無を漏らさない spec §10 の挙動はこの構造的帰結)。
 */
export async function getWeakTagsSummary(
  userId: string,
  examId: string,
  tx: TenantTx,
  receivedAt: Date,
): Promise<WeakTagSummaryRow[]> {
  const windowStart = thirtyDayWindowStart(receivedAt)

  // execute の row generic は `Record<string, unknown>` 制約付き。交差型で index
  // signature を足すだけで、列の型は WeakTagSummaryRow と 1 本のまま保つ。
  const rows = await tx.execute<WeakTagSummaryRow & Record<string, unknown>>(sql`
    WITH exam_cards AS (
      SELECT c.id
        FROM cards c
       WHERE c.user_id = ${userId}::uuid
         AND c.exam_id = ${examId}::uuid
    ),
    tagged AS (
      -- card_tags の PK が (card_id, option_id) なので 1 (card, tag) につき 1 行
      -- = 下の count(*) がそのまま「対象カード数」になる。
      SELECT ct.option_id, ct.card_id
        FROM card_tags ct
        JOIN exam_cards ec ON ec.id = ct.card_id
       WHERE ct.user_id = ${userId}::uuid
    ),
    ranked AS (
      SELECT ae.card_id,
             ae.answered_at,
             ae.is_correct,
             row_number() OVER (
               PARTITION BY ae.card_id
               ORDER BY ae.answered_at ASC, ae.event_id ASC
             ) AS seq
        FROM answer_events ae
       WHERE ae.user_id = ${userId}::uuid
         AND ae.applied
    ),
    review_events AS (
      SELECT r.card_id, r.is_correct
        FROM ranked r
       WHERE r.seq >= 2
         AND r.answered_at >= ${windowStart.toISOString()}::timestamptz
    ),
    tag_cards AS (
      SELECT t.option_id, count(*)::int AS card_count
        FROM tagged t
       GROUP BY t.option_id
    ),
    tag_reviews AS (
      -- 複数タグの付いたカードは各タグへ重複算入する (定義 doc §4-P)。
      SELECT t.option_id,
             count(*)::int AS review_count,
             count(*) FILTER (WHERE re.is_correct)::int AS correct_count
        FROM tagged t
        JOIN review_events re ON re.card_id = t.card_id
       GROUP BY t.option_id
    )
    SELECT tc.option_id::text AS option_id,
           o.name AS name,
           cat.name AS category_name,
           round(100.0 * tr.correct_count / tr.review_count)::int AS review_accuracy,
           tc.card_count AS card_count
      FROM tag_cards tc
      JOIN tag_reviews tr ON tr.option_id = tc.option_id
      JOIN tag_options o ON o.id = tc.option_id AND o.user_id = ${userId}::uuid
      JOIN tag_categories cat ON cat.id = o.category_id AND cat.user_id = ${userId}::uuid
     WHERE tc.card_count >= ${WEAK_TAG_MIN_CARDS}
       AND tr.review_count >= ${WEAK_TAG_MIN_REVIEWS}
     -- 第 1 キーは出力列別名 = **round 後の整数**(生の比率ではない)。表示値と順位の
     -- 基準を一致させ、「表示は同じ 47% なのに並びが違う」を構造的に無くす(§3.10)。
     -- 同率は 対象カード数 降順 → option_id の **text 昇順** (client 側 JS の素の
     -- 文字列比較と同じ順序系に固定する — 定義 doc §4-P / spec §10)。
     ORDER BY review_accuracy ASC, tc.card_count DESC, tc.option_id::text ASC
     LIMIT ${WEAK_TAG_TOP_N}
  `)

  // driver の RowList (Array + count/command 等の meta) を素の配列へ落とす。
  return rows.map((r) => ({
    option_id: r.option_id,
    name: r.name,
    category_name: r.category_name,
    review_accuracy: r.review_accuracy,
    card_count: r.card_count,
  }))
}
