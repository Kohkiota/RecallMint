# Codex independent review — sprint-b-task4-archived-at (2026-08-12)

- **作成日**: 2026-08-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The archived_at reader removal is applied consistently across server queries, upload handling, pull mapping, client types, UI, and tests. Type checking and the targeted test suite pass.