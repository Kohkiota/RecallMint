# Codex independent review — ocr-2-4a-cutover (2026-08-02)

- **作成日**: 2026-08-02
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new orchestration succeeds on the happy path but its advertised retry paths cannot resume an operation. A transient upload, staging, or publishing failure can leave the user blocked by the live-operation gate or by already-finalized assets.

Full review comments:

- [P1] Reuse the idempotency key when retrying an upload — /workspaces/RecallMint/app/(app)/app/upload/_components/upload-form.tsx:509-513
  A new key is generated on every submit, so any failure after `prepareUpload` cannot be retried: the existing operation remains `awaiting_sources`, `claimed`, or `prepared`, and `prepareUpload`'s live-operation gate returns `in_progress` for the new key (claimed/prepared operations can block indefinitely). Preserve the operation/key for retries of the same entries so the server can resume its idempotent operation.

- [P1] Skip already-finalized sources when resuming — /workspaces/RecallMint/app/(app)/app/upload/_components/upload-form.tsx:558-562
  When a multi-image upload fails after one source has finalized, an idempotent retry receives all source assets again, including those already in `ready` state. This loop calls `reserveSource` for the ready asset first, but that action only accepts `status='reserved'`, so recovery stops with “アセットが見つかりません” before uploading the remaining sources. The resume path must either identify and skip ready assets or make reservation/finalization idempotent as a pair.