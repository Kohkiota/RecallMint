# Codex independent review — row-dnd-task3 (2026-08-15)

- **作成日**: 2026-08-15
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new DnD components typecheck and their tests pass, but the column is widened before the drag handle can render, causing an unintended visible layout change in the current application.

Review comment:

- [P2] Keep the select column width unchanged until the handle is rendered — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:95-95
  Because `RowDragHandle` returns `null` until `SortableRow` provides its context, increasing this column to 112px immediately adds 24px of empty space and shifts every following column despite the stated task-3 requirement that the UI remain visually unchanged. Keep the width at 88px for this unconnected state, or coordinate the width increase with the task that actually renders the handle.