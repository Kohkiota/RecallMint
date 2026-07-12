# Codex independent review — image-phase-a-t4-actions-round2 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new resolve server action still has an unvalidated public input path that can throw for malformed non-array arguments. The other reviewed action logic appears consistent with the stated contract.

Review comment:

- [P2] Validate the ID list before reading length — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:165-168
  When `resolveAssetUrls` is invoked with malformed server-action input such as a string, `null`, or an object instead of `string[]`, this code reads `assetIds.length` and later calls `.filter`, causing the action to throw rather than return the documented `ActionResult`. Since server action arguments are untrusted at runtime, validate with a zod array schema before using array properties so direct or corrupted calls do not become 500s.