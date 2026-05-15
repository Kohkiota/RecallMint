'use client'

// BFCache（Back/Forward Cache）復元時の zombie state を防ぐ。
// ブラウザの back/forward で BFCache から復元されると pageshow イベントが
// event.persisted=true で発火する。この時点では middleware/layout の
// server-side チェックが走らないため、削除済み user が /app/* を
// 閲覧し続ける zombie state になりうる。
// → window.location.reload() で強制 server reload し、middleware/layout の
// zombie net（deletedAt チェック → /sign-out-deleted redirect）を trigger する。

import { useEffect } from 'react'

/**
 * pageshow event.persisted=true を検知して window.location.reload() を呼ぶ
 * listener を登録する pure function。
 * BFCacheGuard component の thin wrapper から useEffect 経由で呼ばれるが、
 * setup function として export することで JSX 不要の unit test が可能になる。
 *
 * @param target - addEventListener の対象 (default: window)。テストでは mock Window を渡せる。
 * @returns cleanup function（removeEventListener）
 */
export function setupBFCacheReload(target: Window = window): () => void {
  const handler = (event: PageTransitionEvent) => {
    if (event.persisted) {
      target.location.reload()
    }
  }

  target.addEventListener('pageshow', handler)

  return () => target.removeEventListener('pageshow', handler)
}

/**
 * BFCache 復元時に強制 reload をかける thin wrapper component。
 * /app/(.*) protected route の layout に配置することで、
 * back/forward ナビゲーション後も認証・削除状態の再チェックを保証する。
 * DOM 出力なし（render null）。
 */
export function BFCacheGuard() {
  useEffect(() => setupBFCacheReload(), [])
  return null
}
