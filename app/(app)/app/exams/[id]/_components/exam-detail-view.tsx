'use client'

// ExamDetailView: view state + view prefs orchestrator。
// - ViewToggle (独自 button group, OQ-4 案 V-B) を内包し card / table 切替を管理。
// - mount 後 useEffect で Dexie sync_meta から saved prefs を load (案 F-1: SSR は
//   default 'card'、 flicker 1 frame 許容)。
// - 永続 (view + hiddenColumns) は prefsLoaded (state) + userInteracted guard 付きの単一
//   effect に集約し fire-and-forget で書込 (await しない)。 view 切替 (handleToggle) は
//   setState のみ (userInteracted を立てる)。 load 完了で effect 再発火し pre-load 変更を replay。
// - view='card': InlineCardList / view='table': ExamCardTable (Grid-1 T5 で差し替え済み)。

import { useEffect, useRef, useState } from 'react'
import type { OnChangeFn, VisibilityState, ColumnPinningState } from '@tanstack/react-table'
import type { ExamDetailCard } from '@/lib/exams/list'
import { cn } from '@/lib/utils'
import {
  SYNC_META_KEYS,
  examViewPrefsSchema,
  examViewPrefsV3Schema,
  examViewPrefsToV3,
  getJsonSyncMeta,
  setJsonSyncMeta,
} from '@/lib/sync/sync-meta'
import { computePinnedLeft, derivePinnedBoundary } from '../_lib/column-pinning'
import { Button } from '@/components/ui/button'
import { AppContainer } from '@/app/(app)/app/_components/app-container'
import { InlineCardList } from './inline-card-list'
import { ExamCardTable } from './exam-card-table'
import { ColumnVisibilityToggle } from './exam-card-table-column-toggle'
import { DeckDownloadButton } from './deck-download-button'

type ExamDetailViewProps = {
  initialCards: ExamDetailCard[]
  examId: string
  userId: string
  // S2-1: タイトル/日付を page.tsx から移管 (table view の app-shell chrome は
  // view=client state 依存ゆえ client 側でしか組めない)。
  // S2-1 fix: hydration mismatch 解消 — server preformat 済み文字列を受け取る。
  examName: string
  createdLabel: string
  updatedLabel: string
  archivedAt: Date | null
}

type View = 'card' | 'table'

