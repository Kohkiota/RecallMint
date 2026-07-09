// card-rules — inline 編集 (試験詳細 page) の書込ドメインルールを集約する純粋 domain module。
// F3-R1 (additive): card-write.ts から nullable text 正規化 / correct_answer_ids 派生の
// 純関数を所在整理で本モジュールへ移送する (二重定義は R2 で解消・現状は旧定義残置)。
//
// PURE 制約 (P1 lib/cards 前例): Dexie / React / 'use client' を持ち込まない。
// 入力のみに依存し副作用を持たない。 zod / drizzle / next も import しない
// (許可は `import type` のみ)。

import type { CardOption } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// 1. nullable text 列の空文字→null 正規化 (from inline-text-field)
// ---------------------------------------------------------------------------

// server (lib/cards/card-field-handlers.ts の CARD_FIELD_HANDLERS[field] handler、
// sort_key / explanation_text / memo は handler 内で `r.data === '' ? null : r.data`
// 正規化) が空文字を null に揃える nullable text 列。 mirror も同じ正規化をかけ、
// 楽観値を server 確定値に一致させる (一致させないと次の pull-back で '' → null へ
// 見た目が反転する)。 server zod は trim しないのでここも strict な === '' で揃える。
export const NULLABLE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'sort_key',
  'explanation_text',
  'memo',
])

/**
 * nullable text 列は空文字を null に正規化する (それ以外の列 / 非空値は素通し)。
 * mirror 楽観値と server 確定値を一致させるためのドメイン規則。
 */
export function normalizeNullableTextField(
  field: string,
  value: string | null,
): string | null {
  return NULLABLE_TEXT_FIELDS.has(field) && value === '' ? null : value
}

// ---------------------------------------------------------------------------
// 2. correct_answer_ids の derive (from use-card-options)
// ---------------------------------------------------------------------------

/**
 * options の is_correct フラグから correct_answer_ids を導出する (順序保存)。
 * mirror の楽観表示・commit patch・正解サマリ表示で共有する派生規則。
 */
export function deriveCorrectAnswerIds(options: CardOption[]): string[] {
  return options.filter((o) => o.is_correct).map((o) => o.id)
}
