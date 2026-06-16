'use client'

// ExamDetailView: view state + view prefs orchestrator。
// - ViewToggle (独自 button group, OQ-4 案 V-B) を内包し card / table 切替を管理。
// - mount 後 useEffect で Dexie sync_meta から saved prefs を load (案 F-1: SSR は
//   default 'card'、 flicker 1 frame 許容)。
// - view 切替時は fire-and-forget で setJsonSyncMeta を書込 (await しない)。
// - view='card': InlineCardList / view='table': ExamCardTable (Grid-1 T5 で差し替え済み)。

import { useEffect, useState } from 'react'
import type { ExamDetailCard } from '@/lib/exams/list'
import {
  SYNC_META_KEYS,
  examViewPrefsV1Schema,
  getJsonSyncMeta,
  setJsonSyncMeta,
} from '@/lib/sync/sync-meta'
import { Button } from '@/components/ui/button'
import { InlineCardList } from './inline-card-list'
import { ExamCardTable } from './exam-card-table'

type ExamDetailViewProps = {
  initialCards: ExamDetailCard[]
  examId: string
  userId: string
}

type View = 'card' | 'table'

export function ExamDetailView({ initialCards, examId, userId }: ExamDetailViewProps) {
  const [view, setView] = useState<View>('card')

  // mount 後に saved prefs を Dexie から load (SSR では default 'card' で render)。
  // saved が 'table' なら setState で切替 (flicker 1 frame 許容、 案 F-1)。
  // 不正値 / 欠損は getJsonSyncMeta が undefined 返し → setState せず default 維持。
  useEffect(() => {
    let cancelled = false
    void getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsV1Schema).then((saved) => {
      if (cancelled) return
      if (saved && saved.view !== view) {
        setView(saved.view)
      }
    })
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 1 回のみ。 deps に view を入れると save→load loop の危険 (§11.3 案 F-1)
  }, [])

  // view 切替: setState 即時 + sync_meta は fire-and-forget で書込 (失敗は次回 load の fallback で吸収)。
  const handleToggle = (nextView: View) => {
    if (nextView === view) return
    setView(nextView)
    void setJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 1, view: nextView },
      examViewPrefsV1Schema,
    ).catch(() => {})
  }

  return (
    <div className="space-y-4">
      {/* ViewToggle: 2 button + role="group" + aria-pressed (OQ-4 案 V-B 独自 button group) */}
      <div role="group" aria-label="表示モード切替" className="flex gap-1">
        <Button
          variant={view === 'card' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={view === 'card'}
          onClick={() => handleToggle('card')}
        >
          カード
        </Button>
        <Button
          variant={view === 'table' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={view === 'table'}
          onClick={() => handleToggle('table')}
        >
          テーブル
        </Button>
      </div>

      {/* conditional render: view='card' のとき InlineCardList、 view='table' のとき ExamCardTable (Grid-1 T5 で差し替え済み)。
          OQ-5 案 S-A: conditional unmount で同時刻に 2 subscription にならないことを構造的に保証。 */}
      {view === 'card' && (
        <InlineCardList initialCards={initialCards} examId={examId} userId={userId} />
      )}
      {view === 'table' && (
        <ExamCardTable examId={examId} userId={userId} />
      )}
    </div>
  )
}
