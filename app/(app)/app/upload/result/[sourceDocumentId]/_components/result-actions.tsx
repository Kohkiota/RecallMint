'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { discardUpload } from '../../../_actions/discard'

// S1.9.2: result page の操作 button。 button 構成は 2 つに整理:
//  - 「保存して試験一覧へ」: cards は OCR 完了時点で既に DB 確定済のため確定処理
//    不要、 単純 navigation
//  - 「破棄して再アップロード」: discardUpload で今回 OCR を破棄 → /app/upload へ。
//    /app/upload は fresh server render されるため残量 banner は常に正値 (Bug B 解消)
//
// 旧「同じファイルでやり直す」 は廃止 (File オブジェクトが page navigation で
// 消えるため成立しない、 retry の主目的は error phase 側)。
export function ResultActions({
  sourceDocumentId,
}: {
  sourceDocumentId: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  function handleDiscard() {
    setErrorMsg(null)
    startTransition(async () => {
      const result = await discardUpload(sourceDocumentId)
      if (result.ok) {
        router.push('/app/upload')
      } else {
        setErrorMsg(result.error)
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2">
        <Button asChild className="flex-1 py-3 text-base font-bold">
          <Link href="/app/exams">保存して試験一覧へ</Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleDiscard}
          disabled={isPending}
          className="flex-1 py-3 text-base"
        >
          {isPending ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              破棄しています…
            </span>
          ) : (
            '破棄して再アップロード'
          )}
        </Button>
      </div>

      {errorMsg && (
        <p className="text-sm text-red-700" role="alert">
          {errorMsg}
        </p>
      )}

      {/* 破棄の注意喚起。 「破棄したら残量が戻る」 と誤解されないよう、 利用枠は
          戻らない旨を明示する (Gemini API call は走り済 = 月次消費は計上済)。 */}
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">⚠ ご注意</p>
        <p className="mt-1">
          「破棄して再アップロード」 を押すと、 ここまでの抽出結果は破棄されます。
          ただし AI 抽出の利用枠は元に戻りません。
        </p>
      </div>
    </div>
  )
}
