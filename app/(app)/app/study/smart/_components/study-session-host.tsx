'use client'

// StudySessionHost — server `page.tsx` と client `SessionLauncher` の中間に立ち、
// 演習開始時の cards 決定 (Dexie mirror 優先 + server fallback、 S-local-3) を担う。
//
// S-local-3 hybrid 戦略:
// - 選択試験が決まった時点で `getDueCardsFromDexie(userId, examId, sessionLimit)` を試行
// - 戻り値 >= 1 件: Dexie 由来 cards を使う (= mirror 経由の local read 経路)
// - 戻り値 0 件 / throw: props.cards (server fetch fallback) を使う
// - cards 確定後は SessionLauncher に委譲 (sessionId 採番は launcher 側)
//
// S-local-4 (Phase γ) 拡張: Dexie 0 件 + props.cards (server) 0 件のとき empty UI
// を render する。 旧 page.tsx の「ありません」 page を host 内に集約し、 offline
// (server fetch fail で cards=[] が来る) と「全件解いた」 (server cards=[]) を
// 一元判断する。 これにより server fetch fail でも page render 失敗せず、 user は
// 「ありません」 + ダッシュボード戻り CTA を見られる。
//
// Dash-1 Home v1 §8.5 / §6 拡張:
// - 出題は**選択試験スコープ**になったため、cards を引く前に試験を解決する。解決は
//   home / quick と共通の `useSelectedExam`(URL → 保存値 → 1 件自動)であって、
//   ここに独自の解決経路は作らない。
// - origin は page.tsx が正規化済みの値を prop で受け取り、そのまま launcher へ渡す
//   (query 値をここで再解釈しない)。
//
// 設計上の注意:
// - server SSR は維持 (page.tsx は cards=[] 渡しで動作、 host が empty UI を出す)
// - silent fallback: Dexie 失敗時の console / UI 出力なし

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Card } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import { getDueCardsFromDexie } from '@/lib/cards/get-dexie-session-cards'
import { useSelectedExam } from '@/lib/dashboard/use-selected-exam'
import { useOwnerExams } from '@/app/(app)/app/_components/use-owner-exams'
import { SessionLauncher } from '../../_components/session-launcher'

type StudySessionHostProps = {
  cards: Card[]
  fsrsMode: boolean
  // S-local-3: Dexie cards mirror から出題プールを引き直すために必要。
  userId: string
  sessionLimit: number | null
  // URL の `exam` param (不在は undefined)。 server props.cards もこの試験のもの。
  examId: string | undefined
  // page.tsx で正規化済みの origin (§11.1 の既知値のみ)。
  origin: 'home_today' | 'smart'
}

function LoadingView() {
  return (
    <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
      Loading…
    </div>
  )
}

export function StudySessionHost(props: StudySessionHostProps) {
  // spec §5 の前段制御状態「初回 pull 未 settle」をこの入口にも適用する
  // (Home 専用ではない — 試験解決は home / smart / quick で同じ前提に立つ)。
  // gate の中身(空 mirror を「試験 0 件」と確定しない理由・読み直し失敗時の扱い)は
  // `use-owner-exams.ts` に 1 定義。home / smart / quick の 3 入口が共有する。
  const { examIds } = useOwnerExams(props.userId)

  // 下位(= resolver)を mount してよいのは「判定材料が揃った」ときだけ。空の
  // examIds を渡すと resolver は URL の `?exam=X` を「実在しない試験」として捨て、
  // さらに URL から `exam` を剥がす(共有された deep link が初回訪問で自壊する)。
  if (examIds === undefined) {
    return <LoadingView />
  }
  return <ResolvedStudySessionHost {...props} examIds={examIds} />
}

