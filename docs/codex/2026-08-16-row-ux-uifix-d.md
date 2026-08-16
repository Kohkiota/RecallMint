# Codex independent review — row-ux-uifix-d (2026-08-16)

- **作成日**: 2026-08-16
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

Most ordinary outside clicks now close the peek, but clicks whose handlers stop propagation—specifically the existing row-selection checkboxes—still leave it open despite not being an intended exemption.

Review comment:

- [P2] Close the peek when an outside checkbox is clicked — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-side-peek.tsx:259-264
  When the user clicks a row-selection checkbox while the peek is open, the checkbox's `onClick` calls `stopPropagation()`, so Radix's deferred document-level outside-click listener never receives the click and `onDismiss` does not run. This contradicts the new default that outside clicks close the peek—the documented exceptions are only overlays and grip triggers—and the updated T3 ⑦ test now explicitly preserves this accidental exception. Handle dismissal without depending on the bubbled follow-up click, while retaining the checkbox action.