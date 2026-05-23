'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

// スマート復習の入口 page。
// I-2: revalidateAppPath で Router Cache を破棄してから session page へ遷移。
export default function SmartStudyEntryPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">スマート復習</h1>
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-slate-700">
            設定した上限枚数まで、FSRS で due になった card を復習します。
          </p>
          <Button asChild size="lg" className="mt-4 w-full py-4 text-lg font-bold rounded-xl">
            <Link
              href="/app/study/smart/session"
              onClick={() => void revalidateAppPath('/app/study/smart/session')}
            >
              スマート復習を始める
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
