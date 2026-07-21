'use server'

import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { assets } from '@/lib/db/schema'
import type { User } from '@/lib/db/schema'
import { presignPutUrl, presignGetUrl, headObject } from '@/lib/storage/r2'
import type { ActionResult } from '@/lib/actions/result'
import { isFinalized, canFinalize, type AssetStatus } from '@/lib/media/domain/asset-state'

// 画像アップロード saga の server 側 3 action (画像フェーズ A design spec §3.1/§6)。
//
// reserveAsset → (client 直 PUT) → finalizeAsset で 1 asset の reserved→ready
// 遷移を作り、 resolveAssetUrls は表示時に ready asset の presigned GET URL を
// 解決する (取得側チャネル)。 いずれも auth() 必須 + owner scope (WHERE user_id)。
//
// dedup 再利用 branch は spec §3.5 により後続 sprint (hash は記録のみ、本 task では
// 参照しない)。

// 5 MiB hard cap (圧縮バイパスした不正 client への上限。spec §3.1/§4)。
const MAX_ASSET_BYTES = 5 * 1024 * 1024

// resolve 1 回あたりの assetId 上限 (spec §6)。
const MAX_RESOLVE_IDS = 50

// assets.id は uuid column。 非 UUID 文字列を素通しすると Postgres cast error で
// 500 化する (finding 2)。 legacy 非 UUID OCR key (spec §2.2) を安全に弾くための
// 事前 zod 検証。
const assetIdSchema = z.uuid()

// width/height の上限。 assets.width/height は Postgres integer (max 2^31-1) ゆえ、
// untrusted な直接呼び出しが巨大値を送ると INSERT が integer-out-of-range で throw し
// 500 に化ける。 実画像は圧縮後で高々数千 px ゆえ 100,000 で domain 上限 + DB range
// 防衛を兼ねる。 hash は SHA-256 hex (64 字) なので 128 で余裕を持って上限 (finding 4)。
const MAX_IMAGE_DIMENSION = 100_000
const MAX_HASH_LEN = 128

/**
 * getCurrentUser() は「未認証」を UnauthenticatedError の throw で表現する
 * (session なし)。 一方 null 返却は「session はあるが DB に user 行がまだ無い」
 * (webhook sync race) を表す。 ActionResult 契約 (reject でなく { ok:false }) を
 * 守るため未認証だけを null に正規化する — 他の error (DB 障害等) は握り潰さず
 * 再 throw する (finding 1)。
 */
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

const reserveInputSchema = z.object({
  // webp/png = 圧縮出力。 jpeg = fallback(圧縮/検証失敗時の元画像 direct PUT・iOS/WebKit
  // 修正 T5)で受ける。 client の fallback 適格 type(lib/media/upload.ts の jpeg/png)と
  // この enum は連動させること(片方だけ変えると jpeg fallback が RESERVE_FAILED に落ちる)。
  mime: z.enum(['image/webp', 'image/png', 'image/jpeg']),
  byteSize: z.number().int().positive().max(MAX_ASSET_BYTES),
  width: z.number().int().positive().max(MAX_IMAGE_DIMENSION),
  height: z.number().int().positive().max(MAX_IMAGE_DIMENSION),
  hash: z.string().min(1).max(MAX_HASH_LEN),
})

export interface ReserveAssetInput {
  mime: string
  byteSize: number
  width: number
  height: number
  hash: string
}

/**
 * ① reserve: asset 行を 'reserved' status で INSERT し、 直 PUT 用の presigned
 * URL を発行する。 offline / 検証失敗時は何も書かない (spec §3.1: 明示エラーで終了)。
 *
 * 入力型は呼出側契約 (Task 4 brief) 通り `mime: string` (zod safeParse が
 * 'image/webp' | 'image/png' への絞り込みと実行時検証を担う — 呼出側に union 型を
 * 強制しない)。
 */
export async function reserveAsset(
  input: ReserveAssetInput,
): Promise<ActionResult<{ assetId: string; uploadUrl: string }>> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = reserveInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const { mime, byteSize, width, height, hash } = parsed.data

  const assetId = crypto.randomUUID()
  const ext =
    mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png'
  const objectKey = `users/${user.id}/${assetId}.${ext}`

  const db = getDb()
  // reference_count / unreferenced_at は書かない (spec §2.1: 将来 orphan 掃除用の
  // dormant 枠、 DB default に任せる)。RLS-P3 Wave2: tenant context 下で INSERT。
  await withTenantTx(db, user.id, (tx) =>
    tx.insert(assets).values({
      id: assetId,
      userId: user.id,
      objectKey,
      mime,
      byteSize,
      width,
      height,
      hash,
      status: 'reserved',
    }),
  )

  // byteSize を presign の署名に焼き込む (Content-Length 固定) — 巨大 body PUT による
  // 5 MiB cap 迂回 (storage abuse) を R2 側で構造的に拒否させる。
  const uploadUrl = await presignPutUrl(objectKey, mime, byteSize)

  return { ok: true, data: { assetId, uploadUrl } }
}

/**
 * ④ finalize: owner 確認 → R2 HEAD で実在 + byte_size 一致を検証 → 'ready' 化。
 * 冪等 (既に 'ready' なら HEAD を叩かず ok:true)。 owner scope の SELECT が
 * cross-user assetId を 0 行に落とすため、 他 user の asset は自動的に reject される。
 */
