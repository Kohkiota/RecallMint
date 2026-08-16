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
//   呼んでも cards/exams の二重 pull にはならない。 **pullAllStudyDays は guard の外**で、
//   複数箇所から呼べば並走しうる (冪等な full snapshot 置換なので許容している)。
//
// userId (S-local-2 Task 4 / spec §5.2):
// - 呼出元が保有する内部 userId をそのまま渡す。 pullDelta は開始時にこれを capture し
//   cursor の read/write 両方に使う (「現在の user」 を完了時に参照しない)。

import { runGuardedPull } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'

export function pullBack(userId: string, reason: string): void {
  void runGuardedPull({ userId, reason }).catch(() => {})
  void pullAllStudyDays().catch(() => {})
}
