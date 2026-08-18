'use client'

// PullTrigger — `/app/*` 共通 layout で mount / visibilitychange / online の
// 各トリガーに Dexie pull を fire-and-forget で kick off する client component
// (S-local-2 Task 6 / Phase α、 cache-fix roadmap ④-1 で dashboard page → layout
// に移動。 増分 pull step4 で focus 復帰・再接続トリガー追加)。
//
// 役割境界:
// - UI は持たない (`return null`)。 server SSR / AppHeader / 各 page の表示と
//   独立に、 background で local mirror を整える。
// - 失敗は silent (UI 警告 / console 出力なし)。 guard (in-flight skip / lock-busy)
//   は正常系として扱い、 次トリガで自動リトライされる設計。
// - unmount 時は visibilitychange / online の listener を解除する。
//
// トリガー:
// - mount: 初回 pull。 React StrictMode dev 環境で 2 回 mount されても guard が
//   in-flight skip するため副作用なし。
// - visibilitychange (→ visible のみ): タブ復帰時に mirror を最新化。
// - online: ネットワーク復帰時に mirror を最新化。
//
// 経路:
// - cards/exams は runGuardedPull (in-flight + Web Locks guard 付き pullDelta)
// - study_days は旧 study-days/pull 経路で並走 (別 helper・別 tx、
//   unguarded / idempotent full-replace / cursor race なし)
//
// suppress フラグ:
// - isAmbientPullSuppressed() が true の間、 kick は何もせず return する。
// - suppress は ambient kick (mount/visibilitychange/online) のみを止める。
//   pullBack / 入口 kick が runGuardedPull を直接呼ぶ経路は flag を参照しないため
//   suppress の対象外 (bypass は構造的に自明: flag は PullTrigger の kick 内でのみ読む)。
// - suppress 中の ambient kick は queue しない。離脱後の次トリガで自然回復する。
// - skip outcome retry(下記)も同じ契約を守る: 各 retry 再突入のたびに suppress を
//   再確認する(fix round 2/5 M2 — 一度予約した retry が suppress 開始後も走り
//   続けないようにする)。
//
// settle シグナル (Dash-1 Home v1 Task 5・spec §6):
// - runGuardedPull(cards/exams pull)の outcome が確定するたびに markFirstPullSettled
//   を呼ぶ「一度 true になったら true のまま」の冪等 latch (PullSettleProvider 参照)。
//   study_days (pullAllStudyDays) は Home の「試験 0」判定に無関係なため対象外
//   (settle は cards/exams mirror の readiness のみを表す)。
// - 'inflight-skip' と 'lock-busy' は**同じ bound 付き retry**で扱う(fix round 3/5・
//   Codex Critical C1 残課題の是正)。 どちらも「今この呼出には結果が無い(誰か他が
//   持っている、または持つはずだった)」という点で同型の skip outcome であり、
//   これを別扱いにしていたこと自体が Critical の根因だった(下記)。
//   - 'lock-busy'(fix round 1/5 由来): **他タブ**が Web Lock を保持して pull 実行中
//     を意味し、その pull はまだ mirror に書き終えていない。
//   - 'inflight-skip': 「同一タブ内の別呼出が今まさに実行中」を意味する。 通常は
//     その sibling chain 自身が 'ran'/'lock-busy'/reject を得て settle するので
//     追加の作業は要らないが、 (a) user 切替(`key={user.id}` remount)で sibling
//     chain が torn-down な fiber に属していて settle が死んだ Provider に届く
//     (無害だが、 新 user 側の chain にとっては「誰も settle してくれない」)、
//     (b) `lib/sync/pull.ts` の fetch に AbortSignal/timeout が無く、 sibling の
//     呼出自体が永久に解決しない(`pullInFlight` が tab 全体で true に固定される)、
//     の 2 経路で sibling が実際には settle しないことがある(fix round 3/5・
//     controller 指摘)。
//   いずれの outcome も、 即 settle 扱いにすると実データがまだ mirror に届いて
//   いないのに Home が「試験 0」等を確定判定してしまう(critical property)ため
//   即settleはしないが、 **無期限に待つのも誤り**(上記 (a)(b) が示すとおり sibling
//   が永久に来ない経路がある)。 よって両 outcome とも短い delay を挟んで
//   同じ再試行 chain で再度試みる(outcome を信頼せず bound 付きで待つパターンは
//   reference_runguardedpull_skip_is_normal.md の教訓を踏襲するが、
//   `wait-for-exam-mirror.ts` とは判定対象が異なる別実装 — あちらは特定行の mirror
//   到達を直接ポーリングし、 本 module は outcome を再試行するだけで mirror を
//   直接見ない。 fix round 2/5 M6: 過去のコメントが両者を同型と書いていたのを訂正)。
//   ただし無限リトライはしない — 上限到達で fail-safe settle(多少古いままでも
//   mirror を表示する方が無限 skeleton より正しい)。'ran'(実行完了)と失敗(reject)は
//   即 settle(spec: 成功/失敗を問わない)。
//   fail-safe の自己修復性(fix round 2/5 M7): bound 到達直後は Home が「試験 0」等を
//   まだ届いていない mirror に対して確定判定しうる。 これが許容できるのは、 examIds
//   (Home 側)が Dexie の useLiveQuery から来るため — 他タブの pull が後から mirror
//   へ書き込めば、 その変化通知で Home は自動的に再 render され、 表示は追って
//   正しい状態に収束する(恒久的な誤表示ではなく一過性)。 settle 自体は再発火しない
//   (冪等 latch)が、 Home の再描画は settle と独立に mirror 変化で起きる。
// - **settle は effect instance の生死(cancelled)で gate しない**(fix round 2/5
//   Codex Critical C1 是正): StrictMode の dev 二重 effect(setup→cleanup→setup)や
//   user 切替の unmount+remount では、 「先に issue された呼出(chain #1)」が
//   teardown された**後**に本物の outcome を返し、 「後から mount された呼出
//   (chain #2)」は 'inflight-skip' を返す(pullInFlight は module-scope の同期
//   フラグなので chain #1 の呼出が終わるまで true のまま)。 chain #2 は
//   'inflight-skip' で何もしないため、 chain #1 の遅着 outcome を cancelled で
//   捨てると settle が孤児化し、 Home が恒久 skeleton になる(旧実装の bug —
//   本コメント冒頭の懸念そのものが別経路で再発していた)。 markFirstPullSettled は
//   Provider が useCallback で安定化しているため、 torn-down な chain から呼んでも
//   (Provider 自体が別 user 切替で unmount 済みなら) 無害な no-op になるだけで
//   安全 — settle を cancelled で止める理由が無い。
// - **teardown 後は stale owner(userId)での新規 pull を issue しない**(fix round
//   2/5 Important I1 是正): 上記と非対称に、 retry の**新規 issue**(runGuardedPull
//   の呼出そのもの)は cancelled を最優先でチェックしてから行う。 これは「今持って
//   いる outcome を捨てるかどうか」ではなく「これから新しい副作用(他 owner の
//   cursor namespace への書込を引き起こしうる pull)を起こすかどうか」の判断であり、
//   両者は別の質問(前者は on/off しても既に起きたことは変わらない、後者は防げる)。
//   予約済みの retry timer も teardown で clearTimeout する。 **correctness の担保は
//   上記の attemptPull 冒頭チェックだけで完結しており**(cancelled は cleanup で
//   同期的に立ち、setTimeout は常に macrotask なので、 clearTimeout し損ねた timer が
//   あってもそのコールバックは必ず attemptPull 冒頭チェックを経由してから
//   runGuardedPull に到達する経路しか無い — すり抜ける窓は無い)、 clearTimeout は
//   浮いた timer と 150ms 分の closure 保持を残さない tidiness(fix round 3/5・
//   controller 指摘で明確化。round 2/5 report は「2 機構が独立に必要」と誤って
//   記録していたため訂正)。

