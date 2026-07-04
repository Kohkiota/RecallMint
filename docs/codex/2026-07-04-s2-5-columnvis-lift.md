# Codex independent review — s2-5-columnvis-lift (2026-07-04)

- **作成日**: 2026-07-04
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The change can overwrite persisted column visibility during the initial preferences load race, causing user preferences to be lost. The rest of the modified behavior typechecks and the targeted tests pass.

Review comment:

- [P2] Preserve hidden columns before prefs finish loading — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-detail-view.tsx:98-101
  If the user switches views before the initial `getJsonSyncMeta` load resolves, `columnVisibility` is still the default `{ sort_key: false }`, so this write replaces any saved `hiddenColumns` with `['sort_key']`. On a slow IndexedDB read or quick click after opening the page, previously hidden columns such as `memo` are lost; either gate this write until prefs are loaded or read/merge the saved value for pre-load toggles.