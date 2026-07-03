# Codex independent review — notion-table-s1-2 (2026-07-03)

- **作成日**: 2026-07-03
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch currently fails the repository lint command because of an unused eslint-disable warning. There is also a user-visible state synchronization issue while the condition bar coexists with the fixed filter bar.

Full review comments:

- [P1] Remove the unused eslint-disable directive — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-condition-bar.tsx:89-89
  In this repo `npm run lint` uses `--max-warnings=0`, and this directive is now reported as unused because `_editorContext` already satisfies the unused-variable rule. As a result, the patch fails lint even though there are no errors; remove the directive or change the prop handling so the directive is actually needed.

- [P2] Keep the streak filter input in sync when clearing chips — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table-condition-bar.tsx:112-114
  When the condition bar removes a `currentStreak` filter, it only clears TanStack's column filter state; the coexisting fixed filter bar keeps its local `streakInput`/`streakOp` state. This leaves the threshold textbox showing a stale value after the filter chip disappears or after “すべてクリア”, and changing the operator can unexpectedly reapply that stale threshold.