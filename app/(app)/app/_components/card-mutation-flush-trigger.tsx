'use client'

// card-mutation push の保全 trigger。 (app) layout に mount され、 編集画面を
// 離れた後の未送信 pending を回復するために flush を kick する。 実際の Web Locks 排他 /
// backoff retry は createReviewFlushController が担う (本 component は trigger 配線のみ)。
//
// controller を review-flush-trigger の ReviewFlushTrigger と同様に
// createReviewFlushController で生成し、 runGuarded / onFlushed / log を
// card-mutation 用に差し替えることで依存注入のみで再利用する
// (createReviewFlushController / review-flush.ts には手を加えない)。
//
// trigger:
// - mount: 24h 超 pending を silent drop してから flush kick。
// - visibilitychange(visible): フォーカス復帰時に kick。
// - online: 再接続時に kick。
// - pagehide: best-effort の最後の flush 試行 (fire-and-forget、await しない)。
//   ページ破棄前に pending を送り切ろうとする。失敗/中断は pending が Dexie に残り
//   次回 mount で回復するため await は不要 (await するとブラウザがページ破棄を妨げる恐れもある)。
// - flush 成功時に pull-back を相乗り (card server → Dexie mirror 同期)。
//
// controller の retry timer は closure scope (タブが開いている間のみ生存)。
// unmount 時は stop() で予約 timer を解除し、 listener も外す。

import { useEffect } from 'react'
import { createReviewFlushController } from '@/lib/sync/review-flush'
import { dropStalePendingCardMutations } from '@/lib/sync/card-mutations'
import { runGuardedCardMutationFlush } from '@/lib/sync/card-mutation-flush'
import { pullBack } from '@/lib/sync/pull-back'
import { logger } from '@/lib/logger'

// 24h 超の pending は mount 時の古さ判定で silent drop する (常駐監視はしない)。
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function CardMutationFlushTrigger() {
  useEffect(() => {
    // review-flush-trigger と同じ controller を deps 注入で card-mutation 用に再利用する。
    // - runGuarded を差し替えることで card_mutations outbox を flush する。
    // - onFlushed を差し替えることで pull-back の reason を card-mutation 系に揃える。
    // - log を差し替えることで controller 内の hardcoded event 文字列
    //   ('review_events.flush.*') を 'card_mutations.flush.*' に振り替え、
    //   ログ観測時に review flush と card-mutation flush を区別できるようにする。
    const controller = createReviewFlushController({
      runGuarded: runGuardedCardMutationFlush,
      onFlushed: () => pullBack('card-mutation-flush'),
      log: (event, extra) =>
        logger.info({
          ...extra,
          // controller 内の hardcoded prefix 'review_events' を 'card_mutations' に振替。
          // event.replace で表層書き換えのみ行い、 controller の内部ロジックには一切手を加えない。
          event: event.replace('review_events', 'card_mutations'),
        }),
    })

    // mount: 24h 超 pending を drop → flush kick。 失敗は UI に出さず silent。
    void (async () => {
      try {
        const dropped = await dropStalePendingCardMutations(
          Date.now(),
          PENDING_MAX_AGE_MS,
        )
        if (dropped.length > 0) {
          logger.info({
            event: 'card_mutations.flush.stale_dropped',
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
    // pagehide: ページ破棄前の best-effort flush (fire-and-forget)。
    // await しないことで、ブラウザによるページ破棄を妨げない。
    // 未送信 pending は Dexie に残り次回 mount の kick で回復される。
    // .catch(() => {}): ページ破棄前の best-effort なので失敗は silent でよい。
    const onPagehide = () => {
      void runGuardedCardMutationFlush().catch(() => {})
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', onPagehide)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPagehide)
      controller.stop()
    }
  }, [])

  return null
}
