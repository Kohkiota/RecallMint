# Codex independent review — sprint-b-t9-runbook-r3 (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The documentation contains two actionable operational errors: the required Dexie smoke test expects behavior Dexie normally prevents, and failed migrations leave role-wide timeout settings active. Both can mislead or disrupt deployment operations.

Full review comments:

- [P2] Account for Dexie's automatic versionchange close — /workspaces/RecallMint/docs/ops/sprint-b-db-cleanup-runbook.md:557-558
  When the first tab uses the normal Dexie connection, Dexie's default `versionchange` handler closes that connection automatically when the second tab requests v12, so the upgrade generally proceeds instead of remaining blocked until the operator closes or reloads the first tab. This makes the mandatory expected result fail even when the upgrade is healthy; use a deliberately non-closing raw IndexedDB connection to exercise `blocked`, or change the expected behavior to verify Dexie's automatic close path.

- [P2] Reset role timeouts on migration failure — /workspaces/RecallMint/docs/ops/sprint-b-db-cleanup-runbook.md:325-335
  If `pnpm db:migrate` fails with any of the listed errors, these instructions send the operator back to diagnosis and retry without resetting the database-level role defaults; the only reset appears after successful postflight. Consequently every later session for that owner retains the 5-second lock timeout and 120-second statement timeout, potentially breaking unrelated administrative work while the migration is postponed. Add the reset to the failure path (and reapply it immediately before a retry).