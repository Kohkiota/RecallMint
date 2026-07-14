// ローカルの「消えうるキャッシュ」を best-effort で掃除する共有 helper(spec §4.7)。
// 画像外し編集 / card 削除(単票・bulk)の client 3 経路から呼ばれる(rule-of-three)。
// R2/DB の grace(サーバ側 GC)とは独立 — dedup 実在化後も安全(最悪 1 回 re-fetch)。
//
// 失敗は握る: 1 件の assetId で deleteAssetBlob / media_assets.delete が reject しても
// 他の assetId の掃除を止めない(呼び出し側の削除 UX をブロックしない fire-and-forget 前提)。

import { getClientDb } from '@/lib/client-db'
import { deleteAssetBlob } from '@/lib/media/cache'

export async function reclaimLocalAssetBlobs(userId: string, assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return

  const db = getClientDb()

  await Promise.all(
    assetIds.map(async (assetId) => {
      await deleteAssetBlob(userId, assetId).catch(() => {
        // best-effort: Cache blob 削除失敗は握る(disposable cache、 最悪 1 回 re-fetch)。
      })
      await db.media_assets.delete(assetId).catch(() => {
        // best-effort: mirror row 削除失敗も握る(次回同期・再取得で収束)。
      })
    }),
  )
}
