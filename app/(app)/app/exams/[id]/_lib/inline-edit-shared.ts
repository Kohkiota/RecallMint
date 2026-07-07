'use client'

// inline 編集 primitive (InlineTextField / InlineOptionCell) の低次共有片 (P3 W5 Task6)。
// 2 sites のみ (rule of three 未満) のため lib/ へ昇格せず exams _lib のローカル共有に留める。
// 共有対象は cosmetic/mechanical な 2 点のみ:
//   1. SHARED_BOX_CHROME  : display/edit の box 寸法を一致させる verbatim class 文字列
//   2. useAutoResizeTextarea : multiline textarea の内容高さ追従 hook
// commit 機構 (commit-on-unmount / debounce drain / blur commit) と dirty-guard は各実装に
// 残す (dirty-guard は sentinel 更新 timing が両者で異なり外部挙動が変わるため共有しない — P3 W5 判断)。

import { useLayoutEffect, type RefObject } from 'react'

// display / edit で共通の box 寸法 (border-box + padding + 1px border + radius +
// 最小高さ + 幅)。 textarea / input の default は twMerge で表示モードと同じ値に上書きする。
export const SHARED_BOX_CHROME = 'block w-full min-h-11 rounded-md p-2 md:min-h-8 md:py-1'

// multiline textarea の auto-resize: 編集中 + trigger 値変化に追従して内容高さに合わせる。
// useLayoutEffect で paint 前に同期実行 (initial mount の 1 frame flicker 回避)。
// single-line input (kind='id' 等) では instanceof 判定で no-op。
//
// caller は自前の ref と trigger 値 (編集中 state) を渡す。 dep は [editing, triggerValue] で、
// 呼び出し元の元 useLayoutEffect と同一 semantics。
export function useAutoResizeTextarea(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  editing: boolean,
  triggerValue: string,
): void {
  useLayoutEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!(el instanceof HTMLTextAreaElement)) return
    // '0px' で一旦潰してから scrollHeight を測る。 'auto' だと textarea 既定
    // rows=2 の 2 行枠が clientHeight として残り scrollHeight=2 行で固定され、
    // 1 行内容でも 2 行高さに膨らむ (display とズレる)。 '0px' なら真の内容高を返す。
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
    // ref は stable ゆえ dep に含めない (元 useLayoutEffect と同一の [editing, trigger])。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, triggerValue])
}
