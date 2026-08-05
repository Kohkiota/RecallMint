// ②-4a Task 8b: prepared payload 組立 + prepared_hash 算出(純関数)。
//
// directive 無し共有 module(stage-prepared-retry.ts と同じ理由 — 'use server'
// file である OCR phase の呼出元から参照されつつ、 単体 test しやすいよう独立
// させる)。
//
// normalizePrepared(lib/ocr/normalize-prepared.ts・T8a)の出力を V1 payload の
// 形へ 1 回だけ組み立て、 `preparedPayloadSchema.parse()`(lib/ocr/prepared-schema.ts)
// で検証する。 spec §5.4「実装条件」: parsed 結果でなく元 candidate を後続処理で
// 使わない — ここで assemble した candidate はこの関数の外に出ず、 呼出元は
// `parse()` の戻り値(= このファイルの返り値)だけを見る。
//
// normalize の出力は T8a の契約 test(「normalize が生成する全 card は
// preparedCardSchema を通る」)により常に本 parse を通る前提 — 失敗はここでは
// 想定内の分岐にせず、 呼出元が「loud internal error」として
// 扱う(バグとして throw をそのまま伝播させる。 brief: 「a parse failure here is
// a loud internal error ... treat a failure as a bug, not a user error」)。
import { createHash } from 'node:crypto'
import { preparedPayloadSchema, type PreparedPayload } from '@/lib/ocr/prepared-schema'
import type { NormalizePreparedResult } from '@/lib/ocr/normalize-prepared'

/**
 * normalizePrepared の出力を V1 prepared payload へ組み立て、
 * `preparedPayloadSchema.parse()` で検証した結果を返す。 失敗時は zod の
 * ZodError をそのまま throw する(呼出元が「バグ」として扱う契約)。
 */
export function assemblePreparedPayload(
  normalized: NormalizePreparedResult,
): PreparedPayload {
  return preparedPayloadSchema.parse({
    schemaVersion: 1,
    cards: normalized.cards,
    cardsTotal: normalized.cardsTotal,
    cardsExcluded: normalized.cardsExcluded,
    figuresExcluded: normalized.figuresExcluded,
  })
}

/**
 * 保存済み payload の破損・drift 検知用ハッシュ(spec §2「prepared_hash は残す」)。
 * 本 module 内で常に `assemblePreparedPayload` → `preparedPayloadSchema.parse()`
 * を経由した同一形の値のみを hash 対象とするため(呼出元は他の値を渡さない
 * 契約)、 canonical/stable-stringify library は導入せず `JSON.stringify` の
 * key 挿入順(zod がスキーマ定義順で組み立てる・毎回同一)で十分安定する。
 */
export function computePreparedHash(payload: PreparedPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}
