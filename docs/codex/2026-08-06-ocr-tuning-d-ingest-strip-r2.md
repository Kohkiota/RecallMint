# Codex independent review — ocr-tuning-d-ingest-strip-r2 (2026-08-06)

- **作成日**: 2026-08-06
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The ingest stripping works for the tested cases, but fails its documented behavior when multiple image tokens are the only substantive content on one line.

Review comment:

- [P2] Remove lines containing multiple image tokens — /workspaces/RecallMint/lib/ocr/normalize-prepared.ts:385-385
  When a field has a whitespace-only line containing multiple image tokens, such as `![](a) ![](b)`, `stripInlineImages` evaluates each token while the other token is still present, so neither range is considered the line's sole content. The syntax is removed but a whitespace-only line remains, contradicting the documented ingest behavior and potentially preserving unwanted blank lines; line-sole detection needs to consider all image ranges together.