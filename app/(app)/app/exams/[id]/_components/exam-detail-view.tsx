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
import type { OnChangeFn, VisibilityState } from '@tanstack/react-table'
import type { ExamDetailCard } from '@/lib/exams/list'
import {
  SYNC_META_KEYS,
  examViewPrefsSchema,
  examViewPrefsV2Schema,
  examViewPrefsToV2,
  getJsonSyncMeta,
  setJsonSyncMeta,
} from '@/lib/sync/sync-meta'
import { Button } from '@/components/ui/button'
import { AppContainer } from '../../../_components/app-container'
import { InlineCardList } from './inline-card-list'
import { ExamCardTable } from './exam-card-table'
import { ColumnVisibilityToggle } from './exam-card-table-column-toggle'

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
  // S2-5: columnVisibility state + examViewPrefs 永続を exam-detail-view に集約 (案 P)。
  // 旧 split-brain (view=detail-view / hiddenColumns=ExamCardTable) を単一所有へ。
  // 初期 { sort_key: false } は saved record の無い新規ユーザーにのみ適用。 saved があれば
  // mount load が setColumnVisibility(map) で上書きする (hiddenColumns:[] = 全列表示)。
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ sort_key: false })
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
        const { view: savedView, hiddenColumns } = examViewPrefsToV2(saved)
        if (savedView !== view) setView(savedView)
        const map: VisibilityState = {}
        for (const id of hiddenColumns) map[id] = false
        setColumnVisibility(map)
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
  const handleToggle = (nextView: View) => {
    if (nextView === view) return
    userInteractedRef.current = true
    setView(nextView)
  }

  // fix2: 列変更 (ExamCardTable / ColumnVisibilityToggle) を wrap し userInteracted を立てる。
  // 生の setColumnVisibility でなくこの wrap を controlled prop として渡す (mount load の
  // setColumnVisibility は wrap を通さないため無操作扱いのまま = spurious write なし)。
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) => {
    userInteractedRef.current = true
    setColumnVisibility(updater)
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
    void setJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view, hiddenColumns: deriveHiddenColumns(columnVisibility) },
      examViewPrefsV2Schema,
    ).catch(() => {})
  }, [prefsLoaded, view, columnVisibility])

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
    <div className="space-y-1 pb-8">
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
          {/* ViewToggle: 水平 cap のみ (py-0 で py-8 を打ち消し、mx-auto max-w-4xl px-4 が残る) */}
          <AppContainer className="py-0">{viewToggle}</AppContainer>
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
          {/* 上部 chrome (flex-none): タイトル/日付 (最小・1 行 truncate・日付さらに小さく) + view 切替。 */}
          <div
            data-testid="table-chrome"
            className="flex-none flex items-center justify-between gap-2 px-2 py-2 md:px-4"
          >
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
          {/* 表領域 (flex-1 min-h-0): S2-2 の overflow-auto 密封が効く土台。 Edit-1 T2: full-width。
              S2-5: columnVisibility を controlled prop で渡す (state 所有 + 永続は本 component)。 */}
          <div className="w-full flex-1 min-h-0 px-2 md:px-4">
            <ExamCardTable
              examId={examId}
              userId={userId}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={handleColumnVisibilityChange}
            />
          </div>
        </div>
      )}
    </div>
  )
}
