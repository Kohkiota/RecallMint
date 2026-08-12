# Codex independent review — fsrs-t4-server-replacement (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The migration destructively removes existing review history, and the revised endpoint is incompatible with existing client outbox data. It also silently drops session associations from newly ingested events.

Full review comments:

- [P1] Preserve existing review data during migration — /workspaces/RecallMint/drizzle/migrations/0035_overconfident_the_phantom.sql:1-3
  Running this migration on any populated environment permanently deletes every existing answer event, review, and session, then clears all study-day aggregates. This conflicts with the new model's purpose as a permanent review history and causes users to lose scheduling history and statistics on deployment; migrate/backfill the existing rows before dropping the legacy tables instead of recreating them empty.

- [P1] Accept legacy pending events without ratings — /workspaces/RecallMint/app/api/review-events/bulk/route.ts:62-66
  After this route switches to the new payload schema, pending events created by the currently shipped client can still omit `rating` (`RecordAnswerEventInput.rating` is optional and the flush payload only includes it when defined). Such persisted outbox entries now fail validation with 400, remain pending, and can block an entire batch indefinitely; retain the previous `is_correct` fallback or migrate old client records before requiring this field.

- [P2] Propagate the session ID into answer events — /workspaces/RecallMint/app/api/review-events/bulk/route.ts:74-76
  The existing flush client sends the session identifier only in the top-level `session` object and omits `session_id` from each event. This route now discards the top-level session and processes only `parsed.data.events`, so every newly ingested event is stored with `session_id = NULL`, losing the session label despite the client providing it; copy the top-level ID into events or update the client payload in the same change.