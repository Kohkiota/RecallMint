'use server'

import { z } from 'zod'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import { sourcePdfObjectKey } from '@/lib/media/source-object-key'
import { presignPutUrl } from '@/lib/storage/r2'
import type { ActionResult } from '@/lib/actions/result'
import { MAX_PDF_BYTES, MAX_PDF_TOTAL_BYTES } from '../_lib/constants'

// ②-4b T5: PDF 入稿の presign 発行(design spec §2 / §3 / D7)。
//
// DB 無し(spec §3 分岐 (a) — reserve レコードを作らない台帳なし設計)。 PUT 時点の
// 対応付けは object key 規約(`src/{userId}/{idempotencyKey}/{fileId}.pdf`)だけで
// 表現する。 key は必ず認証済み userId + server 検証済みの idempotencyKey/fileId
// から `sourcePdfObjectKey` が構築する — 入力 schema(`ReservePdfUploadInput`)に
// key 文字列を受け取る field は存在しない(Codex I7・所有権 pin。unit test で
// 「紛れ込ませた key 系 field が無視される」ことを実証する)。
//
// 件数上限は `OCR_MAX_PAGES`(合計ページ数の唯一の上限・spec D3/D7)を再利用する。
// PDF 1 冊 ≥ 1 ページゆえ、file 数がこれを超えた時点で合計ページも必ず超過が
// 確定する(冊数そのものの商品上限ではなく、後段判定の早期棄却としての入力検証)。

/**
 * getCurrentUser() の「未認証 throw」を null に正規化する(asset-actions.ts /
 * submit-upload.ts と同じ既存 idiom)。 非 UnauthenticatedError は再 throw する。
 */
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

const reserveFileSchema = z.object({
  fileId: z.uuid({ version: 'v4' }),
  declaredBytes: z.number().int().positive().max(MAX_PDF_BYTES),
})

const reserveInputSchema = z.object({
  idempotencyKey: z.uuid({ version: 'v4' }),
  files: z.array(reserveFileSchema).min(1).max(OCR_MAX_PAGES),
})

export interface ReservePdfUploadInput {
  idempotencyKey: string
  files: Array<{ fileId: string; declaredBytes: number }>
}

/**
 * reserve: PDF 1 冊ごとに presigned PUT URL を発行する(spec §2 flow の
 * `reservePdfUploadUrls`)。 DB 書込なし。
 */
export async function reservePdfUploadUrls(
  input: ReservePdfUploadInput,
): Promise<ActionResult<Array<{ fileId: string; uploadUrl: string }>>> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = reserveInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const { idempotencyKey, files } = parsed.data

  const fileIds = files.map((f) => f.fileId)
  if (new Set(fileIds).size !== fileIds.length) {
    return { ok: false, error: '同じファイルが重複しています' }
  }

  const totalBytes = files.reduce((sum, f) => sum + f.declaredBytes, 0)
  if (totalBytes > MAX_PDF_TOTAL_BYTES) {
    return { ok: false, error: '合計サイズが上限を超えています' }
  }

  const data = await Promise.all(
    files.map(async (f) => ({
      fileId: f.fileId,
      uploadUrl: await presignPutUrl(
        sourcePdfObjectKey(user.id, idempotencyKey, f.fileId),
        'application/pdf',
        f.declaredBytes,
      ),
    })),
  )

  return { ok: true, data }
}
