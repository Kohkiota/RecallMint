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

// cacheKey の逆写像 (hygiene sprint Task 4 / spec §4.1)。 purge / sweep は Cache に
// 残る key から owner を判定する必要があるため、 key 形式の正本である cacheKey の
// 隣に置く (片方だけ変わる drift を防ぐ)。
// 厳密規則: pathname が `/__media/<userId>/<assetId>` の 3 segment、 query なし。
// 判定できない key (malformed / 規則外) は null を返し、 呼出側は「保護対象と識別
// できない = 削除」 に倒す (fail-safe の向きは対象の性質で決める — spec §4.1: Cache の
// blob は再取得可能ゆえ削除側)。
// Cache.keys() が返す Request.url は常に絶対 URL のため base なしで parse する。
export function parseMediaCacheKey(
  url: string,
): { userId: string; assetId: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.search !== '') return null
  // pathname は '/' 始まりゆえ split の先頭は空文字。 厳密 3 segment のみ受理する。
  const segments = parsed.pathname.split('/')
  if (segments.length !== 4) return null
  const [, prefix, userId, assetId] = segments
  if (prefix !== '__media' || userId === '' || assetId === '') return null
  return { userId, assetId }
}

/**
 * Cache 内の全 key を Request として列挙する (hygiene の掃除対象の列挙経路)。
 * cache が無い環境 / 未作成なら `[]` — **`caches.open` を呼ばない**ことで、
 * 未訪問 visitor に空 cache を新規作成しない (Dexie 側 `Dexie.exists` guard と同趣旨)。
 */
export async function listMediaCacheRequests(): Promise<readonly Request[]> {
  if (typeof caches === 'undefined') return []
  if (!(await caches.has(CACHE_NAME))) return []
  const cache = await caches.open(CACHE_NAME)
  return await cache.keys()
}

/** listMediaCacheRequests で列挙した Request を削除する (key 文字列を再構成しない)。 */
export async function deleteMediaCacheRequest(req: Request): Promise<void> {
  const cache = await caches.open(CACHE_NAME)
  await cache.delete(req)
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

// 存在確認専用 (blob 本体は読まない)。 deck-download の success gate (spec §4.2) が
// 大量 key を検証する用途向け — matchAssetBlob は res.blob() まで読むため、 存在確認だけ
// で済む呼出には不要な body 読取コストが乗る。
export async function hasAssetBlob(
  userId: string,
  assetId: string,
): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME)
  const res = await cache.match(cacheKey(userId, assetId))
  return res !== undefined
}

export async function deleteAssetBlob(
  userId: string,
  assetId: string,
): Promise<void> {
  const cache = await caches.open(CACHE_NAME)
  await cache.delete(cacheKey(userId, assetId))
}
