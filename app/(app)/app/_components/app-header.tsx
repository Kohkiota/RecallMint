'use client'

import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'
import { revalidateAppPath } from '@/app/(app)/app/_actions/revalidate'

// brand 名は hardcode (2026-05-17 SERVICE_NAME placeholder 撤回)、
// RecallMint 固有値で固定。 別サービス流用は devcontainer-template repo で対応。
export function AppHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link
          href="/app"
          onClick={() => void revalidateAppPath('/app')}
          className="text-lg font-bold text-slate-900 hover:text-slate-700"
        >
          RecallMint
        </Link>
        <nav className="flex items-center gap-4">
          {/* Sprint A-2: vocab nav (単語 / 復習) 撤去。 S1a: アップロード追加。
              S1.7: 試験 追加 (read-only viewer)。
              T6 (S2.1): 演習 (/app/quiz) 撤去、スマート復習 (/app/study/smart) 追加。
              カスタム演習導線は S2.3 で追加予定。 */}
          <Link
            href="/app/upload"
            onClick={() => void revalidateAppPath('/app/upload')}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            アップロード
          </Link>
          <Link
            href="/app/exams"
            onClick={() => void revalidateAppPath('/app/exams')}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            試験
          </Link>
          <Link
            href="/app/study/smart"
            onClick={() => void revalidateAppPath('/app/study/smart')}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            スマート復習
          </Link>
          <Link
            href="/app/settings"
            onClick={() => void revalidateAppPath('/app/settings')}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            設定
          </Link>
          <UserButton />
        </nav>
      </div>
    </header>
  )
}
