# Codex independent review — image-phase-a-t10-edit-gallery-round2 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new gallery can crash on malformed or stale local card rows because it assumes `images` is always an array while other mapping code treats this field defensively.

Review comment:

- [P2] Guard gallery against missing image arrays — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:162-162
  When a Dexie/local mirror row has `images` missing or non-array (for example stale local data before a fresh pull), callers pass that value through to this component and `images.filter(...)` throws, breaking the exam detail view before the user can recover. The server-side mapper added an `Array.isArray` fallback for the same field, so the gallery or client mapping should apply the same defensive fallback before filtering.