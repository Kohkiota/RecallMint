# Codex independent review — grid-3-t6-bulk-move-fix3 (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new split-out flow permits concurrent submissions before pending state reaches the rendered controls, which can create duplicate exams and duplicate move operations.

Review comment:

- [P2] Guard split-out synchronously against duplicate submits — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:655-656
  A rapid double-click can invoke `onSplitOut` twice before the `movePending` state update rerenders and disables the button. Both calls can observe `splitExamIdRef.current === null` and call `createExam`, producing duplicate empty exams and competing move attempts. Use a synchronous ref/mutex guard before starting the operation rather than relying only on React state.