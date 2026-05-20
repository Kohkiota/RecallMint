'use client'

import { useState, useEffect } from 'react'
import { useUser, useReverification } from '@clerk/nextjs'
import {
  isClerkRuntimeError,
  isReverificationCancelledError,
} from '@clerk/nextjs/errors'
import type { User } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'

// polling の間隔と最大試行回数。max 30 秒 = 1 秒 × 30 回で zombie net が吸収する
const POLL_INTERVAL_MS = 1000
const POLL_MAX_ATTEMPTS = 30

type Phase = 'idle' | 'confirm' | 'deleting' | 'polling' | 'error'

interface Props {
  plan: User['plan']
}

export function DeleteAccountButton({ plan }: Props) {
  const { user } = useUser()
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // user.delete() 後は useUser() の user が null になるため、削除前に userId を memorize する
  const [memoizedUserId, setMemoizedUserId] = useState<string | null>(null)

  // user.delete() は Clerk 仕様上 sensitive action で、 session reverification
  // (直近の再認証) を要求する。 自前 UI は prebuilt <UserProfile /> と違い SDK の
  // 自動 handle が効かず、 生の user.delete() は 403 session_reverification_required
  // で reject される。 useReverification で wrap すると、 Clerk が必要時に
  // reverification modal を出し、 再認証後に元 request を自動 retry する。
  // 詳細: docs/superpowers/lessons/2026-05-19-clerk-self-delete-requires-reverification.md
  // user が null の場合 fetcher は undefined を返すが、 onConfirmDelete 冒頭の
  // `if (!user) return` guard により deleteAccount() はそもそも呼ばれない。
  const deleteAccount = useReverification(() => user?.delete())

  const onConfirmDelete = async () => {
    if (!user) return
    // memorize userId before calling user.delete() which nullifies useUser().user
    setMemoizedUserId(user.id)
    setPhase('deleting')
    setErrorMsg(null)
    try {
      await deleteAccount()
      setPhase('polling')
    } catch (err) {
      // reverification modal を user がキャンセルした場合は「失敗」 ではなく
      // 「中断」。 confirm phase に戻して再試行可能にし、 error message は出さない。
      if (isClerkRuntimeError(err) && isReverificationCancelledError(err)) {
        setMemoizedUserId(null)
        setPhase('confirm')
        return
      }
      // それ以外の reject (ClerkAPIResponseError / network error 等) は失敗扱い。
      // 真因切り分けのため err を必ず console に出し、 staging では UI にも詳細を
      // 露出する (production は汎用文言のまま、 内部情報を end user に見せない)。
      console.error('[delete-button] user.delete() failed:', err)
      const isStaging = process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production'
      const detail = err instanceof Error ? err.message : String(err)
      setErrorMsg(
        isStaging
          ? `削除に失敗しました: ${detail}`
          : '削除に失敗しました。時間を置いて再度お試しください。',
      )
      setPhase('error')
    }
  }

  // polling effect: user.delete() 完了後に /api/me/deletion-status を 3 秒間隔で監視し、
  // completed / not_found を検知したら /sign-out-deleted へ navigate する
  // React 18 Strict Mode 対応: cleanup で clearInterval + controller.abort() を必ず実行する
  useEffect(() => {
    if (phase !== 'polling' || !memoizedUserId) return

    const controller = new AbortController()
    let cancelled = false
    let attempts = 0

    // navigate に window.location.replace を使う理由:
    // router.push() は soft navigation で /app/settings を Router Cache に
    // 保持してしまい、back ボタンで Router Cache 復元 → middleware/layout の
    // zombie net (deletedAt redirect) が走らず削除済 user 画面が安定表示される
    // bug を起こす (Phase 1 D-3 verify で確認)。window.location.replace は
    // hard navigation で history 置換 + Router Cache + BFCache を完全 bypass。
    const intervalId = setInterval(async () => {
      attempts++
      if (attempts > POLL_MAX_ATTEMPTS) {
        // 30 秒経過しても completed が来ない場合は強制 navigate (zombie net で吸収)
        clearInterval(intervalId)
        if (!cancelled) window.location.replace('/sign-out-deleted')
        return
      }
      try {
        const res = await fetch(
          `/api/me/deletion-status?userId=${encodeURIComponent(memoizedUserId)}`,
          { signal: controller.signal, cache: 'no-store' },
        )
        if (!res.ok) return // 一時失敗は skip して次 interval で再試行
        const data: { status: string } = await res.json()
        if (data.status === 'completed' || data.status === 'not_found') {
          clearInterval(intervalId)
          if (!cancelled) window.location.replace('/sign-out-deleted')
        }
      } catch {
        // AbortError はunmount 時の cleanup、それ以外は次 interval で再試行
      }
    }, POLL_INTERVAL_MS)

    return () => {
      // unmount 後の setState を防ぐためフラグを立て、fetch も中断する
      cancelled = true
      clearInterval(intervalId)
      controller.abort()
    }
  }, [phase, memoizedUserId])

  if (phase === 'idle') {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPhase('confirm')}
        className="px-4 py-2 border-red-300 text-red-700 hover:bg-red-50 text-sm font-medium"
      >
        アカウントを削除
      </Button>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className="space-y-3">
        <div className="text-sm text-red-700 space-y-2">
          <p>アカウントを完全に削除します。元に戻せません。</p>
          {plan !== 'free' && (
            // 課金プラン (standard / pro) 共通の警告。 削除フロー (clerk webhook
            // → stripe.subscriptions.list 全 cancel) は plan 非依存なので
            // 文言も plan で分岐しない (Step 1 調査で確認済)。
            <p>
              現在 課金プランをご利用中です。
              削除と同時に課金は停止し、残り期間の返金はありません。
              解約撤回・請求の確認は『お支払い・解約を管理』からも可能です。
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            onClick={onConfirmDelete}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
          >
            削除する
          </Button>
          <Button
            variant="outline"
            onClick={() => setPhase('idle')}
            className="px-4 py-2 text-sm"
          >
            キャンセル
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'deleting') {
    return (
      <Button
        disabled
        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
      >
        削除中…
      </Button>
    )
  }

  if (phase === 'polling') {
    return (
      <div className="text-sm text-slate-600">
        削除処理を確認中です。しばらくお待ちください…
      </div>
    )
  }

  // phase === 'error'
  return (
    <div className="space-y-2">
      {errorMsg && <p className="text-red-600 text-sm">{errorMsg}</p>}
      <Button
        variant="outline"
        onClick={() => {
          setPhase('idle')
          setErrorMsg(null)
          setMemoizedUserId(null)
        }}
        className="px-4 py-2 border-red-300 text-red-700 hover:bg-red-50 text-sm font-medium"
      >
        再試行
      </Button>
    </div>
  )
}
