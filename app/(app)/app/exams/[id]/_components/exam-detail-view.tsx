'use client'

// ExamDetailView: view state + view prefs orchestrator。
// - ViewToggle (独自 button group, OQ-4 案 V-B) を内包し card / table 切替を管理。
// - mount 後 useEffect で Dexie sync_meta から saved prefs を load (案 F-1: SSR は
//   default 'card'、 flicker 1 frame 許容)。
// - view 切替時は fire-and-forget で setJsonSyncMeta を書込 (await しない)。
// - view='card': InlineCardList / view='table': ExamCardTable (Grid-1 T5 で差し替え済み)。

import { useEffect, useRef, useState } from 'react'
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

  // mount 後に saved prefs を Dexie から load (SSR では default 'card' で render)。
  // saved が 'table' なら setState で切替 (flicker 1 frame 許容、 案 F-1)。
  // 不正値 / 欠損は getJsonSyncMeta が undefined 返し → setState せず default 維持。
  useEffect(() => {
    let cancelled = false
    // Edit-2 Task 4: union schema で v1/v2 両対応 read → toV2 で正規化し view のみ使用。
    void getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema).then((saved) => {
      if (cancelled) return
      if (saved) {
        const { view: savedView } = examViewPrefsToV2(saved)
        if (savedView !== view) setView(savedView)
      }
    })
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 1 回のみ。 deps に view を入れると save→load loop の危険 (§11.3 案 F-1)
  }, [])

  // view 切替: setState 即時 + sync_meta は fire-and-forget で書込 (失敗は次回 load の fallback で吸収)。
  // Edit-2 Task 4: READ-MODIFY-WRITE。 table 側が書いた hiddenColumns を消さないよう、
  // 現在 record を read → toV2 → hiddenColumns を保持したまま v2 で書込む。
  const handleToggle = (nextView: View) => {
    if (nextView === view) return
    setView(nextView)
    void getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema)
      .then((saved) => {
        const hiddenColumns = saved ? examViewPrefsToV2(saved).hiddenColumns : []
        return setJsonSyncMeta(
          SYNC_META_KEYS.examViewPrefs,
          { version: 2, view: nextView, hiddenColumns },
          examViewPrefsV2Schema,
        )
      })
      .catch(() => {})
  }

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
            {viewToggle}
          </div>
          {/* 表領域 (flex-1 min-h-0): S2-2 の overflow-auto 密封が効く土台。 Edit-1 T2: full-width。
              ExamCardTable 内部 (条件バー/列ボタン/virtualizer) は S2-2 以降で扱う = props 追加なし。 */}
          <div className="w-full flex-1 min-h-0 px-2 md:px-4">
            <ExamCardTable examId={examId} userId={userId} />
          </div>
        </div>
      )}
    </div>
  )
}
