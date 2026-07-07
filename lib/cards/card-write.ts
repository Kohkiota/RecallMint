// card-write — inline 編集 (試験詳細 page) の書込ドメインルールを集約する純関数群。
// P3 W3 (Task 4): presentation (inline-text-field / inline-card-list / use-card-options)
// に散在していた「card 書込の意味変換」を所在整理で本モジュールへ移送する。
// dedup ではなく relocation: 3 site は別々のドメイン規則であり、 それぞれを名前付き
// 純関数として切り出す。
//
// PURE 制約 (P1 lib/cards 前例): Dexie / React / 'use client' を持ち込まない。
// 入力のみに依存し副作用を持たない。 commit 機構 (debounce drain / refs / commit-on-
// unmount / ghost-merge) は presentation 側に残し、 本モジュールはそれらが呼ぶ変換だけを担う。

import type { CardOption } from '@/lib/db/schema'
import type { EmptyCard } from './empty-card'

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
  value: string,
): string | null {
  return NULLABLE_TEXT_FIELDS.has(field) && value === '' ? null : value
}

// ---------------------------------------------------------------------------
// 2. 新規カード create patch 構築 (from inline-card-list buildMutation)
// ---------------------------------------------------------------------------

// outbox create patch の options 形 (camelCase)。 server bulk endpoint の optionsSchema
// が期待する形で、 lib/cards/card-field-handlers.ts の handler が snake_case へ戻す。
type OutboxCardOption = {
  id: string
  text: string
  isCorrect: boolean
  explanation?: string
}

// outbox create mutation の patch 形 (snake_case + camelCase options)。
export type NewCardMutationPatch = {
  exam_id: string
  title: string
  sort_key: string
  question_text: string
  options: OutboxCardOption[]
  explanation_text: null
  memo: null
}

/**
 * buildEmptyCard 由来の EmptyCard を、 outbox create mutation の patch 形へ写像する。
 * options は camelCase (is_correct → isCorrect) に詰め替え、 explanation は空なら省く。
 * explanation_text / memo は新規カードでは常に null。 server は options の isCorrect
 * から correct_answer_ids を再生成するため patch に含めない。
 */
export function buildNewCardMutationPatch({
  examId,
  empty,
}: {
  examId: string
  empty: EmptyCard
}): NewCardMutationPatch {
  return {
    exam_id: examId,
    title: empty.title,
    sort_key: empty.sortKey,
    question_text: empty.questionText,
    options: empty.options.map((o) => ({
      id: o.id,
      text: o.text,
      isCorrect: o.is_correct,
      ...(o.explanation ? { explanation: o.explanation } : {}),
    })),
    explanation_text: null,
    memo: null,
  }
}

// ---------------------------------------------------------------------------
// 3. correct_answer_ids の derive (from use-card-options)
// ---------------------------------------------------------------------------

/**
 * options の is_correct フラグから correct_answer_ids を導出する (順序保存)。
 * mirror の楽観表示・commit patch・正解サマリ表示で共有する派生規則。
 */
export function deriveCorrectAnswerIds(options: CardOption[]): string[] {
  return options.filter((o) => o.is_correct).map((o) => o.id)
}
