# Codex independent review — image-phase-a-t8-upload-saga-round2 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The upload saga can create unsyncable image mutations for over-limit cards, and a final local write failure can leave the upload gate permanently closed. These are functional correctness issues in failure/edge paths.

Full review comments:

- [P2] Prevent attaching an eleventh image — /workspaces/RecallMint/lib/media/upload.ts:275-279
  When `currentImages` already contains 10 entries, this still reserves, uploads, finalizes, and enqueues an `images` update with 11 entries. The server-side `imagesSchema` caps the array at 10, so that mutation will fail and remain pending while the local card shows an image that cannot sync, leaving an orphaned ready asset. Gate this before reserve/upload.

- [P2] Handle ready-status update failures — /workspaces/RecallMint/lib/media/upload.ts:348-348
  If this Dexie update rejects after `finalizeAsset` has succeeded, `attachImageToCard` throws instead of returning an `AttachResult`, and the local `media_assets` row can remain `uploading`. In that state the existing images mutation stays blocked by the upload gate even though the server asset is ready, so a transient IndexedDB failure at this final write can leave the card stuck.