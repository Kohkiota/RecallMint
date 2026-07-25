# Codex independent review — image-ux2-task3-pill-r2 (2026-07-25)

- **作成日**: 2026-07-25
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The functional tests and typecheck pass, but removing the separate folded-image button leaves the sole keyboard control without a visible focus indicator in the folded state.

Review comment:

- [P2] Keep a visible focus indicator inside the clipped image — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:357-358
  When `fold` is true, this image button becomes the only keyboard control, but its `outline-offset-1` outline lies outside the button and is clipped by the parent’s `overflow-hidden`; the button’s bottom edge is also below the fold. Consequently, keyboard users can tab to the control without seeing any focus indicator. Use an inset ring/outline or otherwise render the focus treatment inside the clipped region.