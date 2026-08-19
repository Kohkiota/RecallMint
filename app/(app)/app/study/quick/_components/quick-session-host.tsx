'use client'

// QuickSessionHost — server `page.tsx` と client `SessionLauncher` の中間に立ち、
// クイック演習(design doc §7)の preset/tag 母集合選定 + 不正入力の home 送還を
// 担う。study-session-host.tsx(smart route)と同じ形に倣うが、quick は server
// fallback を持たない(データ源が Dexie mirror のみ・定義 doc W5)ため、hybrid
// 切替の分岐が無いぶん単純になる。
//
// 責務:
// - preset の enum 検証(tag 不在時のみ)。不正なら Dexie を待たず即 home 送還。
// - 試験解決は home/smart と共通の `useSelectedExam`(URL → 保存値 → 1 件自動)。
// - cold-mirror gate(Task 6 の教訓): `useLiveQuery() === undefined` は「query
//   未完了」しか意味せず「まだ同期していない」ことは示さない。判定は home / smart と
//   共有する `use-owner-exams.ts` に 1 定義してあり、確定するまで resolver を
//   mount しない(でないと有効な `?exam=` を「試験 0」と誤判定して剥がす)。
// - 試験解決後に 1 回だけ `getQuickPresetCardsFromDexie` を呼び、選定結果を
//   固定する(appliedKeyRef — 同一 exam/preset/tag では再選定しない。SessionRunner
//   が `cards[idx]` を live に読むため、回答中に母集合が変わる述語〈間違い/苦手は
//   回答で状態が変わりうる〉の影響で配列が入れ替わることを防ぐ)。
// - tag entry(母集合 0)は home 送還。4 preset の母集合 0 は SessionLauncher の
//   emptyState に委ねる(既存 empty UI・セッションは開始しない)。
// - home 送還(`RedirectHome`)は 1 回で終わらせず、`useSelectedExam` の URL 正規化
//   との後着レースで戻された場合に bound 付きで再送還する(fix round 1/5 M-2・
//   詳細は `RedirectHome` 直上のコメント)。

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Card } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import {
  getQuickPresetCardsFromDexie,
  type QuickSelectionOutcome,
} from '@/lib/cards/get-quick-preset-cards'
import {
  deriveQuickOrigin,
  isQuickPreset,
  type QuickPreset,
} from '@/lib/cards/domain/quick-preset-selection'
import { useSelectedExam } from '@/lib/dashboard/use-selected-exam'
import { useOwnerExams } from '@/app/(app)/app/_components/use-owner-exams'
import { SessionLauncher } from '../../_components/session-launcher'

type QuickSessionHostProps = {
  userId: string
  sessionLimit: number | null
  fsrsMode: boolean
  // URL query params(page.tsx から未加工のまま渡る)。
  examId: string | undefined
  preset: string | undefined
  tagOptionId: string | undefined
}

const PRESET_HEADING: Record<QuickPreset, string> = {
  mistakes: '間違い',
  unanswered: '未出題',
  weak: '苦手',
  ten_min: '10分',
}

/**
 * `QuickSessionHost` の earlyInvalid gate を通過した後(= tag が無ければ preset は
 * 必ず 4 値のいずれか)という契約を型で確定させる。契約が破れていれば呼出側の
 * バグなので throw で検出する(`planMoveAssignments` 等の既存契約違反 throw と同
 * 方針・簡潔性規律: 起こりえないはずの状態を黙って別の preset にフォールバック
 * させない)。
 */
function assertValidatedPreset(preset: string | undefined): QuickPreset {
  if (preset === undefined || !isQuickPreset(preset)) {
    throw new Error(
      'QuickSessionHost: preset must already be validated by the earlyInvalid gate',
    )
  }
  return preset
}

function LoadingView() {
  return (
    <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
      Loading…
    </div>
  )
}

// fix round 1/5 M-2: 1 回だけの replace だと孤立しうる。 `useSelectedExam` の URL
// 正規化(use-selected-exam.ts — IndexedDB 書込を挟んだ非同期 replace で、
// `window.location.href` を基準に「まだ書き換わっていない」と判定してから
// issue する)が**後から**この route の URL(不正な preset/tag を含む)へ書き戻す
// レースがある: Next の client 遷移は fetch を挟む非同期処理なので、 この
// replace('/app') がまだ実際の URL としてコミットされていない間は
// `window.location` はまだ quick route のままであり、 useSelectedExam 側は
// 「まだ正規化前」と誤認して自分の replace を issue する。 それが後着すると
// pathname が一度も `/app` に変わらない(= 本 component が unmount しない)まま
// quick route の URL に引き戻り、 mount-only effect は再発火しないため
// Loading のまま孤立する。 pull-trigger.tsx と同じ「outcome を信頼せず bound
// 付きで待って再試行する」パターンで、 まだ quick route に留まっていれば
// replace を再発行する。
const REDIRECT_RETRY_DELAY_MS = 150
const REDIRECT_MAX_RETRIES = 10

