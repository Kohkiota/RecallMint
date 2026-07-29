# Codex independent review — ocr-2-3-inline-image-r2 (2026-07-29)

- **作成日**: 2026-07-29
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

Image stripping can change whether the document contains a table, while the block wrapper is still selected using the pre-stripping segmentation. This creates invalid nested markup and possible hydration failures for affected inputs.

Review comment:

- [P2] Base the block wrapper on stripped segments — /workspaces/RecallMint/components/markdown/md-table-text.tsx:64-65
  When removing an image makes previously invalid table syntax valid—for example `| a |\n![x](u)\n|---|`—this re-segmentation produces a table, but `MdTableBlock` has already selected `<p>` from the original segments. The resulting `<table>` inside `<p>` is invalid HTML and can cause browser auto-closing and React hydration mismatches; the wrapper decision must use the same stripped segments that are rendered.