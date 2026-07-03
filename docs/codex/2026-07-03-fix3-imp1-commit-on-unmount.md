# Codex independent review — fix3-imp1-commit-on-unmount (2026-07-03)

- **作成日**: 2026-07-03
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The unmount commit path can create an update mutation for a card that was just deleted locally, leaving a failed/pending outbox entry after sync. This is a functional regression in a realistic delete-while-editing scenario.

Review comment:

- [P2] Avoid enqueueing edits for deleted cards — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/inline-text-field.tsx:165-166
  When a dirty inline field is unmounted because the card was deleted, this cleanup still calls `commit(v)`. `runOptimisticUpdate` uses `cards.update`, which is a no-op for a missing key, but it still enqueues an `update_field` mutation; after the delete mutation is flushed, the server-side update fails for the now-missing card and remains pending/retried. The new deletion backstop test only checks that the row stays absent, so it misses the stale outbox entry.