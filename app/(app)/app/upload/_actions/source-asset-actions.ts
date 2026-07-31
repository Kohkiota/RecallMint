'use server'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { sourceAssets } from '@/lib/db/schema'
import type { User } from '@/lib/db/schema'
import { presignPutUrl, getObject, putObject, deleteObject } from '@/lib/storage/r2'
import type { ActionResult } from '@/lib/actions/result'
import { MAX_ASSET_BYTES } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'
import { IMAGE_MIME_ENUM, MIME_EXT, verifyImageBytes } from '../_lib/source-image-verify'

// ②-4a Task 5 (2026-07-31 改訂): source reserve/finalize — T4(prepareUploadTx)が
// 作った lean reservation 行(status='reserved'、temp key、検証済み5列=NULL)を
// authorize して presigned PUT を発行し(reserve)、client 直PUT後に実バイトから
// mime/hash/寸法を server 検証して最終 immutable key へ promote する(finalize)。
// spec §6.1/§6.2。
//
// reserve は source_assets 行を新規作成しない(T4 が既に作成済)。client 申告の
// mime/byteSize は presigned URL 署名(Content-Type/Content-Length)にのみ使う —
// DB へは一切書かない(§6.1 改訂: client_declared_* 列は作らない)。
//
// finalize は asset-actions.ts の finalizeAsset(reserved→ready CAS)と同型だが、
// 検証元が「client 申告値との比較」でなく「R2 から取得した実バイトからの算出」で
// ある点が異なる(Codex P1: finalize 後に client が temp key へ再 PUT しても、
// 既に server が最終 key へ promote 済のため記録値と実体が乖離しない)。R2
// GET/verify/PUT は外部 I/O ゆえ tenant tx の外で行う(tx が外部 I/O を跨がない
// 方針は finalizeAsset の HEAD 検証と同じ)。

/**
 * getCurrentUser() は「未認証」を UnauthenticatedError の throw で表現し、
 * 「session はあるが DB に user 行がまだ無い」を null 返却で表現する
 * (asset-actions.ts の currentUserOrNull() と同じ二態)。
 */
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// source_assets.id は uuid column。 非 UUID 文字列を素通しすると Postgres cast
// error で 500 化する(asset-actions.ts の assetIdSchema と同じ理由)。
const assetIdSchema = z.uuid()

// ---------------------------------------------------------------------------
// reserve: 既存 reserved 行を authorize し、 temp key への presigned PUT URL を
// 発行する(spec §6.1 改訂: 新規 INSERT は行わない)。
// ---------------------------------------------------------------------------

const reserveInputSchema = z.object({
  assetId: z.uuid(),
  mime: z.enum(IMAGE_MIME_ENUM),
  byteSize: z.number().int().positive().max(MAX_ASSET_BYTES),
})

export interface ReserveSourceInput {
  assetId: string
  mime: string
  byteSize: number
}

export async function reserveSource(
  input: ReserveSourceInput,
): Promise<ActionResult<{ uploadUrl: string }>> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = reserveInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const { assetId, mime, byteSize } = parsed.data

  // owner scope + status='reserved' で authorize する。T4 が作った行以外
  // (存在しない・他 user 所有・既に finalize/GC 済)は 0 行で reject される。
  // client 申告の objectKey は信用しない — DB に記録された temp key を使う。
  const rows = await withTenantTx(user.id, (tx) =>
    tx
      .select({ objectKey: sourceAssets.objectKey })
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.id, assetId),
          eq(sourceAssets.userId, user.id),
          eq(sourceAssets.status, 'reserved'),
        ),
      ),
  )
  const row = rows[0]
  if (!row) {
    return { ok: false, error: 'アセットが見つかりません' }
  }

  // client 申告 mime/byteSize は presigned URL の署名(Content-Type/Content-Length
  // 固定)にのみ使う — DB へは永続化しない(§6.1 改訂)。
  const uploadUrl = await presignPutUrl(row.objectKey, mime, byteSize)

  return { ok: true, data: { uploadUrl } }
}

// ---------------------------------------------------------------------------
// finalize: temp key の実バイトを R2 GET → server 検証(magic-byte/decode/
// byte_size/content_hash/寸法/mime)→ 検証済バイトを最終 immutable key へ
// server PUT → 条件付き UPDATE(reserved→ready CAS)。
// ---------------------------------------------------------------------------

// magic-byte sniff / sharp decode / limitInputPixels / 寸法上限チェックは
// pure/sync ヘルパーとして '../_lib/source-image-verify' へ集約(このファイルは
// 'use server' を持つため非 async export が build error 71011 になる — build-blocker
// fix で切り出し済)。ここでは async な verifyImageBytes を呼ぶだけ。

