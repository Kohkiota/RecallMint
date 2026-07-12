# Codex independent review — image-phase-a-t9-get-asset-sweep (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new sweep runs at app startup and can mutate/delete media state for accounts other than the currently authenticated user in a shared browser. That makes the patch unsafe despite tests, typecheck, and lint passing.

Review comment:

- [P2] Scope media sweep to current user — /workspaces/RecallMint/lib/media/sweep.ts:78-78
  When a browser has IndexedDB rows from a previously signed-in account, this unscoped startup sweep processes every `media_assets` and `media_download_jobs` row on the origin. For stale uploads that still have a card mirror, `abandonUpload` will also enqueue a card `images` mutation for that other user's card while the current session belongs to a different user, so the row is deleted locally and the outbox can be flushed under the wrong account. Thread `user.id` from the layout/trigger and filter both sweep queries to that user before mutating rows.