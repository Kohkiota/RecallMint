# Codex independent review — ocr-tuning-d-ingest-strip (2026-08-06)

- **作成日**: 2026-08-06
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new raw-length optimization can discard otherwise valid cards when image markup accounts for enough of the input length. This introduces avoidable data loss in the OCR normalization path.

Review comment:

- [P2] Strip images before applying the raw-length cutoff — /workspaces/RecallMint/lib/ocr/normalize-prepared.ts:181-182
  When a field exceeds 10,000 characters primarily because it contains many image tokens, this branch skips stripping even though the stripped value could satisfy the schema limit. For example, a short question followed by repeated `![](q001-img-1)` tokens is discarded as `invariant_failed` rather than retained with the tokens removed, causing avoidable OCR card loss. The cutoff must not assume stripping cannot reduce an oversized input below the limit.