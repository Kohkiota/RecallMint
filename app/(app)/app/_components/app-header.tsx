'use client'

import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'

// brand 名は hardcode (2026-05-17 SERVICE_NAME placeholder 撤回)、
// RecallMint 固有値で固定。 別サービス流用は devcontainer-template repo で対応。
//
// S-perf-1: nav の主要 Link 全てに `prefetch={false}` を付与。 dynamic page を
// 5+ link 並べると navigation 時に 5+ 並列で full RSC SSR が走るため (詳細は
// `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md`)。
// click 時の navigation 自体は依然動作する (Next.js は prefetch=false でも
// client-side navigation を行う)、 体感差は loading.tsx の即時 fallback で吸収。
//
// S-perf-2 (C-1): nav Link の `onClick={() => void revalidateAppPath(...)}` を全撤去。
// T2.5 計測で「click → navigation RSC fetch + revalidate 後 RSC fetch」 が二重に
// 走る性能バグを確認 (詳細は `docs/superpowers/plans/2026-05-25-s-perf-2.md` §T2.5)。
// Next.js 15 default `staleTimes.dynamic = 0` で dynamic page は navigation 時に
// 必ず fresh fetch されるため、 onClick による明示 revalidate は不要。
export function AppHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link
          href="/app"
          prefetch={false}
          className="text-lg font-bold text-slate-900 hover:text-slate-700"
        >
          RecallMint
        </Link>
        <nav className="flex items-center gap-4">
          {/* Sprint A-2: vocab nav (単語 / 復習) 撤去。 S1a: アップロード追加。
              S1.7: 試験 追加 (read-only viewer)。
              T6 (S2.1): 演習 (/app/quiz) 撤去、スマート復習 (/app/study/smart) 追加。
              T12 (S2.3): カスタム演習 (/app/study/custom) 追加。 */}
          <Link
            href="/app/upload"
            prefetch={false}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            アップロード
          </Link>
          <Link
            href="/app/exams"
            prefetch={false}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            試験
          </Link>
          <Link
            href="/app/study/smart"
            prefetch={false}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            スマート復習
          </Link>
          <Link
            href="/app/study/custom"
            prefetch={false}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            カスタム演習
          </Link>
          {/* Tag-4a: タグ管理 page 追加。 prefetch={false} は他 nav link と統一 (S-perf-1)。 */}
          <Link
            href="/app/tags"
            prefetch={false}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            タグ
          </Link>
          <Link
            href="/app/settings"
            prefetch={false}
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
