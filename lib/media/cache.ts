// Cache API blob helper (画像フェーズ A Task 6 / spec §2.4)。
// window context で `caches.open` を使う最小 wrapper (SW 不要 — fact-finding 確認済)。
// blob 本体は Cache に置き、 Dexie `media_assets` は状態 (status/mime/hash 等) のみ
// 持つ設計 (spec §3.1 楽観層)。

const CACHE_NAME = 'recallmint-media'

// userId 名前空間で分離 (spec §2.4 / 前提 5)。 Cache は origin ごとに分かれるので path
// 相対 key で十分 (origin は暗黙)。 実 fetch には使わない合成 key。
function cacheKey(userId: string, assetId: string): string {
  return `/__media/${userId}/${assetId}`
}

export async function putAssetBlob(
  userId: string,
  assetId: string,
  blob: Blob,
): Promise<void> {
  const cache = await caches.open(CACHE_NAME)
  await cache.put(cacheKey(userId, assetId), new Response(blob))
}

export async function matchAssetBlob(
  userId: string,
  assetId: string,
): Promise<Blob | undefined> {
  const cache = await caches.open(CACHE_NAME)
  const res = await cache.match(cacheKey(userId, assetId))
  return res ? await res.blob() : undefined
}

export async function deleteAssetBlob(
  userId: string,
  assetId: string,
): Promise<void> {
  const cache = await caches.open(CACHE_NAME)
  await cache.delete(cacheKey(userId, assetId))
}
