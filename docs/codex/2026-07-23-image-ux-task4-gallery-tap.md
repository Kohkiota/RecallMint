# Codex independent review — image-ux-task4-gallery-tap (2026-07-23)

- **作成日**: 2026-07-23
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The modal-opening path can duplicate ongoing image downloads and block an otherwise ready image from opening while sibling requests time out. The tests pass but do not exercise concurrent thumbnail resolution.

Review comment:

- [P2] Reuse in-flight thumbnail resolutions when opening — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:215-215
  When one thumbnail becomes clickable while sibling thumbnails are still resolving, this calls `getAssetObjectURL` again for every sibling. That resolver caches only completed URLs and does not deduplicate in-flight requests, so the modal path issues duplicate signed-URL requests and image downloads, and `Promise.all` delays opening until every duplicate request finishes or reaches its 30-second timeout. Reuse each thumbnail's resolved URL/state or introduce shared in-flight resolution before building the modal collection.