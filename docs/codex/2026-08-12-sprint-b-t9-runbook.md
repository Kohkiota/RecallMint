# Codex independent review — sprint-b-t9-runbook (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The mandatory Dexie migration smoke test cannot create the stated same-origin v10-to-v12 setup when followed after deployment, so it may report success without testing the blocked upgrade scenario.

Review comment:

- [P1] Seed Dexie v10 before deploying the new code — /workspaces/RecallMint/docs/ops/sprint-b-db-cleanup-runbook.md:488-489
  This required smoke test runs only after the new deployment, so opening `/app` in a fresh profile immediately executes the current `ClientDb` definition and creates/upgrades the database to v12 rather than “育てる” v10. A Vercel old-deployment URL normally has a different origin and therefore a different IndexedDB, so that fallback cannot seed the stg origin either. Consequently steps 2–3 do not exercise a v10 connection blocking a same-origin v12 upgrade; the procedure must preserve a v10 tab on the stable stg origin before deployment (or provide another same-origin seeding mechanism).