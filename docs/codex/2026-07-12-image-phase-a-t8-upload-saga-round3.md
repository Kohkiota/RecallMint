# Codex independent review — image-phase-a-t8-upload-saga-round3 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The upload saga handles many failure paths, but concurrent attachments can lose earlier successful image entries and leave orphaned assets because it replaces the full images array from a stale snapshot.

Review comment:

- [P2] Avoid overwriting concurrent image attachments — /workspaces/RecallMint/lib/media/upload.ts:287-292
  When two `attachImageToCard` calls start from the same `currentImages` snapshot (for example a multi-file picker or two quick uploads), each computes `nextImages` from that stale array before any transaction reads the current card row. The later `commitImages` replaces the whole `images` field with its own stale `currentImages + asset`, so a previously uploaded/finalized asset can disappear from the card and become a ready orphan. Build the append from the latest Dexie row or serialize per-card uploads.