# Codex independent review — dash1-t1-migration (2026-08-18)

- **作成日**: 2026-08-18
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The card mapper change breaks an existing unit test and no longer preserves legacy client-card shape through a round trip. The remaining targeted tests and type checking passed.

Review comment:

- [P1] Preserve the optional field during card round trips — /workspaces/RecallMint/lib/db/cards-mapper.ts:44-44
  When a pre-migration `ClientCard` omits `first_reviewed_at`, `toCard` converts it to `null` and this line causes `toClientCard(toCard(card))` to add a new property. This breaks the existing round-trip contract and currently fails `lib/db/cards-pull.test.ts`; either preserve omission or update the compatibility contract and affected test fixtures consistently.