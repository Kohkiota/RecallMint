# Codex independent review — image-ux-whole-branch (2026-07-24)

- **review 経路**: `codex exec review --base origin/develop` (sandbox_mode=danger-full-access / read-only 運用 / whole-branch f664675..HEAD)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)

---

The zoom flow can be substantially delayed by unrelated images and can open stale images after navigation because its asynchronous work is not canceled. These are user-visible behavioral defects in the newly added functionality.

Full review comments:

- [P2] Open the tapped image without waiting for every sibling — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:489-490
  When a target contains multiple images, `Promise.all` blocks opening the already-visible tapped image until every sibling finishes URL resolution and decoding. If one uncached sibling has a slow or stalled download, the tap appears unresponsive for up to the 30-second fetch timeout even though the selected image is ready; open the selected image first or resolve remaining slides without blocking initial display.

- [P2] Cancel modal opening when the gallery target changes — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:521-526
  If URL resolution is still pending when the learner advances to another card, this async closure continues using the old `targetImages` and later calls `open`, displaying the previous card's images over the new card. `CardImageGallery` is reused at the same position in `SessionRunner`, so its zoom hook remains mounted; guard the result with the current card/target or cancel the pending operation when those props change.