export function ExamDetailView({
  initialCards,
  examId,
  userId,
  examName,
  createdLabel,
  updatedLabel,
  archivedAt,
}: ExamDetailViewProps) {
  const [view, setView] = useState<View>('card')
  // S2b-1: table-chrome の collapse 状態。ExamCardTable の onCollapsedChange で更新。
  // table view 離脱時にリセット(stale collapse 禁止)。
  const [chromeCollapsed, setChromeCollapsed] = useState(false)
  // S2b-1: table-chrome 外側 wrapper の ref。ExamCardTable が短コンテンツ guard に使う。
  const chromeRef = useRef<HTMLDivElement>(null)
  // S2-5: columnVisibility state + examViewPrefs 永続を exam-detail-view に集約 (案 P)。
  // 旧 split-brain (view=detail-view / hiddenColumns=ExamCardTable) を単一所有へ。
  // 初期 { sort_key: false } は saved record の無い新規ユーザーにのみ適用。 saved があれば
  // mount load が setColumnVisibility(map) で上書きする (hiddenColumns:[] = 全列表示)。
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ sort_key: false })
  // S5-2: columnPinning state — handleColumnVisibilityChange と同型の controlled prop 化。
  // 初期 { left: [], right: [] } は「固定なし」。 mount load で pinnedBoundary を復元する。
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: [], right: [] })
  // 永続ガード (fix2): mount load 完了前に persist effect が初期 state を書込んで既存 record を
  // 壊すのを防ぐ (load 完了で true)。 ref ではなく state — load 完了で persist effect を再発火
  // させて pre-load の view 変更を replay する (fix1 の ref は再発火せず pre-load 変更が消失した)。
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  // ユーザー明示操作フラグ (fix2): load 完了で effect が再発火しても、 実際にユーザーが view/列を
  // 操作するまでは書かない。 新規ユーザーが開いただけ (無操作) の spurious mount write を防ぐ。
  const userInteractedRef = useRef(false)

  // mount 後に saved prefs を Dexie から load (SSR では default 'card' で render)。
  // S2-5: view と hiddenColumns の両方を 1 回で読む (旧: view=detail-view / hiddenColumns=table
  // の 2 箇所 load を単一化)。 saved が 'table' なら setView (flicker 1 frame 許容、 案 F-1)、
  // hiddenColumns があれば { [id]: false } map に変換して setColumnVisibility。
  // 不正値 / 欠損は getJsonSyncMeta が undefined 返し → setState せず default 維持。
  useEffect(() => {
    let cancelled = false
    void getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema).then((saved) => {
      if (cancelled) return
      if (saved) {
        // S5-2: toV3 で V1/V2/V3 を正規化し pinnedBoundary を取得 (V1/V2 → null)。
        const { view: savedView, hiddenColumns, pinnedBoundary } = examViewPrefsToV3(saved)
        if (savedView !== view) setView(savedView)
        const map: VisibilityState = {}
        for (const id of hiddenColumns) map[id] = false
        setColumnVisibility(map)
        // S5-2: pinnedBoundary → computePinnedLeft で left 配列を復元。
        // 未知 id は computePinnedLeft が [] に落とす(load 時無害化)。
        setColumnPinning({ left: computePinnedLeft(pinnedBoundary), right: [] })
      }
      setPrefsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 1 回のみ。 deps に view を入れると save→load loop の危険 (§11.3 案 F-1)
  }, [])

  // S2-5: 非表示列 id を columnVisibility state から導出 (value===false の列、 select 除外)。
  const deriveHiddenColumns = (visibility: VisibilityState): string[] =>
    Object.keys(visibility).filter(
      (id) => visibility[id] === false && id !== 'select',
    )

  // view 切替: setState のみ (UI 即応)。 永続は下の guard 付き effect が一元的に担う。
  // S2-5 fix (R3): handleToggle は直接 setJsonSyncMeta を呼ばない (guard 付き effect 経由)。
  // fix2: ユーザー明示操作なので userInteracted を立てる (load 完了後の replay/永続を許可)。
  // S2b-1: table view を離脱するときに chromeCollapsed をリセット(stale collapse 防止)。
  const handleToggle = (nextView: View) => {
    if (nextView === view) return
    userInteractedRef.current = true
    if (view === 'table') setChromeCollapsed(false)
    setView(nextView)
  }

  // fix2: 列変更 (ExamCardTable / ColumnVisibilityToggle) を wrap し userInteracted を立てる。
  // 生の setColumnVisibility でなくこの wrap を controlled prop として渡す (mount load の
  // setColumnVisibility は wrap を通さないため無操作扱いのまま = spurious write なし)。
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) => {
    userInteractedRef.current = true
    setColumnVisibility(updater)
  }

  // S5-2: columnPinning 変更を wrap し userInteracted を立てる (handleColumnVisibilityChange と同型)。
  // mount load の setColumnPinning は wrap を通さないため spurious write なし。
  const handleColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    userInteractedRef.current = true
    setColumnPinning(updater)
  }

  // S2-5 fix: view / columnVisibility いずれの変更でも自 state から永続化 (fire-and-forget)。
  // 単一所有ゆえ view・hiddenColumns の両方が state にあり read-preserve dance は不要。
  // load 完了前 (prefsLoaded=false) は early-return: pre-load の default state 書込
  // (R3 clobber) を根絶する。 fix2: prefsLoaded は state ゆえ load 完了で本 effect が再発火し
  // pre-load の view 変更を replay する。 但し userInteracted=false (無操作) の間は書かない
  // (新規ユーザーの spurious mount write / mount echo write の抑止)。
  useEffect(() => {
    if (!prefsLoaded) return
    if (!userInteractedRef.current) return
    // S5-2: 書込を V3 に変更。pinnedBoundary を columnPinning から導出して付加する。
    void setJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      {
        version: 3,
        view,
        hiddenColumns: deriveHiddenColumns(columnVisibility),
        pinnedBoundary: derivePinnedBoundary(columnPinning),
      },
      examViewPrefsV3Schema,
    ).catch(() => {})
  }, [prefsLoaded, view, columnVisibility, columnPinning])

  // S2-1 app-shell 骨格: table view を viewport 高の flex 列にする。 高さは固定 px 禁止
  // (spec Global) ゆえ shell の上端 offset を実測し height: calc(100dvh - <topOffset>px)。
  // nav (app-header) の高さ変化・breadcrumb 有無に依存せず robust。 密封 (container
  // overflow 化・内部スクロール主体化) は S2-2 = ここでは骨格のみ (document スクロール継続許容)。
  const shellRef = useRef<HTMLDivElement>(null)
  const [shellTop, setShellTop] = useState(0)
  useEffect(() => {
    if (view !== 'table') return
    const el = shellRef.current
    if (!el) return
    const measure = () => setShellTop(el.getBoundingClientRect().top)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [view])

  // view 切替 button 群 (両 view の chrome で再利用する local element)。
  const viewToggle = (
    <div role="group" aria-label="表示モード切替" className="flex gap-1">
      <Button
        variant={view === 'card' ? 'default' : 'outline'}
        size="xs"
        aria-pressed={view === 'card'}
        onClick={() => handleToggle('card')}
      >
        カード
      </Button>
      <Button
        variant={view === 'table' ? 'default' : 'outline'}
        size="xs"
        aria-pressed={view === 'table'}
        onClick={() => handleToggle('table')}
      >
        テーブル
      </Button>
    </div>
  )

  // 日付行 (作成 / 最終更新 + アーカイブ済バッジ)。 テキストは両 view で共通、
  // 見た目 (font-size 等) は各 view の p 側 className で調整する。
  // S2-1 fix: server preformat 済み文字列 (createdLabel/updatedLabel) を描画 — client で
  // formatRelativeJa を呼ばないことで SSR/hydration 2 回評価による mismatch を解消。
  const dateText = (
    <>
      作成 {createdLabel} ・ 最終更新 {updatedLabel}
      {archivedAt && <span className="ml-2 text-amber-700">(アーカイブ済)</span>}
    </>
  )

  return (
    // 試験詳細のみ密度優先で ViewToggle と直下 view の間隔を space-y-4(16px) → space-y-1(4px) に縮小
    // S2 scroll-fix: table view は内部スクロール container が下部余白を吸うため pb-8 不要(二重スクロール防止)
    <div className={cn('space-y-1', view === 'card' && 'pb-8')}>
      {/* conditional render: view='card' → InlineCardList (capped) / view='table' → app-shell 骨格。
          OQ-5 案 S-A: conditional unmount で同時刻に 2 subscription にならないことを構造的に保証。
          S2-1: card view はタイトル/日付 + view 切替を現状同等スタイルで document flow に描画
          (視覚維持)。 table view は viewport 高の app-shell chrome (flex-none) に収める。 */}
      {view === 'card' && (
        <>
          {/* card view: 現状 (page.tsx) 同等 = text-2xl bold タイトル + text-xs 日付。 視覚回帰ゼロ。 */}
          <AppContainer className="py-0">
            <header className="space-y-1">
              <h1 className="text-2xl font-bold">{examName}</h1>
              <p className="text-xs text-slate-500">{dateText}</p>
            </header>
          </AppContainer>
          {/* ViewToggle + 一括 DL 入口 (画像フェーズ A Task 12 / spec §6): card view header に配置。
              一括 DL は控えめな入口ゆえ ViewToggle と同じ帯に置く。 table view は密度優先の
              app-shell chrome ゆえ入口を出さない (card view のみ)。 */}
          <AppContainer className="py-0">
            <div className="flex items-start justify-between gap-2">
              {viewToggle}
              <DeckDownloadButton userId={userId} examId={examId} />
            </div>
          </AppContainer>
          {/* Edit-1 T2: card view は AppContainer で水平 cap */}
          <AppContainer className="py-0">
            <InlineCardList initialCards={initialCards} examId={examId} userId={userId} />
          </AppContainer>
        </>
      )}
      {view === 'table' && (
        // app-shell 骨格: viewport 追従高 (calc(100dvh - <topOffset>px), 固定 px 禁止) の flex 列。
        // 密封 (container overflow・virtualizer 差替) は S2-2 = ここでは骨格のみ。
        <div
          ref={shellRef}
          data-testid="table-app-shell"
          style={{ height: `calc(100dvh - ${shellTop}px)` }}
          className="flex flex-col min-h-0"
        >
          {/* S2b-1: 上部 chrome — grid-rows 0fr/1fr で unmount せずに collapse。
              flex-none で flex-col 内配分を担い、grid で内側コンテンツを畳む。
              chromeRef で offsetHeight を実測し ExamCardTable の短コンテンツ guard に渡す。
              transition 150ms + motion-reduce 非アニメ。 */}
          <div
            ref={chromeRef}
            data-testid="table-chrome"
            className={cn(
              'flex-none grid transition-[grid-template-rows] duration-150 motion-reduce:transition-none',
              chromeCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
            )}
          >
            <div className="min-h-0 overflow-hidden" inert={chromeCollapsed}>
              <div className="flex items-center justify-between gap-2 px-2 py-2 md:px-4">
                <div className="min-w-0">
                  <h1 className="truncate text-base font-bold">{examName}</h1>
                  <p className="truncate text-[11px] leading-tight text-slate-500">{dateText}</p>
                </div>
                {/* S2-5: view 切替と列ボタンを並べる (列ボタンは table view のみ)。 */}
                <div className="flex items-center gap-2">
                  <ColumnVisibilityToggle
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={handleColumnVisibilityChange}
                  />
                  {viewToggle}
                </div>
              </div>
            </div>
          </div>
          {/* 表領域 (flex-1 min-h-0): S2-2 の overflow-auto 密封が効く土台。 Edit-1 T2: full-width。
              S2-5: columnVisibility を controlled prop で渡す (state 所有 + 永続は本 component)。
              S2b-1: onCollapsedChange で collapsed 信号を受信し table-chrome を collapse。
                     chromeRef で chrome の offsetHeight を渡し短コンテンツ guard に使う。 */}
          <div className="w-full flex-1 min-h-0 px-2 md:px-4">
            <ExamCardTable
              examId={examId}
              userId={userId}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={handleColumnVisibilityChange}
              columnPinning={columnPinning}
              onColumnPinningChange={handleColumnPinningChange}
              onCollapsedChange={setChromeCollapsed}
              chromeRef={chromeRef}
            />
          </div>
        </div>
      )}
    </div>
  )
}
