# Codex independent review — t4-pure-helpers (2026-07-28)

- **作成日**: 2026-07-28
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The helpers are otherwise consistent with their documented interfaces, but blank-line analysis misclassifies valid Markdown blank lines containing whitespace.

Review comment:

- [P2] Recognize whitespace-only blank lines below tables — /workspaces/RecallMint/scripts/ai/lib/blank-line-below-table.ts:14-14
  When the blank line contains spaces or tabs (for example, `| 1 | 2 |\n   \nあとがき`), Markdown still treats it as a blank line, but this regex only accepts two immediately adjacent line endings and reports `hasBlankLineBelow: false`. OCR/model output can preserve incidental whitespace on otherwise empty lines, so allow horizontal whitespace between the two line endings.