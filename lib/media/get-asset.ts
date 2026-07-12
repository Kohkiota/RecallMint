// 取得側 media チャネル: getAssetObjectURL (画像フェーズ A Task 9 / spec §6)。
//
// Cache hit → objectURL / miss → resolve (server action, DI) → fetch → Cache put
// → objectURL。 失敗は null (呼出側で placeholder 表示、 spec §6)。
//
// server action (resolveAssetUrls) は Task 4 で `app/(app)/app/exams/[id]/_actions/
// asset-actions.ts` に実装済みだが ESLint Block A が `lib/**` → `app/**` import を
// 禁ずるため、 Task 8 (`lib/media/upload.ts`) と同じ DI 前例に倣い構造型で注入する。
// 呼出側 (client component) が実 action をそのまま渡す。

import type { ActionResult } from '@/lib/actions/result'
import { putAssetBlob, matchAssetBlob } from '@/lib/media/cache'

export type ResolveAssetUrlsFn = (
  assetIds: string[],
) => Promise<
  ActionResult<
    Array<{ assetId: string; url: string; mime: string; width: number; height: number }>
  >
>

// resolve fetch の timeout。 外部 fetch は AbortSignal.timeout 必須の repo 慣習
// (lib/media/upload.ts の PUT_TIMEOUT_MS 等) に倣う。 表示用 GET は upload の PUT より
// 小さい image bytes のみなので余裕を持たせつつ hang を防ぐ 30s とする。
const FETCH_TIMEOUT_MS = 30_000

// objectURL 再利用 Map: `${userId}:${assetId}` → objectURL。 asset は immutable
// (finalize 後は書き換えられない) ゆえ差し替え revoke は不要 — 同一 key は常に同一
// bytes を指すため、 一度 createObjectURL したら tab session 中ずっと使い回してよい。
// 非 evict は意図的 (Task 8 の cardImageOpChains と同方針): tab session 中に表示した
// distinct asset 数ぶんの entry が残るのみで、 実用上 bounded (無限成長しない)。
const objectUrlCache = new Map<string, string>()

function cacheKey(userId: string, assetId: string): string {
  return `${userId}:${assetId}`
}

/**
 * 表示用 objectURL を解決する。
 *
 * 1. objectUrlCache hit → 再利用 (resolve/fetch を再実行しない)。
 * 2. Cache API hit (`matchAssetBlob`) → そこから objectURL 生成。
 * 3. miss → `deps.resolveAssetUrls([assetId])` で presigned GET URL を解決 →
 *    fetch → Cache put → objectURL 生成。
 * 4. いずれの経路でも失敗 (resolve !ok / 空 / fetch !ok / throw) は null
 *    (呼出側で placeholder 表示、 spec §6)。
 */
export async function getAssetObjectURL(
  userId: string,
  assetId: string,
  deps: { resolveAssetUrls: ResolveAssetUrlsFn },
): Promise<string | null> {
  const key = cacheKey(userId, assetId)

  const cached = objectUrlCache.get(key)
  if (cached) return cached

  // 全経路を try で囲い、 どの失敗 (Cache API read 失敗 / resolve !ok・reject /
  // fetch !ok・timeout / put 失敗 / createObjectURL 失敗) でも null に落とす
  // (null-on-failure 契約: 呼出側は placeholder 表示。 throw を漏らさない)。
  try {
    let blob = await matchAssetBlob(userId, assetId)

    if (!blob) {
      const resolved = await deps.resolveAssetUrls([assetId])
      if (!resolved.ok || !resolved.data || resolved.data.length === 0) {
        return null
      }
      const entry = resolved.data[0]
      const res = await fetch(entry.url, {
        // 署名クエリ認証ゆえ cookie 不要。 cross-origin (R2) 明示 + redirect は失敗扱い。
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return null
      blob = await res.blob()
      await putAssetBlob(userId, assetId, blob)
    }

    if (!blob) return null

    const obj = URL.createObjectURL(blob)
    objectUrlCache.set(key, obj)
    return obj
  } catch {
    return null
  }
}
