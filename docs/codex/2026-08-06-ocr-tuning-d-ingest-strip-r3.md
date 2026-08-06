# Codex independent review — ocr-tuning-d-ingest-strip-r3 (2026-08-06)

- **作成日**: 2026-08-06
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The common cases work, but valid multiline Markdown images can produce overlapping line groups and leave orphaned whitespace, violating the function's documented behavior.

Review comment:

- [P2] Handle image ranges that span into another image's line — /workspaces/RecallMint/lib/markdown/strip-inline-images.ts:40-44
  When a Markdown image spans lines and another image follows on its ending line, for example `![alt\ntext](url) ![](b)`, grouping solely by each range's starting line makes the groups overlap. Each group then treats source text belonging to the other image as residual non-whitespace, so both syntax ranges are removed individually and the image-only content becomes a whitespace-only line instead of being removed. The line-level grouping needs to account for every physical line intersected by a range, or merge overlapping line groups.