/** 不正入力(§7)の送還先。 mount 後すぐ home へ replace し、 レースで戻された場合は再送還する。 */
function RedirectHome() {
  const router = useRouter()
  useEffect(() => {
    let cancelled = false
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

    const attempt = (retriesLeft: number) => {
      if (cancelled) return
      router.replace('/app')
      if (retriesLeft <= 0) return
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        // pathname だけを見る(query の不正値がどう正規化されても quick route
        // に留まっている限り送還対象 — exam/preset/tag の具体値には依存しない)。
        // まだ離脱できていなければ(= 上の replace がレースで上書きされた)再送還。
        if (
          !cancelled &&
          window.location.pathname.startsWith('/app/study/quick')
        ) {
          attempt(retriesLeft - 1)
        }
      }, REDIRECT_RETRY_DELAY_MS)
      pendingTimers.add(timer)
    }

    attempt(REDIRECT_MAX_RETRIES)

    return () => {
      cancelled = true
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
    }
  }, [router])
  return <LoadingView />
}

export function QuickSessionHost(props: QuickSessionHostProps) {
  // tag が無いときだけ preset の enum を検証する(§7: tag entry は preset を
  // 無視するため、tag があれば preset の値は問わない)。Dexie に依存しない同期
  // 判定なので、cold-mirror gate より先に判定してよい(不要な Loading を挟まない)。
  const earlyInvalid =
    props.tagOptionId === undefined &&
    !isQuickPreset(props.preset ?? '')

  // spec §5 の前段制御状態「初回 pull 未 settle」をこの入口にも適用する
  // (home / smart と同じ gate — 実装は `use-owner-exams.ts` に 1 定義)。
  const { examIds } = useOwnerExams(props.userId)

  if (earlyInvalid) return <RedirectHome />

  if (examIds === undefined) {
    return <LoadingView />
  }
  return <ResolvedQuickSessionHost {...props} examIds={examIds} />
}

function ResolvedQuickSessionHost({
  userId,
  sessionLimit,
  fsrsMode,
  examId,
  preset,
  tagOptionId,
  examIds,
}: QuickSessionHostProps & { examIds: string[] }) {
  const resolution = useSelectedExam({ userId, urlExamId: examId, examIds })
  const resolvedExamId =
    resolution?.outcome === 'resolved' ? resolution.examId : undefined

  const [selection, setSelection] = useState<{
    key: string
    cards: Card[]
  } | null>(null)
  const [invalid, setInvalid] = useState(false)
  const appliedKeyRef = useRef<string | null>(null)
  const selectionEpochRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 選定は (試験, preset, tag) の組で 1 回だけ(study-session-host.tsx の
  // 「1 session = 1 選定」と同じ理由 — SessionRunner は cards[idx] を live に読む)。
  const selectionKey =
    resolvedExamId === undefined
      ? null
      : `${resolvedExamId}|${preset ?? ''}|${tagOptionId ?? ''}`

  useEffect(() => {
    if (selectionKey === null || resolvedExamId === undefined) return
    if (appliedKeyRef.current === selectionKey) return
    appliedKeyRef.current = selectionKey
    selectionEpochRef.current += 1
    const myEpoch = selectionEpochRef.current
    void (async () => {
      let outcome: QuickSelectionOutcome
      try {
        outcome = await getQuickPresetCardsFromDexie(
          userId,
          resolvedExamId,
          preset,
          tagOptionId,
          sessionLimit,
        )
      } catch {
        // silent fallback: Dexie 例外は空扱い(get-dexie-session-cards.ts の
        // silent fallback と同方針)。quick には server fallback が無いため。
        outcome = { kind: 'cards', cards: [] }
      }
      if (selectionEpochRef.current !== myEpoch) return // 遅着 guard
      if (!mountedRef.current) return
      if (outcome.kind === 'invalid') {
        setInvalid(true)
        return
      }
      setSelection({ key: selectionKey, cards: outcome.cards })
    })()
  }, [selectionKey, resolvedExamId, userId, sessionLimit, preset, tagOptionId])

  if (invalid) return <RedirectHome />

  const displayCards: Card[] | null =
    resolution === undefined
      ? null
      : resolvedExamId === undefined
        ? []
        : selection?.key === selectionKey
          ? selection.cards
          : null

  if (displayCards === null) return <LoadingView />

  // tag が与えられたら preset の値によらず home_weak_tags(§7・pure module の
  // コメント参照)。tag が無ければ preset は QuickSessionHost の earlyInvalid gate
  // を通過済み(assertValidatedPreset 参照)。
  const origin =
    tagOptionId !== undefined
      ? 'home_weak_tags'
      : deriveQuickOrigin(assertValidatedPreset(preset))
  const heading =
    tagOptionId !== undefined
      ? 'この分野を10問'
      : PRESET_HEADING[assertValidatedPreset(preset)]

  const emptyUI = (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-12 text-center">
      <h1 className="text-2xl font-bold">{heading}</h1>
      <p className="text-slate-600">対象の card がありません。</p>
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
      heading={heading}
      emptyState={emptyUI}
    />
  )
}
