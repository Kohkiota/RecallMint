# Codex independent review — sprint-i-w5-uid-cascade (2026-07-16)

- **作成日**: 2026-07-16
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch introduces a required option `uid` at the write boundary without migrating or normalizing existing option data, which breaks option edits for legacy cards. This is a functional regression for existing data.

Review comment:

- [P1] Backfill legacy option uids before requiring them — /workspaces/RecallMint/lib/validation/card.ts:18-18
  When a user edits options on a card whose existing option JSON lacks `uid` (pre-existing cards still have that shape, and `CardOption.uid` remains optional), the client sends `uid: undefined` via `toZodOption`, and this schema now rejects the mutation. The bulk endpoint then marks the option update failed, so edits to legacy cards' options never persist to the server; this needs a migration/backfill or a compatibility path that mints/tolerates missing uids before making the field required.