# Codex independent review — r1-asset-actions-domain-r2 (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The atomic status guard fixes the GC resurrection race, but it also turns a successful concurrent finalize into an erroneous not-found response. This can break duplicate/retried finalize calls despite the action being intended to be idempotent.

Review comment:

- [P2] Preserve idempotency when a concurrent finalize wins — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:186-187
  When two `finalizeAsset` calls for the same reserved asset run concurrently, both can pass the initial SELECT/HEAD, but the first UPDATE changes the row to `ready`; the second then gets `updated.length === 0` because of the new `status = 'reserved'` predicate and returns not-found. That regresses finalize's idempotent retry behavior for normal duplicate submissions; after a 0-row update, re-checking whether the asset is now `ready` would distinguish a concurrent finalize from a GC promotion to `deleting`.