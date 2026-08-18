# Codex independent review — dash1-t4-origin (2026-08-18)

- **作成日**: 2026-08-18
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The origin field is propagated consistently from session launch through client persistence, wire serialization, server normalization, and database insertion. Type checking and the relevant unit tests pass, and no actionable regressions were identified.