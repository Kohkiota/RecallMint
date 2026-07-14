# Codex independent review — r1-asset-actions-domain (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new guard prevents stale deleting/deleted rows from being finalized, but it is not atomic with the update and can still resurrect an asset during a GC race.

Review comment:

- [P2] Make the finalize status guard atomic — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:159-159
  When GC promotes an asset from `reserved` to `deleting`/`deleted` after this SELECT but before the final UPDATE, this guard has already passed and the UPDATE still matches only `id` and `userId`, so `finalizeAsset` can still set the row back to `ready`. To reliably prevent resurrecting GC-owned assets, enforce `status = 'reserved'` in the UPDATE predicate and verify that a row was updated, or perform the transition atomically in a transaction.