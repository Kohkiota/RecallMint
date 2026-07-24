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

// in-flight 解決の共有 Map: `${userId}:${assetId}` → 進行中の Promise。 objectUrlCache は
// 「完了した」 objectURL のみを保持するため、 同一 key への並行 call が completed cache に
// 入る前に各自 resolve→fetch を走らせ presigned 発行 + download を重複させる (Task 4 の
// openModal が thumbnail 解決中の兄弟を一括解決するため実際に発生する)。 完了前の並行 call を
// 1 本の解決に合流させる。 settle 時に delete するため成功 objectURL のみが cache に残り、
// 失敗は cache されない (= 次回 call が再試行する既存契約を維持)。
const inFlight = new Map<string, Promise<string | null>>()

function cacheKey(userId: string, assetId: string): string {
  return `${userId}:${assetId}`
}

// 解決本体 (Cache API → resolve → fetch → put → objectURL)。 getAssetObjectURL から in-flight
// 合流のため切り出す。 null-on-failure 契約: どの失敗でも null に落とし throw を漏らさない。
// 成功時のみ objectUrlCache に set する (失敗は cache しない)。
async function resolveObjectURL(
  userId: string,
  assetId: string,
  key: string,
  deps: { resolveAssetUrls: ResolveAssetUrlsFn },
): Promise<string | null> {
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

  // 進行中の同一 key 解決があれば合流 (重複 presigned 発行 + download を防ぐ)。
  const existing = inFlight.get(key)
  if (existing) return existing

  // 解決本体を 1 本の Promise に包んで inFlight に登録し、 settle 時に必ず解放する。
  // 成功は resolveObjectURL 内で objectUrlCache に入るため以後は cache hit、 失敗は
  // cache されないため inFlight 解放で次回 call が再試行できる (既存契約を維持)。
  const pending = resolveObjectURL(userId, assetId, key, deps).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, pending)
  return pending
}

/**
 * 同期 peek: 既に解決済み(objectUrlCache 済)の objectURL のみを返す。resolve/fetch を
 * 一切行わない(未解決・in-flight・失敗は null)。
 *
 * 用途: モーダルが tap 対象 target の兄弟画像を集める際、spec §3.6 の「解決済み画像のみ
 * (未解決/失敗は除外)」を満たしつつ、未解決兄弟の presigned 発行 + download で開扉を
 * ブロックしない(getAssetObjectURL は miss 時に network 解決へ進み最大 FETCH_TIMEOUT_MS
 * ブロックし得る)。返す objectURL の所有権は resolver 側 — 呼出側で revoke してはならない。
 */
export function peekAssetObjectURL(userId: string, assetId: string): string | null {
  return objectUrlCache.get(cacheKey(userId, assetId)) ?? null
}
