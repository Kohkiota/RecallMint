# Codex independent review — grid-3-t1-card-order (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The main move-planning behavior is well tested, but an empty move can unexpectedly trigger a full target-exam renumbering. This input is accepted by the public function and is not documented as invalid.

Review comment:

- [P2] Return early when there are no cards to move — /workspaces/RecallMint/lib/cards/domain/card-order.ts:132-135
  When `movedCards` is empty and the selected insertion gap has duplicate adjacent orders (or a leading order of zero), `k = 0` still reaches the `step = 0` path and returns assignments that renumber every resident card. A zero-card move should be a no-op rather than unexpectedly rewriting the target exam, so return an empty, non-renumbered plan before resolving the insertion point.