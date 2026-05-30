'use client'

// 演習 push (review-events) の保全 trigger。 (app) layout に mount され、 演習画面を
// 離れた後の未送信 pending を回復するために flush を kick する。 実際の Web Locks 排他 /
// backoff retry は createReviewFlushController が担う (本 component は trigger 配線のみ)。
//
// trigger (事前調査 docs/superpowers/sessions/2026-05-29-review-events-retry-weblocks-inventory.md):
// - mount: 24h 超 pending を silent drop してから flush kick。
// - visibilitychange(visible): フォーカス復帰時に kick。
// - online: 再接続時に kick。
// - flush 成功時に pull-back を相乗り (FSRS 後の値を mirror へ戻す)。
//
// controller の retry timer は module-scope (タブが開いている間のみ生存)。 unmount 時は
// stop() で予約 timer を解除し、 listener も外す。 pending は Dexie に残置されたままでよい。

import { useEffect } from 'react'
import { createReviewFlushController } from '@/lib/sync/review-flush'
import { dropStalePendingAnswerEvents } from '@/lib/sync/review-events'
import { pullBack } from '@/lib/sync/pull-back'
import { logger } from '@/lib/logger'

// 24h 超の pending は mount 時の古さ判定で silent drop する (常駐監視はしない)。
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function ReviewFlushTrigger() {
  useEffect(() => {
    const controller = createReviewFlushController({ onFlushed: () => pullBack('flush') })

    // mount: 24h 超 pending を drop → flush kick。 失敗は UI に出さず silent。
    void (async () => {
      try {
        const dropped = await dropStalePendingAnswerEvents(
          Date.now(),
          PENDING_MAX_AGE_MS,
        )
        if (dropped.length > 0) {
          logger.info({
            event: 'review_events.flush.stale_dropped',
            count: dropped.length,
          })
        }
      } catch {
        // drop 失敗は flush 自体を止めない
      }
      void controller.kick('mount')
    })()

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
  }, [])

  return null
}