export async function finalizeSource(assetId: string): Promise<ActionResult> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  if (!assetIdSchema.safeParse(assetId).success) {
    return { ok: false, error: 'アセットが見つかりません' }
  }

  // read tx: owner scope の SELECT が cross-user assetId を 0 行に落とす。
  const rows = await withTenantTx(user.id, (tx) =>
    tx
      .select()
      .from(sourceAssets)
      .where(and(eq(sourceAssets.id, assetId), eq(sourceAssets.userId, user.id))),
  )
  const asset = rows[0]
  if (!asset) {
    return { ok: false, error: 'アセットが見つかりません' }
  }

  if (asset.status === 'ready') {
    // 冪等: 既に finalize 済(HEAD/GET/PUT をやり直さない)。
    return { ok: true }
  }
  if (asset.status !== 'reserved') {
    // 'deleting' は GC 回収確定後 — ready への遷移を許すと回収済み行を復活させる。
    return { ok: false, error: 'アセットが見つかりません' }
  }

  // 外部 I/O(GET/verify/PUT)は tx の外で行う(tx が外部 I/O を跨がない方針)。
  const obj = await getObject(asset.objectKey)
  if (obj === null) {
    return { ok: false, error: 'アップロードの検証に失敗しました' }
  }

  const verified = await verifyImageBytes(obj.bytes)
  if (verified === null) {
    return { ok: false, error: 'アップロードの検証に失敗しました' }
  }

  const contentHash = createHash('sha256').update(obj.bytes).digest('hex')
  const byteSize = obj.bytes.length
  // 検証済 mime によって拡張子(= 最終 key そのもの)が決まる。 並行 finalize が
  // 「同じ temp key から異なる mime を検証した」場合(client が temp key へ別
  // 形式の画像を再アップロードした極端なケース)は最終 key 自体が別れるため、
  // 下記の条件付き PUT は両者とも 'success' になりうる(前提の一致検証は同一
  // key への衝突時のみ効く)。 その場合は CAS が唯一の勝敗判定点になり、 自分の
  // PUT が成功したのに CAS に負ける(= 敗者)ケースが生じうる — その孤児は
  // CAS 直後に明示 delete する(下記。 §6.4 の row 駆動 GC は「行が指す
  // objectKey」しか辿れず、 どの行からも指されない孤児は発見不能なため)。
  const finalObjectKey = `users/${user.id}/src/${assetId}.${MIME_EXT[verified.mime]}`

  // 検証済バイトを最終 immutable key へ server PUT する(client は最終 key の
  // presigned を一切持たない = finalize 後 immutable。Codex P1 対処)。
  //
  // 条件付き PUT(If-None-Match: *・spec §7.4 discipline)で first-writer-wins を
  // 構造化する: reserved 行は GET〜verify〜PUT の間 status='reserved' のままで
  // temp key は client 書換可能なため、 同一 assetId への並行 finalize(2重呼出・
  // または finalize 中の temp 再アップロード)が異なるバイトを検証し同じ最終 key
  // へ書こうとしうる。 無条件 PUT だと後着が先着の実体を上書きし、 「勝者の DB
  // 行(先に CAS した側)の記録値」と「実際に R2 に残るバイト(後から PUT した
  // 側)」が乖離しうる(TOCTOU の一種 — 検出しないと ready 行のメタデータが
  // 自分自身の実体と矛盾する)。
  const putResult = await putObject(finalObjectKey, obj.bytes, verified.mime, {
    ifNoneMatch: true,
  })

  if (putResult === 'error') {
    return { ok: false, error: 'アップロードの検証に失敗しました' }
  }

  if (putResult === 'precondition_failed') {
    // 最終 key に既に別の finalize が書込済み。 実体を取得し、 自分の検証済
    // バイトと hash 照合する。
    const existing = await getObject(finalObjectKey)
    if (existing === null) {
      // 直後に GC 等で消えた等、 実体を確認できない — loud failure(復活させない)。
      return { ok: false, error: 'アップロードの検証に失敗しました' }
    }
    const existingHash = createHash('sha256').update(existing.bytes).digest('hex')
    if (existingHash !== contentHash) {
      // 別バイトの concurrent finalize が先に最終 key を確定させた。 自分の
      // metadata(このバイトの hash/寸法)を書くと物理オブジェクトと矛盾するため、
      // 再 PUT も CAS も行わず loud failure を返す(この呼出自体は最終 key へ
      // 何も書き込んでいない — 412 で拒否されたのみ。 掃除対象が残るとすれば
      // client が再アップロードした temp key 側のみで、 stale temp の回収は
      // 既存の GC 方針(spec §6.4)にそのまま委ねられる)。
      return { ok: false, error: 'アップロードの検証に失敗しました' }
    }
    // hash 一致 = byte-identical(同一内容の並行 finalize)。 再 PUT 不要、その
    // まま CAS へ進む(相手が先に CAS 済みなら下記 CAS が 0 行 → 冪等成功に帰着)。
  }

  // write tx: 条件付き UPDATE(reserved→ready CAS)。TOCTOU 防御 = status='reserved'
  // を WHERE に含める(SELECT〜PUT の間に GC reconciler が reserved→deleting へ
  // promote した場合、 0 行更新に落とし復活させない — finalizeAsset の atomic
  // status guard と同じ設計)。
  //
  // 0 行(CAS 負け)時、 current row の objectKey も併せて取得しておく — tx を
  // 抜けた後、 「自分が実際に書いた(putResult==='success')のに CAS に負けた」
  // ケースの孤児 object 判定に使う(delete 自体は外部 I/O ゆえ tx の外で行う)。
  const { result, currentObjectKey } = await withTenantTx(user.id, async (tx) => {
    const updated = await tx
      .update(sourceAssets)
      .set({
        mime: verified.mime,
        contentHash,
        byteSize,
        width: verified.width,
        height: verified.height,
        objectKey: finalObjectKey,
        readyAt: new Date(),
        status: 'ready',
      })
      .where(
        and(
          eq(sourceAssets.id, assetId),
          eq(sourceAssets.userId, user.id),
          eq(sourceAssets.status, 'reserved'),
        ),
      )
      .returning({ id: sourceAssets.id })

    if (updated.length === 0) {
      // 0 行 = SELECT 後に status が reserved から動いた。並行 finalize が先に
      // ready 化した場合は冪等成功、 GC が deleting へ promote した場合(or 行
      // 消失)は復活させず not-found とする。現状態を owner scope で再取得して判別。
      const currentRows = await tx
        .select({ status: sourceAssets.status, objectKey: sourceAssets.objectKey })
        .from(sourceAssets)
        .where(and(eq(sourceAssets.id, assetId), eq(sourceAssets.userId, user.id)))
      const current = currentRows[0]
      const currentObjectKey = current?.objectKey ?? null
      if (current && current.status === 'ready') {
        return { result: { ok: true } as ActionResult, currentObjectKey }
      }
      return {
        result: { ok: false, error: 'アセットが見つかりません' } as ActionResult,
        currentObjectKey,
      }
    }

    // CAS に勝った(この呼出が finalObjectKey を指す行を確定させた)。
    return { result: { ok: true } as ActionResult, currentObjectKey: finalObjectKey }
  })

  // lost-CAS orphan cleanup: 自分の PUT が実際に書込に成功した
  // (putResult==='success' — 412 で何も書いていない場合は対象外)のに CAS に
  // 負け、かつ現在の行の objectKey が finalObjectKey と一致しない(= どの行から
  // も参照されない)場合、 自分が書いた finalObjectKey は永久に孤児化する —
  // §6.4 の row 駆動 GC は「行が指す objectKey」しか辿れないため発見不能。
  // best-effort・tx 外・never-throw(deleteObject の契約)で明示的に削除する。
  if (putResult === 'success' && currentObjectKey !== finalObjectKey) {
    await deleteObject(finalObjectKey)
  }

  // Important fix(Codex 指摘・2026-07-31): temp key(asset.objectKey・read-tx
  // 時点の値=promote 元)のクリーンアップ。 row が ready に到達した(この呼出が
  // CAS に勝った・または 0 行負けでも re-select が既に ready = 誰かが勝った)
  // なら、 temp key はもう誰にも参照されない — §6.4 の GC lane は row が指す
  // objectKey(既に finalObjectKey に更新済)しか辿れず temp を発見できないため
  // 放置すると永久に残る。 同一 assetId の全 finalize 呼出は同じ temp key を
  // 共有するため、 複数呼出が同時に delete を試みても冪等(deleteObject の
  // 2xx/404=ok 契約)。 best-effort・tx 外・never-throw。 「asset.status===
  // 'ready' で早期 return した」冒頭の分岐はここを通らない(その時点の
  // asset.objectKey は既に finalObjectKey であり temp key ではないため対象外)。
  if (result.ok) {
    await deleteObject(asset.objectKey)
  }

  return result
}
