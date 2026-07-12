# Codex independent review — image-phase-a-t7-flush-gate (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new gate can crash the entire flush on malformed array entries, preventing sync for all pending entity mutations. This is a functional regression introduced by the patch.

Review comment:

- [P2] Guard non-object image entries before reading key — /workspaces/RecallMint/lib/sync/entity-mutations.ts:219-220
  If a pending `images` mutation has an array value containing `null` or another primitive, this property access throws before any POST is attempted. That makes `flushAllPendingEntityMutations` reject and blocks unrelated pending mutations in the same outbox, whereas the malformed mutation should be ignored by the gate or sent to the server for normal per-mutation failure handling.