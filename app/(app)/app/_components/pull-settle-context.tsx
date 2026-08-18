'use client'

// PullSettleContext — 初回 pull(cards/exams の runGuardedPull mount kick)が settle
// (成功/失敗を問わない終了)したかを公開する軽量シグナル(Dash-1 Home v1 Task 5・spec §6)。
//
// なぜ要るか: `useLiveQuery() === undefined` は「Dexie query がまだ完了していない」
// ことしか意味せず、「server 同期がまだ行われていない」ことは示さない。 これが無いと
// Home は「この試験は 0 件」(sync 済 + 実際に 0 件)と「まだ sync していない」を
// 区別できない(spec §6 / §5 の前段制御状態)。
//
// なぜ context か: settle の発生源(PullTrigger — layout 直下の sibling)と消費先
// (Home 等の各 page — `{children}` 側)は親子関係ではなく、 prop では届かない。
// module-scope 変数(ambient-pull-suppress と同型)ではなく React Context を選んだ
// 理由: 値が変わった購読側だけを再描画させたい(module 変数は購読の仕組みを別途
// 要る)。 route を跨いだ真の必要が出るまではこれ以上複雑にしない(spec §6:
// 「実装形は最小 — 第一候補は React context」)。
//
// user 切替で前 user の settled を引き継がない(critical property・spec の明示要求):
// 呼出側(layout.tsx)が Provider を `key={userId}` 付きで mount する契約により、
// userId が変われば React が Provider を丸ごと remount し firstPullSettled が
// 構造的に false へ再初期化される(手動 reset ロジックより堅牢 — 「reset し忘れ」の
// 余地がない)。 sign-out purge / sign-in sweep はどちらも「次に layout が新しい
// user.id で render される」経路を通るため、 この key 契約だけで両方カバーされる。
//
// React Strict Mode の二重 effect 対策は本 module ではなく PullTrigger 側の責務
// (runGuardedPull の outcome が 'inflight-skip' のときは settle とみなさない —
// pull-trigger.tsx 参照)。 本 module は「一度 true になったら true のまま」の
// 冪等な latch を提供するだけで、 何が settle を意味するかの判断は持たない。

import { createContext, useContext, useMemo, useState, useCallback, type ReactNode } from 'react'

interface PullSettleContextValue {
  readonly firstPullSettled: boolean
  readonly markFirstPullSettled: () => void
}

// default(Provider 不在時)は「常に未 settle・書込は no-op」。 PullTrigger は既存
// test で Provider なし単体 render されるため、 default が no-op でないと crash する。
const PullSettleContext = createContext<PullSettleContextValue>({
  firstPullSettled: false,
  markFirstPullSettled: () => {},
})

export function PullSettleProvider({ children }: { children: ReactNode }) {
  const [firstPullSettled, setFirstPullSettled] = useState(false)
  // useCallback で参照を固定する: 固定しないと firstPullSettled が false→true に
  // 変わった瞬間に本 component が再 render され、 markFirstPullSettled の参照が
  // 変わり、 それを effect dep に含める消費側(PullTrigger)の effect が
  // 意図せず再実行されてしまう(settle 直後に mount kick が余分にもう 1 回走る)。
  const markFirstPullSettled = useCallback(() => setFirstPullSettled(true), [])
  const value = useMemo(
    () => ({ firstPullSettled, markFirstPullSettled }),
    [firstPullSettled, markFirstPullSettled],
  )

  return (
    <PullSettleContext.Provider value={value}>{children}</PullSettleContext.Provider>
  )
}

/** Home 等の消費側: 初回 pull が settle したか。 */
export function useFirstPullSettled(): boolean {
  return useContext(PullSettleContext).firstPullSettled
}

/** PullTrigger 専用: settle を通知する(何度呼んでも安全な冪等 latch)。 */
export function useMarkFirstPullSettled(): () => void {
  return useContext(PullSettleContext).markFirstPullSettled
}
