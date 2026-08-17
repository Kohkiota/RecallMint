# Codex independent review — card-tags-by-card-helper (2026-08-17)

- **作成日**: 2026-08-17
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new helper applies explicit tenant and card-ID filtering and maps rows consistently with the existing delta path. Type checking, linting, and the updated PostgreSQL integration test all pass.