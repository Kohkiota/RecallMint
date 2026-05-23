'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

// page 全体は server component (現在の設定値を SELECT で取得) のため、
// onClick で revalidateAppPath を呼ぶ button 部分のみ client に分離。
// I-2 (S2.1 T6 review): 遷移直前に Router Cache を破棄して stale 表示を防ぐ。
export function StartButton() {
  return (
    <Button asChild size="lg" className="mt-4 w-full py-4 text-lg font-bold rounded-xl">
      <Link
        href="/app/study/smart/session"
        onClick={() => void revalidateAppPath('/app/study/smart/session')}
      >
        スマート復習を始める
      </Link>
    </Button>
  )
}
