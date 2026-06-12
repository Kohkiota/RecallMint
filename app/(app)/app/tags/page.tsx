// Tag-4a タグ管理 page (Server Component shell)。
// 認証 / DB SELECT 自体は (app)/app/layout.tsx で getCurrentUser ガード済。
// 本 page では sessionClaims 経由で dbUserId を取り出し、 fallback で getCurrentUser に
// 落ちる exams/[id]/page.tsx と同 pattern (C2 JWT 経由 dbUserId)。 取り出した userId は
// <TagManagerShell userId> 経由で create form まで thread し、 `runOptimisticCreate`
// (sync-fix-1 T2b) の fail-fast (userId='' で throw) を構造的に満たす。
// tag_categories / tag_options の SELECT 自体は client mirror (Dexie) を見る useLiveQuery
// が担うため、 本 page では DB SELECT を行わない。

import { getAuthContext, getCurrentUser } from '@/lib/auth/ensure-user'

import { TagManagerShell } from './_components/tag-manager-shell'

export const metadata = {
  title: 'タグ管理 — RecallMint',
}

export default async function TagsPage() {
  const ctx = await getAuthContext()
  let userId: string | undefined = ctx.dbUserId
  if (userId === undefined) {
    const user = await getCurrentUser()
    if (!user) return null
    userId = user.id
  }

  return (
    <div className="space-y-6 md:space-y-3">
      <TagManagerShell userId={userId} />
    </div>
  )
}
