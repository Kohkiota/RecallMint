# Codex independent review — fix3-imp1-blur-ref-sync (2026-07-03)

- **作成日**: 2026-07-03
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new cleanup can commit dirty state to the wrong card if the component instance is reused with a different cardId, causing incorrect mirror/outbox updates.

Review comment:

- [P2] Bind cleanup commit to the same card — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/inline-text-field.tsx:162-168
  When `cardId` changes on an existing `InlineTextField` while the field is dirty, the cleanup for the previous effect runs after the new render has already overwritten `latestRef.current`. In that case the existence check still uses the old `cardId`, but `c(v)` is the new render's `commit`, so the previous card's text can be written/enqueued for the new card. Capture the value/commit/card identity consistently for the cleanup path or avoid running this cleanup on prop changes.