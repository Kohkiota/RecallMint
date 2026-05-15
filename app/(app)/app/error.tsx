'use client'

// Phase 1 G-baseline-2 (I-baseline-6): signed-in zone (/app/**) の uncaught
// error fallback。親 layout (app/(app)/app/layout.tsx) の subtree 内で render される
// ため、<html>/<body> は親に委譲、ヘッダー / ナビゲーションは layout 経由で残る。

import { Button } from '@/components/ui/button'

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <h2 className="text-xl font-bold text-slate-900 mb-2">
        画面の表示中にエラーが発生しました
      </h2>
      <p className="text-slate-600 mb-6">
        時間を置いて再度お試しください。
      </p>
      <Button
        onClick={() => reset()}
        size="lg"
        className="px-6 py-3 font-medium"
      >
        再試行
      </Button>
    </div>
  )
}
