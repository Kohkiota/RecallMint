# Codex independent review — image-phase-a-t4-actions-round3 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new action leaves a public validation path where oversized dimensions pass zod but fail at the database layer, causing a 500-style rejection instead of the documented ActionResult. Other reviewed logic builds and typechecks.

Review comment:

- [P2] Bound image dimensions to the DB integer range — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:52-53
  When an authenticated caller sends a malformed direct server-action request with `width` or `height` above `2147483647`, `z.number().int().positive()` still accepts it up to JavaScript's safe-integer limit, but the `assets.width`/`height` columns are Postgres `integer`s. The subsequent INSERT will throw an integer-out-of-range database error instead of returning the intended invalid-input `ActionResult`, so cap these fields to the DB range or a reasonable image-dimension limit before inserting.