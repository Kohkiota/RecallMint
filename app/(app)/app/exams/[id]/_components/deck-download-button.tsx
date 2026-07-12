'use client'

// DeckDownloadButton: デッキ (exam 配下 cards) の添付画像を一括で先行キャッシュする
// 入口 UI (画像フェーズ A Task 12 / spec §6・§7)。
//
// - click で downloadDeckImages(userId, examId, { resolveAssetUrls }, { onProgress }) を実行。
// - 実行中は進捗 (done/total) + 警告「完了までタブを閉じないでください」を表示。
// - 完了で成功/失敗メッセージを表示。
// - 非 standalone 起動時は InstallPrompt (ホーム画面追加案内) を併せて出す
//   (all-or-nothing でキャッシュした画像の耐久性は install が前提、 spec §7)。
//
// resolveAssetUrls は ESLint Block A を避けるため props でなく本 client component から
// 実 action を直接 import して DI する (get-asset.ts / card-image-gallery.tsx と同型)。

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { downloadDeckImages } from '@/lib/media/deck-download'
import { InstallPrompt } from '@/components/pwa/install-prompt'
import { resolveAssetUrls } from '../_actions/asset-actions'

type Phase = 'idle' | 'running' | 'done' | 'error'

type Props = {
  userId: string
  examId: string
}

export function DeckDownloadButton({ userId, examId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  })
  const [message, setMessage] = useState<string | null>(null)

  const handleClick = async () => {
    setPhase('running')
    setProgress({ done: 0, total: 0 })
    setMessage(null)
    try {
      const result = await downloadDeckImages(
        userId,
        examId,
        { resolveAssetUrls },
        { onProgress: (done, total) => setProgress({ done, total }) },
      )
      if (result.ok) {
        setPhase('done')
        setMessage(
          result.downloaded > 0
            ? `${result.downloaded} 枚の画像をオフライン用に保存しました。`
            : 'すべての画像は既に保存済みです。',
        )
      } else if (result.reason === 'busy') {
        // 別タブが同デッキを保存中 = 失敗ではない。 retry を促さず案内に留める。
        setPhase('idle')
        setMessage('別のタブでこのデッキの画像を保存中です。完了までお待ちください。')
      } else {
        setPhase('error')
        setMessage('画像の保存に失敗しました。時間をおいて再試行してください。')
      }
    } catch {
      setPhase('error')
      setMessage('画像の保存に失敗しました。時間をおいて再試行してください。')
    }
  }

  const running = phase === 'running'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          onClick={handleClick}
          disabled={running}
        >
          {running ? '画像を保存中…' : '画像をオフライン保存'}
        </Button>
        {running && progress.total > 0 && (
          <span className="text-xs text-slate-500" aria-live="polite">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {running && (
        <p className="text-xs text-amber-700">完了までタブを閉じないでください</p>
      )}

      {message && (
        <p
          className={
            phase === 'error'
              ? 'text-xs text-destructive'
              : 'text-xs text-slate-600'
          }
        >
          {message}
        </p>
      )}

      {/* 非 standalone 起動時のみ install 案内を出す (standalone なら InstallPrompt が
          自身で null を返す)。 */}
      <InstallPrompt />
    </div>
  )
}
