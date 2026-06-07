// Tag-4a タグ管理 page (Server Component shell)。
// 認証 / DB SELECT は不要 — IDB (Dexie) 経由で client-side に読み出すため、
// この shell は静的 metadata + <TagManagerShell /> 描画のみで完結する。
// (app)/app/layout.tsx で getCurrentUser ガードが既に通っている前提。

import { TagManagerShell } from './_components/tag-manager-shell'

export const metadata = {
  title: 'タグ管理 — RecallMint',
}

export default function TagsPage() {
  return (
    <div className="space-y-6 md:space-y-3">
      <TagManagerShell />
    </div>
  )
}
