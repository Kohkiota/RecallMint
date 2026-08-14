# Codex independent review — order-1-task2-base-order (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new migration cannot run against an existing populated database because it adds a required column without a default or backfill. This blocks deployment despite the application-level changes otherwise being internally consistent.

Review comment:

- [P1] Backfill base_order before enforcing NOT NULL — /workspaces/RecallMint/drizzle/migrations/0037_order_1_base_order.sql:3-3
  On any database containing cards, `ALTER TABLE ... ADD COLUMN "base_order" integer NOT NULL` fails immediately because every existing row receives NULL, so the migration cannot be deployed. Add the column as nullable, populate deterministic per-exam values preserving the existing order, then apply `NOT NULL` and the positive constraint.