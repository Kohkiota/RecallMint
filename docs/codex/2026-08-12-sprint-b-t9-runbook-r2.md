# Codex independent review — sprint-b-t9-runbook-r2 (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The operational documentation contains sequencing errors around two irreversible steps: the production database migration and the Dexie upgrade test. Following the summarized procedures can eliminate the intended recovery point or make a required smoke test impossible.

Full review comments:

- [P1] Put the mandatory production backup before migration — /workspaces/RecallMint/docs/ops/sprint-b-db-cleanup-runbook.md:274-278
  For production, following §2 top-to-bottom proceeds directly from drain/timeout setup to this irreversible migration, while the required backup is only introduced later in §5.2. An operator will therefore encounter the backup instruction after 13 columns have already been dropped, leaving no recovery point if a rollback is needed; make backup creation and restore verification an explicit step immediately before this command.

- [P2] Seed Dexie v10 before the deployment in the phase summary — /workspaces/RecallMint/docs/superpowers/sessions/2026-08-12-sprint-b-db-cleanup.md:159-161
  This advertised sequence starts with deployment and postpones the Dexie test until smoke testing, but the canonical runbook says the same-origin v10 database must be opened and kept alive before deployment; afterward the new code immediately upgrades that origin to v12 and the blocked-upgrade scenario cannot be reproduced. Include the pre-deploy v10 seed in this summary so operators do not permanently skip the mandatory smoke case.