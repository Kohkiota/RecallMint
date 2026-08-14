# Codex independent review — grid-3-t5-move-hook-fix1 (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The move hook can commit an optimistic move to a missing or unauthorized destination exam, while the corresponding server mutation will fail. This leaves the local mirror inconsistent and can hide affected cards.

Review comment:

- [P1] Validate the destination exam before moving cards — /workspaces/RecallMint/app/(app)/app/exams/_hooks/use-move-cards.ts:116-119
  When `targetExamId` is stale, deleted, or belongs to another user, this query simply returns no residents and the hook still rewrites the cards to that ID and enqueues a mutation. The server rejects the move because the destination exam is unavailable, leaving the optimistic mirror pointing at a nonexistent/inaccessible exam and causing the cards to disappear from normal views. Check `db.exams` with the current owner before applying the optimistic update, as the undo path already does for its destination.