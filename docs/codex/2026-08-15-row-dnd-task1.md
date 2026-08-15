# Codex independent review — row-dnd-task1 (2026-08-15)

- **作成日**: 2026-08-15
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new drop-to-placement conversion matches dnd-kit's arrayMove semantics, preserves input immutability, handles documented no-op cases, and composes correctly with the existing move planner. The added tests cover the relevant movement directions and edge cases.