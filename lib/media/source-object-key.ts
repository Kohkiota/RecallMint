// ②-4b PDF 一時保存(R2 `src/` prefix)の object key builder。
// spec: docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md §3
//
// key = `src/{userId}/{idempotencyKey}/{fileId}.pdf`。3 セグメントとも server
// 側で導出する — client は key 文字列を送らず、userId(認証 session)/
// idempotencyKey(batch 発行)/ fileId(client 発行)のみを渡す。3 引数とも
// uuid v4 形状を検証してから埋め込む(path injection 遮断 — 検証を経ない
// 文字列が object key の path segment に混入することを構造的に禁止する)。
//
// 判定域は既存慣習と同一 = `z.uuid({ version: 'v4' })`(`lib/validation/card.ts`
// `isAssetKey` / `lib/ocr/prepared-schema.ts` `uuidV4Schema` と同じ判定)。
//
// エラーメッセージに受領値そのものを含めない — 不正な入力値(injection payload
// を含みうる)を log/エラーメッセージ経由で残さないため。

import { z } from 'zod'

const uuidV4Schema = z.uuid({ version: 'v4' })

function assertUuidV4(value: string, argName: string): void {
  if (!uuidV4Schema.safeParse(value).success) {
    throw new Error(`sourcePdfObjectKey: ${argName} must be a v4 uuid`)
  }
}

/**
 * PDF 一時保存の R2 object key を構築する(spec §3)。
 * 3 引数とも uuid v4 形状でなければ throw する(path injection 遮断)。
 */
export function sourcePdfObjectKey(
  userId: string,
  idempotencyKey: string,
  fileId: string,
): string {
  assertUuidV4(userId, 'userId')
  assertUuidV4(idempotencyKey, 'idempotencyKey')
  assertUuidV4(fileId, 'fileId')
  return `src/${userId}/${idempotencyKey}/${fileId}.pdf`
}
