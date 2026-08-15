# Codex independent review — row-ux-uifix-c (2026-08-15)

- **作成日**: 2026-08-15
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The resize feature has lifecycle and Strict Mode issues that can cause duplicate persistence or leave a cancelled drag active. The added tests pass but do not cover these browser and React execution paths.

Full review comments:

- [P1] Move the persistence callback out of the state updater — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-side-peek.tsx:114-116
  When React Strict Mode checks updater purity, the functional updater passed to `setLiveDragWidthVw` may be invoked twice, so its `onWidthChange(current)` side effect can persist the same drag twice despite the one-commit contract. Capture the final width separately and call `onWidthChange` outside the state updater.

- [P2] Clean up drag listeners when the pointer is cancelled — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-side-peek.tsx:119-120
  If the browser emits `pointercancel` instead of `pointerup`—for example when the OS interrupts the gesture—the listeners remain registered and `liveDragWidthVw` remains active. Later pointer movement or release can resize and persist the panel unexpectedly, and unmounting during the gesture also leaves callbacks targeting the old component. Handle `pointercancel` and remove all gesture listeners during component cleanup.