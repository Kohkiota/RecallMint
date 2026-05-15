'use client'

// Phase 1 G-baseline-2 (I-baseline-5): root レベルの uncaught error fallback。
// Next.js は root layout を replace するため <html>/<body> を自前で含める必要がある。
// 通常の Server Action / Server Component throw は app/(app)/app/error.tsx (signed-in
// zone fallback) でハンドリングされ、本 fallback は root layout 自体の例外時のみ発火。

import { Button } from '@/components/ui/button'

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="ja">
      <body>
        <main className="min-h-screen flex flex-col items-center justify-center p-4 bg-slate-50">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            予期せぬエラーが発生しました
          </h1>
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
        </main>
      </body>
    </html>
  )
}
