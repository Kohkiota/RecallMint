# Codex independent review — sprint-b-task6-owner-scope-r2 (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The owner-scoping change prevents immediate cross-account flushing, but foreign tag edits are persisted under the foreign owner's identity and later execute with that owner's authenticated session. This creates delayed cross-account data modification in the shared-browser scenario the patch explicitly handles.

Full review comments:

- [P1] Reject foreign-owned tag edits instead of deferring them — /workspaces/RecallMint/lib/tags/tag-crud.ts:63-64
  When a shared browser still contains another user's tag rows, assigning `rowUserId: before.user_id` records the current user's rename/color edit under the victim's identity. The mutation is initially inert, but when that owner later signs in the new owner-scoped flush sends it with their valid session and applies the unauthorized edit. Foreign rows should be excluded or edits rejected rather than queued for execution during the owner's next session; the same issue affects the corresponding option handlers.

- [P1] Do not enqueue reordered foreign rows under their owners — /workspaces/RecallMint/lib/tags/reorder-handlers.ts:67-68
  If the reorder list contains stale rows owned by another account, this queues sort-key changes under that foreign owner. Those changes will be applied when the owner next signs in and their backlog is flushed, allowing one account to alter another account's ordering on a shared browser. Filter the reorder input to the authenticated `userId` or reject owner mismatches instead; `handleReorderOptions` has the same problem.