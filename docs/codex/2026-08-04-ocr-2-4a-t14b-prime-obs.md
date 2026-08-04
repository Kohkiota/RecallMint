# Codex independent review — ocr-2-4a-t14b-prime-obs (2026-08-04)

- **作成日**: 2026-08-04
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new observability data can falsely report that a source row was reclaimed by multiple concurrent purge calls. This undermines the accuracy of the success telemetry introduced by the patch.

Review comment:

- [P2] Only record rows actually deleted — /workspaces/RecallMint/lib/media/source-purge.ts:165-168
  When two idempotent terminal requests purge the same operation concurrently, both can select the same `deleting` candidate, but only the first row deletion affects a row. Drizzle does not throw when the second delete matches zero rows, so both calls increment `rowDeleteOk` and append the asset to `reclaimed`, producing duplicate and inaccurate success telemetry. Use `returning()` (or otherwise inspect the affected-row count) before recording the asset as reclaimed.