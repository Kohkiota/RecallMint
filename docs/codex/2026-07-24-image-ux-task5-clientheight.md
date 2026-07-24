# Codex independent review — image-ux-task5-clientheight (2026-07-24)

- **作成日**: 2026-07-24
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The primary rendering paths and tests pass, but fold state can become stale when the viewport-derived height cap changes independently of the wrapper width.

Review comment:

- [P2] Observe cap-height changes when recomputing the fold — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:298-299
  When the viewport height changes without changing the gallery width (for example, resizing a desktop window or some browser-UI/viewport transitions), `min(70svh,44rem)` changes the measurement element's `clientHeight`, but this observer watches only `wrapper`. Consequently `recomputeFold` is not called and the image can remain incorrectly folded or unfolded for the new cap. Observe `measure` as well or subscribe to viewport resize events.