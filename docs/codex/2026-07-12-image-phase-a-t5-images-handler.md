# Codex independent review — image-phase-a-t5-images-handler (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new images handling mostly follows the intended flow, but it uses a broader UUID predicate than the specified UUIDv4 discriminator, which can incorrectly reject legacy image entries with non-v4 UUID-shaped keys.

Review comment:

- [P2] Use a UUIDv4 check for asset image keys — /workspaces/RecallMint/lib/cards/card-field-handlers.ts:171-173
  When an existing legacy OCR image key happens to be a valid non-v4 UUID, this predicate classifies it as an asset reference and the mutation then fails unless that UUID exists in the user's ready assets. The documented invariant is specifically UUIDv4 = asset reference and non-v4 = legacy passthrough, so the handler and schema should use a v4-only UUID check consistently.