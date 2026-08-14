# Codex independent review — grid-3-t8-exam-merge (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The normal merge and undo paths work, but overlapping an undo with a subsequent merge creates a race that can erase the newer operation's undo action.

Review comment:

- [P2] Preserve newer merge toasts when an older undo finishes — /workspaces/RecallMint/app/(app)/app/exams/_components/exam-list-live.tsx:101-105
  If an undo is pending and the user completes another merge, that merge replaces the single toast with its own undo action, but completion of the older `undoMove` unconditionally calls `showMergeToast` here and overwrites the newer toast. This discards the only undo material for the newer merge and can also leave its button disabled by the global `undoPending`; associate completion with the toast/operation that initiated it and ignore stale results.