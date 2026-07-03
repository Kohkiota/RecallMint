# Codex independent review — notion-table-s1-2-fix1 (2026-07-03)

- **作成日**: 2026-07-03
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new condition bar can clear a streak filter without updating the existing filter bar's local streak controls, leaving stale UI state after a normal user action. Tests pass, but the patch introduces a user-visible inconsistency that should be fixed.

Review comment:

- [P2] Keep streak inputs synced when chips clear filters — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-condition-bar.tsx:112-114
  When the `currentStreak` filter is removed from ConditionBar, this only clears TanStack's column filter. The fixed filter bar keeps `streakInput`/`streakOp` in local state initialized once, so after clicking this chip's × or “すべてクリア” the rows are restored but the threshold control can still display the old value (unlike answer/tag filters that derive from table state). Sync the local streak controls from `streakFilter` changes or clear them through shared state so the UI doesn't show a stale cleared condition.