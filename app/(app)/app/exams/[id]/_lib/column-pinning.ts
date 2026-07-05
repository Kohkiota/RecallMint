// column-pinning — 境界⇄pinning 配列の相互導出 helper (S5-1)。
// pure 関数 (Dexie 非依存)。列順の SSoT = examCardTableColumns の import 導出
// (literal 複製禁止 — 列追加/削除時に自動追従するため)。

import type { ColumnPinningState } from '@tanstack/react-table'
import { examCardTableColumns } from '../_components/exam-card-table-columns'

// examCardTableColumns の module 定義順に id を並べた配列を 1 回だけ導出する。
// id が undefined の列(display column 等)は除外する。
const ALL_COLUMN_IDS: string[] = examCardTableColumns
  .map((c) => c.id)
  .filter((id): id is string => Boolean(id))

/**
 * 境界列 id から left-pinned 配列を導出する (spec D-2)。
 * examCardTableColumns の定義順で先頭から boundaryId まで(select・boundaryId 含む)を返す。
 * null / 未知 id(将来の列改廃・不正永続値)の場合は [] を返す。
 *
 * left 配列の書込はこの関数経由に一元化する(menu handler / load 復元の両経路)。
 * getHeaderGroups は pinning 配列順に並べ替えるため、一元化が視覚列順不変の構造的保証になる。
 */
export function computePinnedLeft(boundaryId: string | null): string[] {
  if (boundaryId === null) return []
  const idx = ALL_COLUMN_IDS.indexOf(boundaryId)
  if (idx === -1) return []
  return ALL_COLUMN_IDS.slice(0, idx + 1)
}

/**
 * TanStack ColumnPinningState から境界列 id を逆引きする (spec D-2)。
 * left 配列の末尾 id を返す。空 / 末尾が 'select' → null。
 *
 * 'select' は固定境界にならない(menu を持たない列)ため末尾 select を null に落とす防御を
 * derivePinnedBoundary に集約する(書込経路を computePinnedLeft に一元化する副産物として
 * 実際には末尾 select の配列は生成されないが、読込復元時の不正値に対する安全網として残す)。
 */
export function derivePinnedBoundary(state: ColumnPinningState): string | null {
  const left = state.left
  if (!left || left.length === 0) return null
  const last = left[left.length - 1]
  if (last === 'select') return null
  return last
}
