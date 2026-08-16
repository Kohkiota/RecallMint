# Codex independent review — row-ux-uifix-f (2026-08-16)

- **作成日**: 2026-08-16
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The change consistently moves outside-close exemption markers from checkbox inputs to the full select-cell hit areas, with corresponding tests covering the rendered td/th elements and descendant matching. All 244 relevant tests pass.