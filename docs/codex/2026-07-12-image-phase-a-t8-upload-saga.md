# Codex independent review — image-phase-a-t8-upload-saga (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The upload saga does not handle thrown server-action failures consistently. A thrown finalize failure can leave local optimistic media state stuck in uploading, which can block image mutation flushing.

Full review comments:

- [P1] Abandon the optimistic upload when finalize throws — /workspaces/RecallMint/lib/media/upload.ts:301-301
  When the injected `finalizeAsset` rejects rather than returning `{ ok: false }` (for example a server-action/network/R2/DB failure), this `await` exits before `abandonUpload` runs. At that point the cache blob, `media_assets` row in `uploading`, mirror image entry, and held outbox mutation have already been written, so the card can be left stuck behind the upload gate instead of reaching the documented clean `FINALIZE_FAILED` end-state.

- [P2] Return RESERVE_FAILED when reserve throws — /workspaces/RecallMint/lib/media/upload.ts:249-255
  If the injected `reserveAsset` rejects (e.g. server-action transport failure, DB/presign exception), `attachImageToCard` rejects instead of returning the promised `{ ok: false, code: 'RESERVE_FAILED' }`. There are no local writes yet, but callers that branch on `AttachResult` will miss the failure code and likely show the wrong/errorless UI for this reserve-failure path.