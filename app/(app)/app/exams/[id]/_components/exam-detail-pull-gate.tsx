'use client'

// ExamDetailPullGate — 試験詳細 page に配線し、詳細滞在中は ambient pull を抑止する
// client component (Stage 3 Task 3.2)。 `return null` — UI なし。
//
// useEffect([examId]) の処理順序:
//   ① 入口 kick を先に発火 (runGuardedPull 直呼び)
//   ② その後 suppress on (suppressAmbientPull)
//   cleanup: resumeAmbientPull (unmount / examId 変化で必ず off)
//
// ① kick が先である理由(belt-and-suspenders):
//   runGuardedPull は suppressAmbientPull フラグを参照しないため入口 kick は
//   suppress 対象外だが、万一フラグ判定が将来移動しても kick が suppress に
//   弾かれないよう、順序でも明示的に担保する。
//
// [examId] 依存にする理由:
//   詳細 A → B のような同一 route segment でのパラメータ変化(remount しないケース)でも
//   cleanup(resume) → 再 effect(kick + suppress) が走り、B 入口で fresh pull +
//   suppress 再確立される。 最終 unmount では cleanup の resume が必ず走るため
//   「離脱で必ず ambient pull が再開する」は構造的に保たれる。
//
// StrictMode 二重 mount(dev):
//   入口 kick は runGuardedPull の in-flight guard が重複を吸収し、
//   suppress / resume は冪等。 最終的に unmount 後は resume(off) で終わる。

import { useEffect } from 'react'
import { runGuardedPull } from '@/lib/sync/pull'
import {
  suppressAmbientPull,
  resumeAmbientPull,
} from '@/lib/sync/ambient-pull-suppress'

type Props = {
  examId: string
}

export function ExamDetailPullGate({ examId }: Props): null {
  useEffect(() => {
    // ① 入口 kick: suppress より先に発火 (suppress に弾かれないよう順序で担保)。
    //    fire-and-forget + silent (結果は観測しない。guard outcome は正常系)。
    //    cards/exams/tombstone のみ (runGuardedPull)。 study_days (pullAllStudyDays) は
    //    意図的に含めない: 詳細画面は study_days を表示せず、詳細直ロード時に
    //    PullTrigger の mount kick が suppress で skip されても dashboard 鮮度は
    //    離脱後の次 ambient で回復するため (完全性目的で安易に足さないこと)。
    void runGuardedPull({ reason: 'exam-detail-mount' }).catch(() => {})

    // ② suppress on: 以降の ambient kick (mount/visibilitychange/online) を抑止。
    suppressAmbientPull()

    return () => {
      // cleanup: unmount / examId 変化で必ず suppress を解除する。
      // React lifecycle による確実な解除経路 (unmount / examId 変化で必ず走る)。
      // ※ crash / タブ閉鎖時は module-scope flag がプロセス死で自然に消えるため
      //   この経路が唯一の解除手段というわけではない。
      resumeAmbientPull()
    }
  }, [examId])

  return null
}
