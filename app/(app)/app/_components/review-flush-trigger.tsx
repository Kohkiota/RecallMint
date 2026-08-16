'use client'

// 演習 push (review-events) の保全 trigger。 (app) layout に mount され、 演習画面を
// 離れた後の未送信 pending を回復するために flush を kick する。 実際の Web Locks 排他 /
// backoff retry は createReviewFlushController が担う (本 component は trigger 配線のみ)。
//
// trigger (事前調査 docs/superpowers/sessions/2026-05-29-review-events-retry-weblocks-inventory.md):
// - mount: flush kick。
// - visibilitychange(visible): フォーカス復帰時に kick。
// - online: 再接続時に kick。
// - flush 成功時に pull-back を相乗り (FSRS 後の値を mirror へ戻す)。
//
// userId は (app) layout の認証済み値を props で受ける (flush の owner-scope・spec §4.6)。
//
// controller の retry timer は closure scope (タブが開いている間のみ生存)。 unmount 時は
// stop() で予約 timer を解除し、 listener も外す。 pending は Dexie に残置されたままでよい。

import { useEffect } from 'react'
import {
  createReviewFlushController,
  runGuardedAnswerEventFlush,
} from '@/lib/sync/review-flush'
import { pullBack } from '@/lib/sync/pull-back'

export function ReviewFlushTrigger({ userId }: { userId: string }) {
  useEffect(() => {
    const controller = createReviewFlushController({
      runGuarded: () => runGuardedAnswerEventFlush(userId),
      onFlushed: () => pullBack(userId, 'flush'),
    })

    void controller.kick('mount')

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void controller.kick('visibilitychange')
      }
    }
    const onOnline = () => {
      void controller.kick('online')
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
      controller.stop()
    }
  }, [userId])

  return null
}
