# Codex independent review — w3-local-cache-cleanup-r2 (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new asset-key pre-reads sit outside existing error handling in both single-card and bulk delete paths. A Dexie read failure therefore bypasses the established UI/result failure behavior.

Full review comments:

- [P2] Handle pre-read failures before leaving deleting state — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/delete-card-button.tsx:41-41
  When this new Dexie pre-read rejects (for example, a transient IndexedDB error or a closed database), the exception happens before the existing `try`/`catch`, so the async transition rejects and the button stays in the deleting phase instead of showing the existing error UI used for delete failures. Include the read/key collection in the same catch path, or handle it separately, so storage failures do not bypass recovery.

- [P2] Preserve bulk delete failure contract for pre-read errors — /workspaces/RecallMint/app/(app)/app/exams/[id]/_hooks/use-bulk-card-delete.ts:74-74
  If this new `bulkGet` rejects, the hook now throws before reaching the `try`/`catch`, so callers no longer receive the documented `{ ok: false, succeeded: [], failed: [...] }` result for storage failures. Move the pre-read/key collection into the guarded section or catch it explicitly so bulk delete remains all-or-nothing with a `BulkResult` on Dexie errors.