# Codex independent review — image-ux-task5-inflow-fold (2026-07-23)

- **作成日**: 2026-07-23
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new single-image in-flow renderer leaks URL and dimension state across normal study-card navigation, causing stale imagery and incorrect fold calculations.

Review comment:

- [P1] Reset the single-image component when the asset changes — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:562-562
  When advancing between cards that each have one question image, React reuses this unkeyed component. `useAssetObjectUrl` retains the previous URL until the new request finishes, while `dims` and `naturalRef` are never cleared; if the new asset lacks a mirror row, the old dimensions continue to override its natural dimensions permanently, producing incorrect folding and briefly showing the previous card's image under the new card's controls. Key this component by the asset/user or explicitly reset all asset-specific state when `image.key` changes.