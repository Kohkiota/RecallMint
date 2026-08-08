// ②-4b PDF 一時保存(R2 `src/` prefix)の object key builder。
// spec: docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md §3/§3.1/§3.2
//
// key = `src/{userId}/{uploadSessionId}/{fileId}.pdf`。3 セグメントとも server
// 側で導出する — client は key 文字列を送らず、userId(認証 session)/
// uploadSessionId(client 発行)/ fileId(client 発行)のみを渡す。3 引数とも
// uuid v4 形状を検証してから埋め込む(path injection 遮断 — 検証を経ない
// 文字列が object key の path segment に混入することを構造的に禁止する)。
//
// uploadSessionId は **R2 namespace の同一性**(PUT 済み object 群を指す・再試行
// でも維持したい)を表す(spec §3.1)。 submit action(`submit-upload.ts`)が持つ
// 別の同一性キー(**論理 submit 試行**の同一性・再試行では必ず新規)とは別物 —
// 両者は要求が逆向きで両立しないため、r5 で値を分離した(旧: 1 つの値で 2 つの
// 別物を表していた)。
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
  uploadSessionId: string,
  fileId: string,
): string {
  assertUuidV4(userId, 'userId')
  assertUuidV4(uploadSessionId, 'uploadSessionId')
  assertUuidV4(fileId, 'fileId')
  return `src/${userId}/${uploadSessionId}/${fileId}.pdf`
}
