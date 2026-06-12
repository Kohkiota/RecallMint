'use client'

// entity-mutation push の保全 trigger (S-sync-1 で旧 card-mutation-flush-trigger を
// 汎用化、 配線は不変)。 (app) layout に mount され、 編集画面を離れた後の未送信
// pending を回復するために flush を kick する。 実際の Web Locks 排他 / backoff retry は
// createReviewFlushController が担う (本 component は trigger 配線のみ)。
//
// 全 entity_type (現状 'card'、 将来 'tag_category' 等) を 1 つの汎用 flush で
// 送信する (entity 別 trigger は持たない)。 タグ用 trigger は後続 sprint で本体
// 配線を変えず entity_mutations の pending として一緒に流れる前提。
//
// controller を review-flush-trigger の ReviewFlushTrigger と同様に
// createReviewFlushController で生成し、 runGuarded / onFlushed / log を
// entity-mutation 用に差し替えることで依存注入のみで再利用する
// (createReviewFlushController / review-flush.ts には手を加えない)。
//
// trigger (配線は旧 card-mutation-flush-trigger からそのまま据え置き):
// - mount: 30d 超 pending を silent drop してから flush kick。
// - visibilitychange(visible): フォーカス復帰時に kick。
// - online: 再接続時に kick。
// - pagehide: best-effort の最後の flush 試行 (fire-and-forget、await しない)。
//   ページ破棄前に pending を送り切ろうとする。 失敗/中断は pending が Dexie に残り
//   次回 mount で回復するため await は不要 (await するとブラウザがページ破棄を妨げる恐れもある)。
// - flush 成功時に pull-back を相乗り (server → Dexie mirror 同期)。
//
// controller の retry timer は closure scope (タブが開いている間のみ生存)。
// unmount 時は stop() で予約 timer を解除し、 listener も外す。

import { useEffect } from 'react'
import { createReviewFlushController } from '@/lib/sync/review-flush'
import { dropStalePendingEntityMutations } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { pullBack } from '@/lib/sync/pull-back'
import { logger } from '@/lib/logger'

// 30d 超の pending は mount 時の古さ判定で silent drop する (常駐監視はしない)。
// spec OT 修正 3 / audit §10.3 (b) #4 反映 = 24h → 30d 延長 (隔離機構維持、
// 30d 超は将来 ops 通知の打鍵点として温存)。
const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function EntityMutationFlushTrigger() {
  useEffect(() => {
    // review-flush-trigger と同じ controller を deps 注入で entity-mutation 用に再利用する。
    // - runGuarded を差し替えることで entity_mutations outbox を flush する。
    // - onFlushed を差し替えることで pull-back の reason を entity-mutation 系に揃える。
    // - log を差し替えることで controller 内の hardcoded event 文字列
    //   ('review_events.flush.*') を 'entity_mutations.flush.*' に振り替え、
    //   ログ観測時に review flush と entity-mutation flush を区別できるようにする。
    const controller = createReviewFlushController({
      runGuarded: runGuardedEntityMutationFlush,
      onFlushed: () => pullBack('entity-mutation-flush'),
      log: (event, extra) =>
        logger.info({
          ...extra,
          // controller 内の hardcoded prefix 'review_events' を 'entity_mutations' に振替。
          // event.replace で表層書き換えのみ行い、 controller の内部ロジックには一切手を加えない。
          event: event.replace('review_events', 'entity_mutations'),
        }),
    })

    // mount: 30d 超 pending を drop → flush kick。 失敗は UI に出さず silent。
    void (async () => {
      try {
        const dropped = await dropStalePendingEntityMutations(
          Date.now(),
          PENDING_MAX_AGE_MS,
        )
        if (dropped.length > 0) {
          logger.info({
            event: 'entity_mutations.flush.stale_dropped',
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
      void runGuardedEntityMutationFlush().catch(() => {})
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
