// with-web-lock — entity-mutation-flush / review-flush / pull が共有する Web Locks
// 排他 wrap を 1 経路に集約。
//
// 共通 pattern:
//   1. 'locks' key が deps に明示指定されていれば使う (undefined 指定で非対応 path を test 可能)。
//   2. それ以外は navigator.locks があれば使う。
//   3. いずれも無ければ defensive に run() を直接実行 (非対応環境でも処理を止めない、
//      多重は server 側 UNIQUE / 冪等性で吸収)。
// 4. lock 取得成功 → run() / 他タブ保持中 → onLockBusy()。
//
// log は各 caller の event 名 / 追加 field (reason / lockName) が異なるため helper では
// 行わず onLockBusy() の中で行う (pull は 'pull.lock_busy' + reason、review-flush は
// 'review_events.flush.lock_busy'、 entity-mutation-flush は 'entity_mutations.flush.lock_busy')。

// Web Locks の最小型 (lib.dom の LockManager から本 module が使う部分のみ)。
// callback 戻り値型を T で parameterize。 caller (entity-mutation-flush /
// review-flush / pull) はそれぞれ FlushOutcome / PullGuardOutcome に specialize する。
export type MinimalLockManager<T = unknown> = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ) => Promise<T>
}

export type WithWebLockOptions<T> = {
  lockName: string
  // lock 取得成功 (もしくは Web Locks 非対応 fallback) 時に実行する body。
  run: () => Promise<T>
  // 他タブが lock を保持中 (ifAvailable=true で null lock) の時に呼ぶ。 caller は
  // ここで logger.info(...) と return value 用意を一括で行う (event 名 / 付随 field は
  // caller ごとに違うため helper では log しない)。
  onLockBusy: () => T
  // 明示 undefined を渡すと "非対応環境" を test できる ('locks' in options で discriminator)。
  // omit 時は navigator.locks にフォールバック。
  locks?: MinimalLockManager<T> | undefined
}

function resolveLocks<T>(
  options: WithWebLockOptions<T>,
): MinimalLockManager<T> | undefined {
  // 'locks' key 明示 (undefined 含む) → そのまま使う (非対応 path の test 用 hook)。
  if ('locks' in options) return options.locks
  // defensive: navigator.locks の存在チェックのみ (対象環境 iOS 16.4+ は全対応)。
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks as unknown as MinimalLockManager<T>
  }
  return undefined
}

export async function withWebLock<T>(options: WithWebLockOptions<T>): Promise<T> {
  const locks = resolveLocks(options)

  if (!locks) {
    // Web Locks 非対応 (defensive): lock なしで直接実行。
    return options.run()
  }

  return locks.request(
    options.lockName,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return options.onLockBusy()
      return options.run()
    },
  )
}
