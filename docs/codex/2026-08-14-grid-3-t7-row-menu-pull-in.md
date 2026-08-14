# Codex independent review — grid-3-t7-row-menu-pull-in (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The move wiring is generally coherent, but the new portaled row menu causes unintended row selection and its dialog does not reliably restore keyboard focus. Both are user-visible regressions in the added interaction.

Full review comments:

- [P2] Stop menu item clicks from selecting the row — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-row-menu.tsx:108-114
  When the user clicks 「ここに取り込む」, this click originates in the portaled `PopoverContent` but still propagates through React's component tree to the select `<td>`, whose handler calls `row.toggleSelected()`. Thus opening the picker unexpectedly changes the bulk selection state; stop propagation in this item handler as is already done for the menu trigger.

- [P2] Preserve the trigger before closing the popover — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-row-menu.tsx:165-170
  For keyboard users, the popover item is unmounted before `PullIntoDialog`'s effect records `document.activeElement`, so the recorded element is generally `body` or Radix's fallback rather than the row-menu trigger. Closing or escaping the dialog therefore does not reliably restore focus as intended; capture/pass the trigger element before closing the menu.