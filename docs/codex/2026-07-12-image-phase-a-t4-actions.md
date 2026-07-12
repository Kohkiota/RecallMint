# Codex independent review — image-phase-a-t4-actions (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new server actions can throw instead of returning their ActionResult for unauthenticated requests and malformed IDs. These are observable failure paths for public server action inputs.

Full review comments:

- [P2] Map unauthenticated users to ActionResult — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:53-54
  When there is no Clerk session, `getCurrentUser()` throws `UnauthenticatedError` rather than returning `null`, so these server actions reject before the `ok: false` branch is reached. This affects unauthenticated calls to reserve/finalize/resolve and breaks the ActionResult contract; catch that error and convert it to the intended auth failure response.

- [P2] Validate asset IDs before querying UUID columns — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:99-99
  If a caller passes a non-UUID asset id, Postgres will error while casting the parameter for `assets.id` instead of returning the documented `{ ok: false }`/empty result. Since `assetId` and `assetIds` are untrusted server action inputs, validate them as UUIDs before using `eq`/`inArray` so malformed local state or direct calls do not turn into 500s.