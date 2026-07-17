# Codex independent review — sprint-t-add-affordance (2026-07-17)

- **作成日**: 2026-07-17
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The table option image affordance can attach images to blank ghost options, creating orphaned image targets that are not cleaned up. This is a functional regression in a normal add-option workflow.

Review comment:

- [P2] Gate option image add on non-empty options — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-options-edit-cell.tsx:109-109
  When a user clicks `+ 選択肢を追加`, `useCardOptions` creates a blank ghost option with a `uid`, so this condition now renders an image attach button for an option that is not persisted. If the user attaches an image before entering option text, the image is written to `cards.images` with `target=option:<ghost uid>`, but the blank option is sanitized/dropped and never participates in the removed-option cascade, leaving an orphaned image entry that no UI can reach. The card-view path avoids this by requiring non-empty option text before showing the add affordance.