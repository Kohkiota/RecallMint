# Codex independent review — image-phase-a-t12-bulk-dl-round3 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The bulk download path misses rollback/error normalization for the final job status update, leaving an inconsistent `downloading` job if that write fails after cache writes succeeded.

Review comment:

- [P2] Roll back when final job update fails — /workspaces/RecallMint/lib/media/deck-download.ts:202-205
  If this final IndexedDB update rejects after all blobs have already been cached, the error escapes instead of using the existing rollback path. In that scenario the job remains `downloading` with `added_asset_ids`, so a later sweep can delete the successfully cached deck while the caller receives a thrown error rather than the documented `{ok:false}` result.