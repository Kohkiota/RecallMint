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
}

type View = 'card' | 'table'

export function ExamDetailView({ initialCards, examId, userId }: ExamDetailViewProps) {
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

  return (
    <div className="space-y-4 pb-8">
      {/* ViewToggle: 水平 cap のみ (py-0 で py-8 を打ち消し、mx-auto max-w-4xl px-4 が残る) */}
      <AppContainer className="py-0">
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
      </AppContainer>

      {/* conditional render: view='card' のとき InlineCardList (capped)、 view='table' のとき ExamCardTable (full-width)。
          OQ-5 案 S-A: conditional unmount で同時刻に 2 subscription にならないことを構造的に保証。
          Edit-1 T2: card view は AppContainer で水平 cap、table view は w-full px-2 md:px-4 で full-width。 */}
      {view === 'card' && (
        <AppContainer className="py-0">
          <InlineCardList initialCards={initialCards} examId={examId} userId={userId} />
        </AppContainer>
      )}
      {view === 'table' && (
        <div className="w-full px-2 md:px-4">
          <ExamCardTable examId={examId} userId={userId} />
        </div>
      )}
    </div>
  )
}
