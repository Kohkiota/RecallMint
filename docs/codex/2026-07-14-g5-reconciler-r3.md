# Codex independent review — g5-reconciler-r3 (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new GC script relies on `card_asset_refs` as authoritative, but the current write path does not keep that table synchronized for future card image edits. Running the script can therefore collect live images.

Review comment:

- [P1] Sync live image refs before enabling GC — /workspaces/RecallMint/scripts/gc-image-assets.ts:555-555
  When this reconciler runs after the one-shot backfill, normal card image edits made by the current app are still only written to `cards.images` (`handleImages` never updates `card_asset_refs`). In that scenario, this `NOT EXISTS` check treats actively used newly-added images as unreferenced, marks them, and a later sweep can delete their R2 objects and asset rows while cards still contain the image key.