function ResolvedStudySessionHost({
  cards: serverCards,
  fsrsMode,
  userId,
  sessionLimit,
  examId,
  origin,
  examIds,
}: StudySessionHostProps & { examIds: string[] }) {
  const resolution = useSelectedExam({ userId, urlExamId: examId, examIds })
  // 選定結果は「どの試験のものか」と対にして持つ。試験が変わった瞬間に前の試験の
  // カードを出さないための必須要件 (id だけ見て cards を出すと 1 render ぶん
  // 旧試験のプールが表示される)。
  const [selection, setSelection] = useState<{
    examId: string
    cards: Card[]
  } | null>(null)
  const appliedKeyRef = useRef<string | null>(null)
  const selectionEpochRef = useRef(0)
  // unmount 判定専用 (fix round 4/5 N-3)。StrictMode の疑似 unmount → remount でも
  // setup が再び true に戻すので、選定結果が取りこぼされない。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const resolvedExamId =
    resolution?.outcome === 'resolved' ? resolution.examId : undefined

  // server cards は page が URL の `exam` で取ったもの。解決結果が別試験なら使わない
  // (他試験のカードを出さない)。
  const serverCardsForResolvedExam =
    resolvedExamId !== undefined && examId === resolvedExamId ? serverCards : null

  // 選定をやり直す**候補**になる条件 = 「解決した試験が変わった」か「その試験の
  // server cards が届いた」。後者が要るのは exam 無しの入口 (bookmark / nav の
  // 固定 link): 初回は server が試験を絞れず cards=[]、resolver が URL を `?exam=X` に
  // 正規化して RSC が取り直した cards が**後から**届く。「一度でも走ったか」で止めると
  // その到着を永久に無視して空セッションになる。
  // 配列の同一性ではなく到着有無 (boolean) を鍵にするのは、内容が同じ再 render で
  // 選定が走り直さないようにするため。
  // ここは**候補**であって確定条件ではない: 同一試験での 2 回目を実際に走らせてよいかは
  // effect 側の「今の選定がまだ空か」判定で決める (下記 — 非空プールの差し替え禁止)。
  const selectionKey =
    resolvedExamId === undefined
      ? null
      : `${resolvedExamId}|${(serverCardsForResolvedExam?.length ?? 0) > 0 ? 'server' : 'none'}`

  useEffect(() => {
    // 未解決 (保存値の読込待ち / 選択要求) の間は選定しない。表示側の分岐は
    // render 時に導出する (effect 内の同期 setState を作らない)。
    if (selectionKey === null || resolvedExamId === undefined) return
    if (appliedKeyRef.current === selectionKey) return
    // 「1 session = 1 選定」の実体はここ (fix round 2/5 I-1): **同一試験で既に非空の
    // プールを出している間は、server cards が後から届いても選定し直さない**。
    // SessionRunner は cards prop を snapshot せず `cards[idx]` を live に読み、
    // SessionLauncher の sessionId は lazy useState で remount しないため、配列を
    // 差し替えると idx はそのままで中身だけずれる = 回答済みの次の 1 問が無言で
    // 飛ぶ (並びが変われば表示カウンタも飛ぶ)。差し替えが正当なのは「まだ空の
    // 選定を埋め直す」場合だけ。鍵は消費して再入もさせない。
    const standingSelection =
      selection !== null && selection.examId === resolvedExamId ? selection : null
    if (standingSelection !== null && standingSelection.cards.length > 0) {
      appliedKeyRef.current = selectionKey
      return
    }
    appliedKeyRef.current = selectionKey
    selectionEpochRef.current += 1
    const myEpoch = selectionEpochRef.current
    void (async () => {
      let chosen: Card[] = serverCardsForResolvedExam ?? []
      try {
        const dexieCards = await getDueCardsFromDexie(
          userId,
          resolvedExamId,
          sessionLimit,
        )
        if (dexieCards.length > 0) chosen = dexieCards
      } catch {
        // silent fallback
      }
      // 遅着 guard: 試験切替中に古い選定が後から着地して新しい結果を潰さない
      // (resolver 側と同じ epoch 方式。await を挟む以上、cleanup では止められない)。
      if (selectionEpochRef.current !== myEpoch) return
      // unmount 後は書かない (fix round 4/5 N-3)。ここが per-effect の `cancelled`
      // ではなく **unmount 限定**なのは意図的: 選定は鍵ごとに 1 回しか走らないため、
      // effect の再実行 (StrictMode の mount → cleanup → mount 含む) で結果を捨てると
      // 2 回目は appliedKeyRef で skip され、Loading から永久に進まなくなる。
      // 「古い結果を適用しない」は epoch guard が、「消えた instance に書かない」は
      // この mounted guard が担当する (上の count 読み直しは effect ごとに再実行される
      // 冪等な読みなので per-run cancelled で正しい — 粒度の違いは責務の違い)。
      if (!mountedRef.current) return
      setSelection({ examId: resolvedExamId, cards: chosen })
    })()
    // cleanup で結果を捨てない: StrictMode の mount → cleanup → mount では
    // appliedKeyRef により 2 回目が skip されるため、捨てると Loading から進まない。
    // 上書き事故は epoch guard が止める。
    //
    // 追随の限界 (意図的・fix round 2/5 M-3): 追随するのは上記 2 つの入力だけで、
    // 「server が 0 件を返し、選定後に mirror が満ちた」場合は鍵が動かないため
    // 空 UI のまま残る (再訪 / reload で解消)。これは本変更前の mount 限定 effect と
    // 同じ挙動であり退行ではない — 回答中のプール固定を優先した結果として受容する。
  }, [
    selectionKey,
    resolvedExamId,
    serverCardsForResolvedExam,
    userId,
    sessionLimit,
    selection,
  ])

  // 試験を決められない (複数試験・未選択) ときは空セッションを開始せず empty UI に
  // 落とす (試験選択は home 側の責務 — spec §6)。 後から mirror が届いて解決できた
  // ときのために選定 guard は立てない = 導出値で表す。
  // 解決済みの試験と選定結果の試験が食い違う間 (切替直後) は Loading。
  const displayCards: Card[] | null =
    resolution === undefined
      ? null
      : resolvedExamId === undefined
        ? []
        : selection?.examId === resolvedExamId
          ? selection.cards
          : null

  if (displayCards === null) return <LoadingView />

  // S-local-4: Dexie + server 両方 0 件のとき empty UI。 旧 page.tsx の文言を維持。
  // empty UI は SessionLauncher に emptyState prop として渡す。
  const emptyUI = (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-12 text-center">
      <h1 className="text-2xl font-bold">スマート復習</h1>
      <p className="text-slate-600">
        現在復習する card はありません。
        <br />
        すべての card を学習済みです。お疲れ様でした！
      </p>
      <Button asChild variant="outline">
        <Link href="/app" prefetch={false}>ダッシュボードへ</Link>
      </Button>
    </div>
  )

  return (
    <SessionLauncher
      cards={displayCards}
      fsrsMode={fsrsMode}
      userId={userId}
      origin={origin}
      heading="スマート復習"
      emptyState={emptyUI}
    />
  )
}
