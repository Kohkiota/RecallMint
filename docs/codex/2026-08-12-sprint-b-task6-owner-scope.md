# Codex independent review — sprint-b-task6-owner-scope (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The owner-scoping change is not consistently applied to tag deletion paths. In the repository's explicitly supported shared-browser/account-switch scenario, category and option tombstones can be assigned to and flushed by the wrong user.

Full review comments:

- [P2] Preserve the category owner when enqueueing deletes — /workspaces/RecallMint/lib/tags/tag-crud.ts:206-208
  When a shared browser contains a previous user's tag rows, `CategoryList` still renders them because its query is not owner-scoped. Deleting one here supplies only the current authenticated `userId`, so `runOptimisticMutation` records the tombstone under the current user rather than the deleted category's `user_id`; the flush then repeatedly sends a mutation the server cannot authorize. Read the category before deletion and pass its owner as `rowUserId`, as the rename/color paths already do.

- [P2] Preserve the option owner when enqueueing deletes — /workspaces/RecallMint/lib/tags/tag-crud.ts:246-248
  After an account switch, the unscoped tag mirror can expose an option owned by the previous user. This delete passes no `rowUserId`, so the new owner-scoping logic attributes its tombstone to the current user and immediately flushes it with the current session, leaving an unauthorized mutation pending for repeated retries. Fetch the option's `user_id` before deleting it and use that as the outbox owner.