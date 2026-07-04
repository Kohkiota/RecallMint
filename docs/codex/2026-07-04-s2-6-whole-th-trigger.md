# Codex independent review — s2-6-whole-th-trigger (2026-07-04)

- **作成日**: 2026-07-04
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The changes are limited to moving header filter indicators and sort glyphs inside their trigger controls, and the related tests cover the new behavior. Typecheck, lint, and relevant Vitest suites pass, and no discrete regressions were identified.