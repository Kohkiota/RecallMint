# Codex independent review — s5-1-column-pinning-helper (2026-07-05)

- **作成日**: 2026-07-05
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch introduces v3 records into the read schema while an existing caller still normalizes them as if they had no hidden columns, which can lose persisted table visibility preferences.

Review comment:

- [P2] Handle v3 in the v2 normalizer — /workspaces/RecallMint/lib/sync/sync-meta.ts:143-143
  When `sync_meta` already contains a v3 `examViewPrefs` record, this union now accepts it, but the still-used `examViewPrefsToV2` treats every non-v2 version as `hiddenColumns: []`. The current `ExamDetailView` reads through this schema and normalizer, so hidden columns from a v3 record will reappear and can be overwritten on the next user interaction.