# Codex independent review — image-phase-a-t9-get-asset-sweep-round3 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The sweep can unblock and repeatedly retry stale image mutations when the current card mirror no longer contains the stale upload, which is plausible at app startup because pull and sweep are both mounted triggers. This should be fixed before considering the patch correct.

Review comment:

- [P2] Clear stale image mutations before unblocking flush — /workspaces/RecallMint/lib/media/sweep.ts:50-51
  When startup pull has already overwritten the local card mirror back to the server version, this branch treats the stale upload as unreferenced and deletes its `media_assets` row. That row is the only thing keeping the pending `images` mutation blocked; after deletion, the outbox can flush a mutation that still contains this non-ready asset id, which the server rejects and leaves pending for repeated retries. Before removing the uploading row, also coalesce/remove any pending images mutation that references the stale asset, not only the current card mirror.