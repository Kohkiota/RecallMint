# Codex independent review — ocr-2-3-inline-image (2026-07-29)

- **作成日**: 2026-07-29
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The common inline-image cases work, but valid reference-style images can survive when their reference and definition are separated by a table segment. This leaves image Markdown visible despite the stated contract.

Review comment:

- [P2] Strip reference images before splitting the document — /workspaces/RecallMint/components/markdown/md-table-text.tsx:61-64
  Parsing each segment independently misses reference-style images whose definition is in another segment. For example, `![x][img]` before a table with `[img]: /asset` after it is an `imageReference` in the complete document, but neither isolated text segment resolves it, so the image notation remains visible and violates the new removal contract. Image ranges need to be determined from the complete Markdown document, or reference definitions must be shared across segment parses.