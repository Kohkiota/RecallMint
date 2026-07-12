# Codex independent review — image-phase-a-t10-edit-gallery (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The gallery introduces image deletion, but its full-array optimistic update can race with the upload saga and lose or resurrect image entries. This is a functional correctness issue in normal interactive use.

Review comment:

- [P2] Serialize deletes with concurrent image updates — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:181-186
  When a user starts an upload and deletes an existing image before the upload saga commits, this delete builds the full replacement array from the rendered `images` props while `attachImageToCard` later commits from its own earlier snapshot; the deleted image can be resurrected, and in the reverse ordering a newly uploaded image can be dropped. Since `images` updates are full-array replacements, delete needs to use a fresh mirror read and share the same per-card serialization as attach/abandon.