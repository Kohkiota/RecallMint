// entity-mutation-flush — entity_mutations outbox flush の Web Locks 排他 orchestrator
// (S-sync-1 で旧 card-mutation-flush から汎用化、 全 entity_type 共有 1 lock)。
//
// 設計 (review-flush.ts を mutation-driven 経路用にミラー):
// - flush の最外を Web Locks で囲む (lib/sync/with-web-lock の共有 helper 経由)。
//   lock 名は mutation-driven push 全 entity 共有の単一固定キー。 入れ子順 = lock 取得
//   → (flushAllPendingEntityMutations 内の) in-flight guard 追加 → bulk POST →
//   in-flight 解放 → lock 解放 (後入れ先出し)。
// - lock 取得失敗 (他タブ保持中) は flush せず即 return (queue で待たない)。
//   server 側 mutation_id UNIQUE + ON CONFLICT 冪等性により、待たず諦めても二重適用に
//   ならない。
// - 429 は即停止 (CLAUDE.md §AI ルール 5)。 classifyFlushResults が rate-limited を
//   返す経路は壊さない。
// - review-flush.ts には手を加えない (稼働中の演習 flush 経路を保全)。
//
// 多重送信防止: mutation_id UNIQUE (server) + in-flight set + Web Locks の 3 重。

import { flushAllPendingEntityMutations } from './entity-mutations'
import type { FlushResult } from './review-events'
import {
  classifyFlushResults,
  type FlushOutcome,
} from './review-flush'
import { withWebLock, type MinimalLockManager } from './with-web-lock'
import { logger } from '@/lib/logger'

// entity-mutation flush 用の単一固定 lock 名 (origin 内全タブ共有)。
// review-flush の FLUSH_LOCK_NAME とは別名にし、 演習 flush との lock 競合を避ける。
// mutation-driven 経路は全 entity_type (card / 将来 tag_category 等) でこの 1 lock を
// 共有する (entity 別 lock は不要、 server tx が per-mutation 独立)。
export const ENTITY_MUTATION_FLUSH_LOCK_NAME = 'recallmint:entity-mutations:flush'

export type GuardedEntityMutationFlushDeps = {
  flushAll?: () => Promise<FlushResult[]>
  // 'locks' を明示指定すると navigator を見ない (undefined 指定で非対応 path を test 可能)。
  locks?: MinimalLockManager<FlushOutcome> | undefined
}

// entity-mutation flush の最外を Web Locks で囲んで実行する。
// lock 取得失敗時は flush せず lock-busy を返す (review-flush の runGuardedFlush を忠実にミラー)。
// userId は flush の owner-scope 選別に使う ((app) layout の認証済み値が起点)。
export async function runGuardedEntityMutationFlush(
  userId: string,
  deps: GuardedEntityMutationFlushDeps = {},
): Promise<FlushOutcome> {
  const flushAll = deps.flushAll ?? (() => flushAllPendingEntityMutations(userId))

  return withWebLock<FlushOutcome>({
    lockName: ENTITY_MUTATION_FLUSH_LOCK_NAME,
    run: async () => classifyFlushResults(await flushAll()),
    onLockBusy: () => {
      // 他タブが保持中 → flush せず即 return (queue で待たない)。
      logger.info({
        event: 'entity_mutations.flush.lock_busy',
        lockName: ENTITY_MUTATION_FLUSH_LOCK_NAME,
      })
      return 'lock-busy'
    },
    // 'locks' key 明示時のみ helper に転送 (undefined で非対応 path test)。
    ...('locks' in deps ? { locks: deps.locks } : {}),
  })
}
