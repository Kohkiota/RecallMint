'use server'

import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { logger } from '@/lib/logger'
import { sourcePdfObjectKey } from '@/lib/media/source-object-key'
import { deleteObject } from '@/lib/storage/r2'
import type { ActionResult } from '@/lib/actions/result'

// ②-4b §1(design spec 2026-08-09 §3): entry 削除に同期した staging PDF の
// best-effort DELETE。`finalize-pdf-source.ts` と同じ骨格(currentUserOrNull
// idiom / zod v4 uuid ×2 / key は server 導出のみ)。呼出元(upload-form.tsx の
// removeEntry / continuation checkpoint)は戻り値を表示しない fire-and-forget
// (design spec §3)。

/**
 * getCurrentUser() の「未認証 throw」を null に正規化する(finalize-pdf-source.ts
 * と同じ既存 idiom)。 非 UnauthenticatedError は再 throw する。
 */
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

const deleteInputSchema = z.object({
  uploadSessionId: z.uuid({ version: 'v4' }),
  fileId: z.uuid({ version: 'v4' }),
})

export interface DeletePdfSourceInput {
  uploadSessionId: string
  fileId: string
}

export async function deletePdfSource(
  input: DeletePdfSourceInput,
): Promise<ActionResult<void>> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = deleteInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const { uploadSessionId, fileId } = parsed.data

  const objectKey = sourcePdfObjectKey(user.id, uploadSessionId, fileId)

  // deleteObject は never-throw + 404=成功系(冪等)契約(r2.ts) — `!result.ok`
  // だけが記帳対象。その `recordIntegrationFailure` の throw(notifyOps の
  // production fail-fast)は `deleteSourceKeys`(upload-pipeline.ts)と同じ idiom
  // で飲む(action は throw しない契約)。
  const result = await deleteObject(objectKey)
  if (!result.ok) {
    try {
      await recordIntegrationFailure({
        key: 'r2_staging_delete',
        userId: user.id,
        subject: 'staging source PDF delete failed',
        context: { objectKey, status: result.status },
      })
    } catch (err) {
      logger.error({ event: 'upload.staging.source_delete_record_failed', err })
    }
    return { ok: false, error: '削除に失敗しました' }
  }

  return { ok: true }
}
