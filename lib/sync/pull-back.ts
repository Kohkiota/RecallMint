// pull-back helper — flush 成功直後に呼ぶ、 server への引き戻し pull をまとめる。
//
// なぜ 2 関数を分けて fire-and-forget するか:
// - runGuardedPull: cards/exams/tombstone の増分 pull (in-flight guard + Web Locks 付き)。
//   FSRS 計算後にサーバー側で更新された値をローカル mirror に反映する。
// - pullAllStudyDays: study_days の full-window 再取得 (90 日 snapshot)。
//   flush で study_days が変化するため、 dashboard 集計の即時反映に必要。
//
// 各々独立 catch の fire-and-forget を採用する理由:
// - 一方の失敗が他方を止めると、 例えば study_days の network エラーで card mirror 更新が
//   スキップされてしまう。 失敗は silent に握り潰し、 次の pull トリガー (mount/visibility/
//   online) で自然回復させる。
// - in-flight guard / Web Locks は runGuardedPull 側が担うため、 pullBack を複数箇所から
//   呼んでも二重 pull にならない。

import { runGuardedPull } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'

export function pullBack(reason: string): void {
  void runGuardedPull({ reason }).catch(() => {})
  void pullAllStudyDays().catch(() => {})
}
