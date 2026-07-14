# Codex independent review — g5-reconciler-r4 (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The reconciler depends on `card_asset_refs` being continuously maintained, but the current application write path does not do that. This can cause live images added after backfill to be collected as unreferenced.

Review comment:

- [P1] Sync image refs before relying on NOT EXISTS — /workspaces/RecallMint/scripts/gc-image-assets.ts:593-593
  In the current tree, normal card image edits still update only `cards.images` (the `handleImages` path validates ready assets but never writes `card_asset_refs`), so after the one-shot backfill any newly-added live image has no ref row. Once there is at least one ref row the pre-sweep guard passes, and this `NOT EXISTS` condition marks those actively used assets as orphaned, allowing a later sweep to delete their R2 object and asset row while cards still contain the key.