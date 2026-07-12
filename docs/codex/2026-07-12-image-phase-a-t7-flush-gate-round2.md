# Codex independent review — image-phase-a-t7-flush-gate-round2 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new image gate can crash the entire entity mutation flush when a malformed persisted patch is encountered, blocking unrelated pending mutations. This is a functional regression in the flush path.

Review comment:

- [P2] Guard malformed patches before reading fields — /workspaces/RecallMint/lib/sync/entity-mutations.ts:216-217
  If a persisted pending `card`/`update_field` row has a malformed `patch` such as `null` or `undefined`, this new gate throws on `patch.field` before the POST is attempted. That rejects `flushAllPendingEntityMutations` and prevents unrelated pending mutations from syncing, whereas malformed rows should either bypass the gate or be handled by the normal server failure path.