# Codex independent review — image-phase-a-t10-edit-gallery-round3 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The gallery generally wires display, upload, and deletion, but the upload path can still crash for the stale/non-array mirror rows that the component explicitly tries to support.

Review comment:

- [P2] Normalize fresh-read images before attaching — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:177-179
  When a stale Dexie card row has a non-array `images` value, this component normalizes the prop to `safeImages`, but `attachImageToCard` immediately fresh-reads the raw row again and uses that value as an array. In that case selecting a file can reject with `currentImages is not iterable` instead of returning an attach error, so the gallery breaks despite the defensive `Array.isArray` guard here. The fresh-read path should apply the same array normalization before append/remove operations.