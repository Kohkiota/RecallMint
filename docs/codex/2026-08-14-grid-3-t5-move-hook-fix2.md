# Codex independent review — grid-3-t5-move-hook-fix2 (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The normal paths and added tests pass, but the hook can optimistically commit move payloads that the server cannot apply because of assignment-count and integer-range constraints.

Full review comments:

- [P2] Reject assignment lists above the wire limit — /workspaces/RecallMint/app/(app)/app/exams/_hooks/use-move-cards.ts:138-142
  When a move triggers renumbering in an exam containing enough cards to produce more than 10,000 assignments, this code updates the local mirror and enqueues the entire list even though `cardMovePatchSchema` rejects `cards` above 10,000. The flush therefore fails while the optimistic changes remain visible, causing persistent client/server divergence; validate or otherwise handle the assignment count before entering `runOptimisticMutation`.

- [P2] Prevent generated orders from exceeding PostgreSQL integer range — /workspaces/RecallMint/app/(app)/app/exams/_hooks/use-move-cards.ts:138-142
  For an end placement where the destination's maximum `base_order` is above `2147482623`, the planner generates a value greater than PostgreSQL's signed `integer` maximum. The client schema currently accepts that number and this hook commits it to Dexie, but `applyCardMove` casts it to `int`, so the server mutation fails and leaves the mirror divergent. Guard the generated assignments or renumber before applying values outside the database column range.