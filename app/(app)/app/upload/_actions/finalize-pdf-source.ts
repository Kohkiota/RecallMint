'use server'

import { z } from 'zod'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'
import { loadPdf, PdfParseError } from '@/lib/media/pdf-rasterize'
import { sourcePdfObjectKey } from '@/lib/media/source-object-key'
import { deleteObject, getObject, headObject } from '@/lib/storage/r2'
import type { ActionResult } from '@/lib/actions/result'
import { MAX_PDF_BYTES } from '../_lib/constants'

// ②-4b T5: PUT 完了通知(design spec §2 / §4 D4 / §6 本線 1)。
//
// 無状態(DB 書込なし・spec §3) — 正常時は pageCount を保持しない。 key は
// `reserve-pdf-upload.ts` と同じく認証済み userId + 検証済み uploadSessionId/
// fileId から `sourcePdfObjectKey` が構築する(入力 schema に key 文字列 field
// なし・Codex I7 所有権 pin)。
//
// uploadSessionId = **R2 namespace の同一性**(spec §3.1)。 submit action の
// 別の同一性キー(論理 submit 試行の同一性・再試行では必ず新規)とは別物 —
// 値を分離している理由は `reserve-pdf-upload.ts` と同じ(r5)。
//
// 単体 pageCount > OCR_MAX_PAGES or 解析不能(PdfParseError)の reject 時は、
// 通知 handler がその場で対象 object を DELETE してから typed error(ActionResult
// の ok:false)を返す(本線 1 — key を知っている唯一の即時点)。 DELETE の成否は
// 応答を変えない(best-effort・`deleteObject` は never-throw + 404=ok 契約)。
//
// HEAD 不在 / contentLength 不一致の reject は本線 1 の対象外(spec §6 表 —
// この段階では正当な自 upload かどうかまだ確認できていないため、削除しない)。

// source GET 専用 timeout(spec D8)。 既定 `GET_TIMEOUT_MS`(10s)は 50MB PDF の
// GET に不足しうるため明示的に長い値を渡す(暫定 — 実測後見直し)。
const SOURCE_GET_TIMEOUT_MS = 60_000

/**
 * getCurrentUser() の「未認証 throw」を null に正規化する(reserve-pdf-upload.ts /
 * asset-actions.ts と同じ既存 idiom)。 非 UnauthenticatedError は再 throw する。
 */
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

const finalizeInputSchema = z.object({
  uploadSessionId: z.uuid({ version: 'v4' }),
  fileId: z.uuid({ version: 'v4' }),
  declaredBytes: z.number().int().positive().max(MAX_PDF_BYTES),
})

export interface FinalizePdfSourceInput {
  uploadSessionId: string
  fileId: string
  declaredBytes: number
}

/**
 * 完了通知: HEAD 実在 + contentLength 一致(presign 署名値との契約 pin・
 * Codex I5)を検証 → GET → `loadPdf` → pageCount(レンダリングなし・spec D4)。
 */
export async function finalizePdfSource(
  input: FinalizePdfSourceInput,
): Promise<ActionResult<{ pageCount: number }>> {
  const user = await currentUserOrNull()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = finalizeInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const { uploadSessionId, fileId, declaredBytes } = parsed.data

  const objectKey = sourcePdfObjectKey(user.id, uploadSessionId, fileId)

  // contentLength === declaredBytes の一致検証(Codex I5)。 declaredBytes は
  // zod で既に `≤ MAX_PDF_BYTES` を満たすため、一致が取れれば contentLength も
  // 上限内であることが transitively 保証される(別途の上限比較は不要)。
  const { exists, contentLength } = await headObject(objectKey)
  if (!exists || contentLength === null || contentLength !== declaredBytes) {
    return { ok: false, error: 'アップロードの検証に失敗しました' }
  }

  const got = await getObject(objectKey, { timeoutMs: SOURCE_GET_TIMEOUT_MS })
  if (!got) {
    return { ok: false, error: 'アップロードの検証に失敗しました' }
  }

  let pageCount: number
  try {
    const handle = await loadPdf(got.bytes)
    pageCount = handle.pageCount
    handle.destroy()
  } catch (e) {
    if (e instanceof PdfParseError) {
      await deleteObject(objectKey)
      return { ok: false, error: 'PDF を解析できませんでした' }
    }
    throw e
  }

  // pageCount ≥ 1 は不変条件(spec D7 r4「正当な PDF は必ず 1 ページ以上」)。
  // この不変条件を確立する責務は pageCount を算出する本 action にある — 下流
  // (submit の層 2 zod)の `pageCount >= 1` は client echo に対する検証でしか
  // ないため、ここで 0 ページを成功として通すと UI が ready 表示し object が
  // 残ったまま失敗が submit まで先送りされる(Codex 独立レビュー Important 1)。
  if (pageCount < 1) {
    await deleteObject(objectKey)
    return { ok: false, error: 'ページを含まない PDF です' }
  }
  if (pageCount > OCR_MAX_PAGES) {
    await deleteObject(objectKey)
    return {
      ok: false,
      error: `ページ数が上限(${OCR_MAX_PAGES})を超えています`,
    }
  }

  return { ok: true, data: { pageCount } }
}
