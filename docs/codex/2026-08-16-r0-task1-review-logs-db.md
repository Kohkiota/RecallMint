# Codex independent review — r0-task1-review-logs-db (2026-08-16)

- **作成日**: 2026-08-16
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new tenant-scoped table does not ensure that its tenant identifier matches the referenced answer event, allowing cross-tenant parent associations despite RLS.

Review comment:

- [P2] Tie the referenced event to the same tenant — /workspaces/RecallMint/lib/db/schema.ts:686-691
  When `recallmint_app` inserts a log, the RLS policy validates only `review_logs.user_id`, while this FK validates only `event_id`; PostgreSQL FK checks bypass RLS. A row can therefore use the current tenant's `user_id` but reference another tenant's `answer_events` row, corrupting the intended 1:1 event history and making that foreign tenant's deletion cascade into this tenant's data. Enforce the parent relationship on both `event_id` and `user_id` (and mirror it in migration 0039).