# Codex independent review — sprint-i-w3-gallery-four-fields (2026-07-15)

- **作成日**: 2026-07-15
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch adds per-option image galleries, but ties image targets to a user-editable option id without migrating existing image targets when that id changes. This can orphan attached option images in a normal supported edit flow.

Review comment:

- [P2] Preserve option images when the option id changes — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/inline-option-row.tsx:119-119
  Because the gallery target is derived directly from the editable `opt.id`, any image attached to `option:a` disappears from the UI as soon as that option id is edited to e.g. `b`: the image entry remains stored with the old target and no code migrates it. This only affects options that already have attached images and then have their id edited, but it leaves those images orphaned from the option.