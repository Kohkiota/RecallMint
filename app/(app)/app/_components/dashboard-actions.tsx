'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

export function DashboardActions({ dueCount }: { dueCount: number }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {dueCount > 0 ? (
        <Button asChild size="lg" className="w-full py-4 text-lg font-bold rounded-xl">
          {/* /app/review (vocab) 撤去済。 後続 Sprint で /study/smart 実装後に切替予定、
              現状は /app/quiz placeholder に暫定リンク。 */}
          <Link
            href="/app/quiz"
            onClick={() => void revalidateAppPath('/app/quiz')}
          >
            スマート復習（{dueCount}件）
          </Link>
        </Button>
      ) : (
        <div className="block w-full py-4 bg-slate-200 text-slate-500 rounded-xl text-center font-bold text-lg">
          復習完了！
        </div>
      )}
      <Button asChild size="lg" className="w-full py-4 text-lg font-bold rounded-xl">
        <Link
          href="/app/quiz"
          onClick={() => void revalidateAppPath('/app/quiz')}
        >
          問題演習
        </Link>
      </Button>
    </div>
  )
}
