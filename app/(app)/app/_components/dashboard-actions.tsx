'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

export function DashboardActions({ dueCount }: { dueCount: number }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {dueCount > 0 ? (
        <Button asChild size="lg" className="w-full py-4 text-lg font-bold rounded-xl">
          {/* T6 (S2.1): /app/quiz placeholder 撤去、 /app/study/smart に差替 (S2.2.1 T2: /session 撤去で /app/study/smart に統合)。 */}
          <Link
            href="/app/study/smart"
            onClick={() => void revalidateAppPath('/app/study/smart')}
          >
            スマート復習（{dueCount}件）
          </Link>
        </Button>
      ) : (
        <div className="block w-full py-4 bg-slate-200 text-slate-500 rounded-xl text-center font-bold text-lg">
          復習完了！
        </div>
      )}
      {/* T6 (S2.1): 右 button は /app/quiz 撤去に伴い disabled に。
          href は S2.3 カスタム演習実装後に復活。 */}
      <Button
        size="lg"
        className="w-full py-4 text-lg font-bold rounded-xl"
        disabled
      >
        カスタム演習（準備中）
      </Button>
    </div>
  )
}
