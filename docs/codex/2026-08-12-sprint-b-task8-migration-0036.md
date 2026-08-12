# Codex independent review — sprint-b-task8-migration-0036 (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The migration can fail on valid legacy data created under the previous nullable schema, preventing the entire change from being deployed.

Review comment:

- [P1] Clean up legacy null source documents before enforcing NOT NULL — /workspaces/RecallMint/drizzle/migrations/0036_sprint_b_db_cleanup.sql:6-6
  Databases upgraded from migration 0027 can still contain operations with `source_document_id IS NULL`: that column originally allowed null, and migration 0032 only terminalized legacy `awaiting_sources`/`claimed` rows without deleting or backfilling them. If any such row remains, this `SET NOT NULL` fails and rolls back the entire production migration. Delete/backfill those legacy rows before applying the constraint, or keep the column nullable.