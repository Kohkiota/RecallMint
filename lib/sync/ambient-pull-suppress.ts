// ambient-pull-suppress — PullTrigger が layout 常駐のため、詳細 component と
// React ツリーが離れており context/prop では suppress フラグを受け渡せない。
// module-scope フラグを使う理由: cleanup (unmount) で確実に reset できる紐付けが最も
// 安全であり、Dexie/DOM 依存がなく client/server/test どこからも import できる。
//
// フラグを参照するのは PullTrigger の ambient kick のみ。
// runGuardedPull 本体 (pull.ts) は無変更 — 直呼び経路 (pullBack / 入口 kick) は
// このフラグに影響されない (suppress の対象外)。
// → 構造的担保: flag は PullTrigger 内でのみ読む。
//   pullBack や入口 kick が runGuardedPull を直接呼ぶ経路は flag bypass が自明。
//
// 注意: module-scope mutable state のため、 driver ('use client' な PullTrigger /
// 詳細 gate) は必ず client 側で動かす。 server component から import して set/reset
// すると per-process 共有状態になり request 間で漏れる (本 module の現利用者は
// すべて 'use client' なので問題なし)。

let _suppressed = false

/** ambient pull を抑止する (PullTrigger の mount/visibilitychange/online kick が no-op になる)。*/
export function suppressAmbientPull(): void {
  _suppressed = true
}

/** ambient pull 抑止を解除する。 */
export function resumeAmbientPull(): void {
  _suppressed = false
}

/** 現在 ambient pull が抑止されているか。 */
export function isAmbientPullSuppressed(): boolean {
  return _suppressed
}
