# Codex independent review — dash1-task9-daily-new-target (2026-08-19)

- **作成日**: 2026-08-19
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The server update can succeed, but the newly added field then synchronizes from the still-stale local mirror and reverts the displayed value. This makes the primary UI flow misleading and dependent on a later successful pull.

Review comment:

- [P2] Preserve the saved value until the mirror catches up — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/daily-new-target-field.tsx:58-62
  After a successful change, the Dexie row still contains the previous value when `pending` becomes false. Because `value === committed`, this synchronization block immediately restores that stale mirror value, even though the UI reports “保存しました”; if `runGuardedPull` is skipped or fails, it remains wrong indefinitely. Track the last observed mirror value separately or suppress mirror synchronization until it actually reflects the saved value.