# Codex independent review — w3-local-cache-cleanup (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new cleanup collection logic can throw on stale client mirror rows before deletion proceeds, regressing single and bulk card deletion for data shapes the surrounding code already treats as possible.

Full review comments:

- [P2] Guard stale images before single-card cleanup — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/delete-card-button.tsx:42-43
  If a stale/old Dexie card row has `images` present but not an array, this new pre-delete collection path throws before entering the existing `try` block, leaving the button stuck in `deleting` and preventing the card delete. Other image paths already defensively use `Array.isArray` for this mirror state, so this should do the same before calling `.filter`.

- [P2] Guard stale images before bulk cleanup — /workspaces/RecallMint/app/(app)/app/exams/[id]/_hooks/use-bulk-card-delete.ts:72-73
  When any selected card has a stale mirror row where `images` is non-array, this `.filter` call throws before the delete transaction runs, so the entire bulk delete fails instead of treating that card as having no reclaimable asset keys. Since the codebase already accounts for non-array `images` in stale rows, wrap this in an `Array.isArray(card?.images)` check before filtering.