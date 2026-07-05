// exam-card-table-test-harness — test-only controlled wrapper for ExamCardTable。
// S2-5 で ExamCardTable は columnVisibility を controlled prop で受ける (state 所有 + 永続は
// exam-detail-view が単一所有) ようになった。 ExamCardTable 単体を render する既存 unit test は
// state 所有者を持たないため、 本 harness が exam-detail-view と同じ配線 (ColumnVisibilityToggle
// + ExamCardTable が local columnVisibility state を共有) を最小再現する。
//
// S5-2: columnPinning も同様に controlled state として内包し、
// optional な外部 spy (onColumnPinningChange) で呼出値を検証できるよう追加した。
//
// 注意: 本 file は test からのみ import される (prod 経路では未使用)。 永続 (sync_meta) は
// 意図的に持たない — 永続の検証は exam-detail-view.test で行う。

'use client'

import { useState } from 'react'
import type { VisibilityState, ColumnPinningState, OnChangeFn } from '@tanstack/react-table'
import { ExamCardTable } from './exam-card-table'
import { ColumnVisibilityToggle } from './exam-card-table-column-toggle'

export function ControlledExamCardTable({
  examId,
  userId,
  initialColumnVisibility = { sort_key: false },
  initialColumnPinning = { left: [], right: [] },
  onColumnPinningChange: externalOnColumnPinningChange,
}: {
  examId: string
  userId: string
  initialColumnVisibility?: VisibilityState
  // S5-2: 固定状態の初期値(デフォルト = 固定なし)。
  initialColumnPinning?: ColumnPinningState
  // S5-2: pinning 変更を外部 spy で観察するための optional callback。
  onColumnPinningChange?: (val: ColumnPinningState) => void
}) {
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(initialColumnVisibility)
  const [columnPinning, setColumnPinning] =
    useState<ColumnPinningState>(initialColumnPinning)

  // S5-2: pinning 変更で内部 state を更新し、外部 spy があれば通知する。
  // onColumnPinningChange は値形式(関数でない)で呼ばれるため型アサートで外部通知。
  const handleColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    setColumnPinning(updater)
    if (externalOnColumnPinningChange && typeof updater !== 'function') {
      externalOnColumnPinningChange(updater)
    }
  }

  // ExamCardTable を先に置き container.firstElementChild = table root を保つ (既存の
  // 構造 test が firstElementChild を ExamCardTable root として参照するため)。 列ボタンは
  // 後置 (state 共有ゆえ順序は挙動に無関係、 label query で参照される)。
  return (
    <>
      <ExamCardTable
        examId={examId}
        userId={userId}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        columnPinning={columnPinning}
        onColumnPinningChange={handleColumnPinningChange}
      />
      {/* exam-detail-view の chrome と同様に列ボタンを table と同一 state で配線する。 */}
      <ColumnVisibilityToggle
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
      />
    </>
  )
}
