# Codex independent review — asset-gc-task2 (2026-08-10)

- **作成日**: 2026-08-10
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The extraction preserves existing CLI behavior, but the newly introduced bounded collection mode can indefinitely starve assets behind persistently failing candidates.

Review comment:

- [P2] Prevent failed candidates from starving bounded collection — /workspaces/RecallMint/lib/storage/asset-gc.ts:653-654
  When `collectLimit` is enabled, every run selects the same first rows by this stable ordering. If those rows repeatedly fail R2 deletion (especially `unreferenced_at IS NULL` rows, which are always first), they remain `deleting` and permanently occupy the batch, so later eligible assets are never collected. Add a retry/backoff ordering mechanism or otherwise ensure subsequent runs can advance past persistent failures.