import { useEffect } from 'react'
import { runGuardedPull } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'
import { isAmbientPullSuppressed } from '@/lib/sync/ambient-pull-suppress'
import { useMarkFirstPullSettled } from './pull-settle-context'

// skip outcome('inflight-skip' / 'lock-busy')再試行の間隔と上限。 合計 bound ≈ 1.5s
// (outcome を信頼せず bound 付きで待つパターンは
// reference_runguardedpull_skip_is_normal.md の教訓を踏襲する — 判定対象自体は
// wait-for-exam-mirror.ts と異なる、上のコメント参照)。
const PULL_SKIP_RETRY_DELAY_MS = 150
const PULL_SKIP_MAX_RETRIES = 10

export function PullTrigger({ userId }: { userId: string }): null {
  const markFirstPullSettled = useMarkFirstPullSettled()

  useEffect(() => {
    let cancelled = false
    // 冗長な再試行 chain を防ぐ: 一度でも settle したら以後の skip outcome は
    // 追加リトライを組まない(settle は冪等 latch なので再 mark 自体は無害だが、
    // タイマーを積み続けるのは無駄)。
    let hasSettled = false
    // 予約済みの retry timer(fix round 2/5 I1): teardown で確実に clearTimeout する。
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

    const settleOnce = () => {
      if (hasSettled) return
      hasSettled = true
      markFirstPullSettled()
    }

    // cards/exams pull を試み、outcome に応じて settle を判定する。
    // 'inflight-skip' / 'lock-busy' は即 settle せず、bound 付きで delay 後に
    // 再試行する(retriesLeft を使い切ったら fail-safe で settle する — fix round
    // 3/5: 2 つの skip outcome を同じ retry chain に収斂させた。 これらを別扱い
    // にしていたこと自体が Codex Critical C1 の根因だったため、 収斂させること
    // 自体が是正)。
    // 注記(fix round 2/5 M1・対応不要と裁定): kick が短時間に複数回(例: mount 直後の
    // visibilitychange)発火すると、各々が独立した retry chain(独自の
    // PULL_SKIP_MAX_RETRIES 予算)を持つ。 収斂(1 本の chain へ merge)は簡単には
    // できない(「どの chain が生きているか」を跨いで判断する追加状態が要る)ため
    // 見送る — 実害は無い(hasSettled で二重 settle は防止済み、各 chain は最大
    // 1.5s で終わる、pullInFlight の in-process guard が実際の重複 network 呼出を
    // 防ぐ)ため、この程度の churn は許容する。
    const attemptPull = (reason: string, retriesLeft: number) => {
      // fix round 2/5 I1/M2: 新規 pull を issue する前に teardown / suppress を
      // 再確認する(予約時点でなく、実際に実行しようとする瞬間の状態を見る)。
      // teardown 済みなら stale owner(userId)での pull を絶対に issue しない。
      // suppress 中の再突入も同じ契約(ambient kick は suppress を尊重する)。
      // どちらも無期限に待たせず fail-safe で settle する(chain #1 の本呼出の
      // 結果を待つ経路は下の .then() 側にあるため、ここで settle しても孤児化しない)。
      // fix round 3/5(新規リグレッションではないと確認済 — round 2 で検出された
      // 「cancelled 時は bound を待たず ~150ms で settle する」経路はここ: lock-busy を
      // 受けた torn-down な chain がこの分岐で即 settle する。 現行の layout.tsx 配線
      // (PullSettleProvider が PullTrigger と同じ key={user.id} で remount される)では
      // 到達しない — teardown される chain の Provider は同時に死んでいるため、
      // 早い settle は死んだ fiber に届くだけで新 user 側には影響しない。
      if (cancelled || isAmbientPullSuppressed()) {
        settleOnce()
        return
      }
      void runGuardedPull({ userId, reason })
        .then((outcome) => {
          if (hasSettled) return
          if (outcome === 'inflight-skip' || outcome === 'lock-busy') {
            // bound 到達のみここで判定する。 teardown / suppress は上の
            // attemptPull 冒頭のチェックが retry 再突入のたびに再評価するため、
            // ここで cancelled を重ねて見る必要はない(重ねても害はないが、
            // 「どちらの check が効いているか」が曖昧になるので 1 箇所に寄せる —
            // fix round 2/5: C1 で「settle は cancelled で gate しない」と
            // 「retry の新規 issue は cancelled で止める」を分離した際に判明)。
            if (retriesLeft <= 0) {
              settleOnce() // fail-safe: bound 到達、現状 mirror で settle する
              return
            }
            const timer = setTimeout(() => {
              pendingTimers.delete(timer)
              attemptPull(reason, retriesLeft - 1)
            }, PULL_SKIP_RETRY_DELAY_MS)
            pendingTimers.add(timer)
            return
          }
          settleOnce() // 'ran'(cancelled でも settle する — C1)
        })
        .catch(() => {
          // silent: network error は次トリガで再試行。失敗も settle 扱い(cancelled でも)。
          settleOnce()
        })
    }

    const kick = (reason: string) => {
      // ambient kick を suppress フラグで抑止。
      // suppress 中は queue せず silent に skip する (離脱後の次トリガで自然回復)。
      // 詳細滞在中は毎 visibilitychange/online でここを通るため、ログは出さない
      // (本 component の silent 契約 + ログ spam 回避)。
      if (isAmbientPullSuppressed()) return

      attemptPull(reason, PULL_SKIP_MAX_RETRIES)
      // study_days は増分化せず旧 endpoint で並走 (別 helper・別 tx)
      void pullAllStudyDays(userId).catch(() => {
        // silent: 次トリガで再試行
      })
    }

    kick('mount')

    const onVis = () => {
      // hidden → visible の遷移のみ pull を kick (hidden では不要)
      if (document.visibilityState === 'visible') kick('visibilitychange')
    }
    const onOnline = () => kick('online')

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
    // userId 依存: layout が remount しない内部 navigation でも userId が変われば
    // effect を張り直し、新 owner で再 kick する。 deps [] のままだと listener が
    // 旧 userId を closure に抱えたまま残り、次 user の pull を前 user の cursor
    // namespace に書いてしまう (spec §5.1 capture 原則の入口側)。 skip outcome retry も
    // 同じ懸念を持つため teardown で timer を clear する(上記コメント参照)。
    // markFirstPullSettled 依存: PullSettleProvider が useCallback で参照を固定して
    // いるため (pull-settle-context.tsx 参照)、通常時はこの dep で余分な再実行は
    // 起きない。 Provider 不在 (単体 test) では default no-op が渡るだけで同様に安定。
  }, [userId, markFirstPullSettled])
  return null
}
