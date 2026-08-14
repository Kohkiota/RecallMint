# Codex independent review — grid-3-t4-exam-rename (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The rename workflow is otherwise coherent and its focused tests pass, but the shared title component introduces a visible regression by truncating long titles in the card view.

Review comment:

- [P2] Preserve wrapping for long card-view exam titles — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-title-inline-edit.tsx:127-128
  For exam names wider than the card-view container, this unconditional `truncate` changes the previous wrapping `<h1>` into clipped text. Because the `title` attribute contains editing instructions rather than the exam name, users cannot read the full title without entering edit mode; apply truncation only in the compact table variant or allow the card title to wrap.