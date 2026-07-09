// card-write — inline 編集 (試験詳細 page) の書込ドメインルールを集約する純関数群。
// P3 W3 (Task 4): presentation (inline-text-field / inline-card-list / use-card-options)
// に散在していた「card 書込の意味変換」を所在整理で本モジュールへ移送する。
// dedup ではなく relocation: 3 site は別々のドメイン規則であり、 それぞれを名前付き
// 純関数として切り出す。
//
// PURE 制約 (P1 lib/cards 前例): Dexie / React / 'use client' を持ち込まない。
// 入力のみに依存し副作用を持たない。 commit 機構 (debounce drain / refs / commit-on-
// unmount / ghost-merge) は presentation 側に残し、 本モジュールはそれらが呼ぶ変換だけを担う。

import type { EmptyCard } from './empty-card'

// ---------------------------------------------------------------------------
// 新規カード create patch 構築 (from inline-card-list buildMutation)
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
