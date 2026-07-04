// exam-card-table-test-harness — test-only controlled wrapper for ExamCardTable。
// S2-5 で ExamCardTable は columnVisibility を controlled prop で受ける (state 所有 + 永続は
// exam-detail-view が単一所有) ようになった。 ExamCardTable 単体を render する既存 unit test は
// state 所有者を持たないため、 本 harness が exam-detail-view と同じ配線 (ColumnVisibilityToggle
// + ExamCardTable が local columnVisibility state を共有) を最小再現する。
//
// 注意: 本 file は test からのみ import される (prod 経路では未使用)。 永続 (sync_meta) は
// 意図的に持たない — 永続の検証は exam-detail-view.test で行う。

'use client'

import { useState } from 'react'
import type { VisibilityState } from '@tanstack/react-table'
import { ExamCardTable } from './exam-card-table'
import { ColumnVisibilityToggle } from './exam-card-table-column-toggle'

export function ControlledExamCardTable({
  examId,
  userId,
  initialColumnVisibility = { sort_key: false },
}: {
  examId: string
  userId: string
  initialColumnVisibility?: VisibilityState
}) {
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(initialColumnVisibility)
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
      />
      {/* exam-detail-view の chrome と同様に列ボタンを table と同一 state で配線する。 */}
      <ColumnVisibilityToggle
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
      />
    </>
  )
}