export async function finalizeAsset(assetId: string): Promise<ActionResult> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  if (!assetIdSchema.safeParse(assetId).success) {
    // 不正形式の id は定義上 DB に存在し得ない (spec §2.2 UUID/non-UUID 判別)。
    return { ok: false, error: 'アセットが見つかりません' }
  }

  const db = getDb()
  // RLS-P3 Wave2: read/write を 2 tenant tx に分割する。R2 headObject を tx 内に入れない
  // ため(tx が外部 I/O を跨がない)。TOCTOU 防御は write の status='reserved' WHERE が担う。
  const rows = await withTenantTx(db, user.id, (tx) =>
    tx
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, user.id))),
  )

  const asset = rows[0]
  if (!asset) {
    return { ok: false, error: 'アセットが見つかりません' }
  }

  // assets.status は CHECK なし text 列 (G2 domain の前提通り) なので DB 型は
  // string。 遷移判定を domain 関数へ委譲するための cast — 値自体は本 action と
  // reserve/GC のみが書くため AssetStatus union に収まる。
  const status = asset.status as AssetStatus

  if (isFinalized(status)) {
    return { ok: true }
  }

  // deleting/deleted は GC 回収確定後 (spec §4.9) — ready への遷移を許すと
  // 回収済み asset を復活させてしまうため、 HEAD 検証の前に拒否する。
  if (!canFinalize(status)) {
    return { ok: false, error: 'アセットが見つかりません' }
  }

  const { exists, contentLength } = await headObject(asset.objectKey)
  // null は「検証不能」= 明示的な失敗として扱う (緩和しない。spec §3.1)。
  if (!exists || contentLength === null || contentLength !== asset.byteSize) {
    return { ok: false, error: 'アップロードの検証に失敗しました' }
  }

  // status='reserved' を WHERE に含め atomic に遷移させる (TOCTOU 防御)。 SELECT と
  // この UPDATE の間に GC reconciler が reserved→deleting へ promote すると、 id+userId
  // だけの WHERE では回収対象 asset を ready に復活させてしまう。 status='reserved' 条件で
  // 0 行更新に落とし、 その場合は成功を返さず not-found として扱う (read-time canFinalize
  // ガードは fast path として維持)。
  // RLS-P3 Wave2: UPDATE(+0 行時の状態判別 re-SELECT)を 1 write tx に束ねる。
  return withTenantTx(db, user.id, async (tx) => {
    const updated = await tx
      .update(assets)
      .set({ status: 'ready', readyAt: new Date() })
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.userId, user.id),
          eq(assets.status, 'reserved'),
        ),
      )
      .returning({ id: assets.id })

    if (updated.length === 0) {
      // 0 行 = SELECT 後に status が reserved から動いた。 並行 finalize が先に ready 化
      // した場合は冪等成功 (呼び出し側が望んだ end-state)、 GC が deleting/deleted へ
      // promote した場合 (or 行消失) は復活させず not-found とする。 現状態を owner scope で
      // 再取得して判別する。
      const currentRows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.userId, user.id)))
      const current = currentRows[0]
      if (current && isFinalized(current.status as AssetStatus)) {
        return { ok: true }
      }
      return { ok: false, error: 'アセットが見つかりません' }
    }

    return { ok: true }
  })
}

/**
 * media チャネル resolve: ready かつ自 user 所有の asset のみ presigned GET URL を
 * 解決して返す (spec §6)。 存在しない / non-ready / cross-user の id は結果配列から
 * 単純に省かれる (client が不在扱いで処理する契約)。
 */
export async function resolveAssetUrls(
  assetIds: string[],
): Promise<
  ActionResult<Array<{ assetId: string; url: string; mime: string; width: number; height: number }>>
> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  // server action 引数は runtime で untrusted (直接 POST / 壊れた client state で
  // 非配列が来うる)。 .length / .filter を叩く前に配列であることを zod で保証し、
  // 非配列を 500 でなく ActionResult に落とす (finding 3)。
  const parsed = z.array(z.string()).safeParse(assetIds)
  if (!parsed.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const ids = parsed.data

  if (ids.length > MAX_RESOLVE_IDS) {
    return { ok: false, error: '一度に解決できるアセット数の上限を超えています' }
  }
  if (ids.length === 0) {
    return { ok: true, data: [] }
  }

  // 非 UUID id (legacy OCR key 等、 spec §2.2) は DB に存在し得ないため事前に
  // 除外する。 「missing ids omitted」契約に沿い、 エラーにせず黙って結果から
  // 省く (finding 2)。
  const validIds = ids.filter((id) => assetIdSchema.safeParse(id).success)
  if (validIds.length === 0) {
    return { ok: true, data: [] }
  }

  const db = getDb()
  // eq(status, 'ready') の gate が deleting/deleted (GC 回収中/済) の asset を
  // 既に排除する (allowsNewReference と同じ意味論。spec §3-4)。RLS-P3 Wave2: tenant context 下。
  const rows = await withTenantTx(db, user.id, (tx) =>
    tx
      .select()
      .from(assets)
      .where(
        and(
          inArray(assets.id, validIds),
          eq(assets.userId, user.id),
          eq(assets.status, 'ready'),
        ),
      ),
  )

  const data = await Promise.all(
    rows.map(async (row) => ({
      assetId: row.id,
      url: await presignGetUrl(row.objectKey),
      mime: row.mime,
      width: row.width,
      height: row.height,
    })),
  )

  return { ok: true, data }
}
