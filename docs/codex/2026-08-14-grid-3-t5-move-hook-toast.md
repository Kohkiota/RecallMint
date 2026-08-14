# Codex independent review — grid-3-t5-move-hook-toast (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The move hook can enqueue payloads that violate the server's card-move schema while still committing optimistic mirror changes. Duplicate inputs and oversized renumbering operations therefore create persistent client/server divergence.

Full review comments:

- [P2] Deduplicate card IDs before planning the move — /workspaces/RecallMint/app/(app)/app/exams/_hooks/use-move-cards.ts:92-95
  When `cardIds` contains the same existing card more than once, `bulkGet` preserves those duplicates, so the planner emits multiple assignments for one card. This violates `cardMovePatchSchema`'s explicit unique-ID requirement; the optimistic mirror is updated, but the server rejects the queued mutation during flush, leaving client and server state divergent. Normalize the requested IDs before loading or planning.

- [P2] Reject moves that exceed the mutation assignment limit — /workspaces/RecallMint/app/(app)/app/exams/_hooks/use-move-cards.ts:118-122
  When insertion requires renumbering and the destination plus moved cards produces more than 10,000 assignments, this hook still applies every optimistic update and queues the patch, although `cardMovePatchSchema` caps `cards` at 10,000. The server will reject that envelope, permanently diverging the optimistic mirror from persisted state; validate the assignment count before entering `runOptimisticMutation` or split the operation into valid mutations.