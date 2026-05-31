// card-mutation-flush — card_mutations outbox flush の Web Locks 排他 orchestrator。
//
// 設計 (review-flush.ts を card 用にミラー):
// - flush の最外を Web Locks で囲む。 lock 名は card-mutation flush 用の単一固定キー。
//   入れ子順 = lock 取得 → (flushAllPendingCardMutations 内の) in-flight guard 追加 →
//   bulk POST → in-flight 解放 → lock 解放 (後入れ先出し)。
// - lock 取得失敗 (他タブ保持中) は flush せず即 return (queue で待たない)。
//   server 側 mutation_id UNIQUE + ON CONFLICT 冪等性により、待たず諦めても二重適用にならない。
// - 429 は即停止 (CLAUDE.md §AI ルール 5)。 classifyFlushResults が rate-limited を
//   返す経路は壊さない。
// - review-flush.ts には手を加えない (稼働中の演習 flush 経路を保全)。
//
// 多重送信防止: mutation_id UNIQUE (server) + in-flight set + Web Locks の 3 重 (plan 制約)。

import { flushAllPendingCardMutations } from './card-mutations'
import type { FlushResult } from './review-events'
import {
  classifyFlushResults,
  type FlushOutcome,
} from './review-flush'
import { logger } from '@/lib/logger'

// card-mutation flush 用の単一固定 lock 名 (origin 内全タブ共有)。
// review-flush の FLUSH_LOCK_NAME とは別名にし、 演習 flush との lock 競合を避ける。
export const CARD_MUTATION_FLUSH_LOCK_NAME = 'recallmint:card-mutations:flush'

// Web Locks の最小型 (lib.dom の LockManager から本 module が使う部分のみ)。
// review-flush.ts の MinimalLockManager は export されていないため、 同等の型を定義する。
// (review-flush.ts が internal 型として保持しているため複製不可避 — 理由をここに記録)。
type MinimalLockManager = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<FlushOutcome>,
  ) => Promise<FlushOutcome>
}

export type GuardedCardMutationFlushDeps = {
  flushAll?: () => Promise<FlushResult[]>
  // 'locks' を明示指定すると navigator を見ない (undefined 指定で非対応 path を test 可能)。
  locks?: MinimalLockManager | undefined
}

function resolveLocks(
  deps: GuardedCardMutationFlushDeps,
): MinimalLockManager | undefined {
  if ('locks' in deps) return deps.locks
  // defensive: navigator.locks の存在チェックのみ (対象環境 iOS 16.4+ は全対応)。
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks as unknown as MinimalLockManager
  }
  return undefined
}

// card-mutation flush の最外を Web Locks で囲んで実行する。
// lock 取得失敗時は flush せず lock-busy を返す (review-flush の runGuardedFlush を忠実にミラー)。
export async function runGuardedCardMutationFlush(
  deps: GuardedCardMutationFlushDeps = {},
): Promise<FlushOutcome> {
  const flushAll = deps.flushAll ?? (() => flushAllPendingCardMutations())
  const locks = resolveLocks(deps)

  if (!locks) {
    // Web Locks 非対応 (defensive): lock なしで直接 flush。 多重は server UNIQUE で吸収。
    const results = await flushAll()
    return classifyFlushResults(results)
  }

  return locks.request(
    CARD_MUTATION_FLUSH_LOCK_NAME,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        // 他タブが保持中 → flush せず即 return (queue で待たない)。
        logger.info({
          event: 'card_mutations.flush.lock_busy',
          lockName: CARD_MUTATION_FLUSH_LOCK_NAME,
        })
        return 'lock-busy'
      }
      const results = await flushAll()
      return classifyFlushResults(results)
    },
  )
}
