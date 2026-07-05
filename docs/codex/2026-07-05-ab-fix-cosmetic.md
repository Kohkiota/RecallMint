# Codex independent review — ab-fix-cosmetic (2026-07-05)

- **作成日**: 2026-07-05
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch improves the search input wording but leaves another visible creation prompt in the same select-only no-match/empty states, so the user-facing behavior remains inconsistent.

Review comment:

- [P2] Override the empty-state copy in select-only popovers — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx:172-175
  When `selectOnly` is true and the user filters to no matching category/option (or the list is empty), `CardTagOptionList` still falls back to its default `emptyPlaceholderText` of `タグ名を入力し新規作成` because only the input placeholder/aria label are overridden here. That still tells users to create a tag in filter/removal contexts where `onCreateNew` is disabled, so the new search-only wording is incomplete; pass a select-only empty-state string as well.