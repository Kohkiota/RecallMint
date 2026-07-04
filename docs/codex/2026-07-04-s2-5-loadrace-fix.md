# Codex independent review — s2-5-loadrace-fix (2026-07-04)

- **作成日**: 2026-07-04
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The change introduces a load-race where a user action before preferences finish loading can be dropped from persistence. Existing tests pass, but this behavioral regression should be fixed.

Review comment:

- [P2] Replay preference writes skipped during load — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-detail-view.tsx:106-108
  If the user switches views before `getJsonSyncMeta` resolves and the saved prefs are missing or still `view: 'card'`, the `setView('table')` render hits this guard and skips persistence. When the load later only flips `prefsLoadedRef.current = true`, that ref change does not trigger this effect again, so the user's view change is never written and is lost on reload. The previous direct write in `handleToggle` did persist this scenario, so the guarded effect needs a post-load replay or loaded state that retriggers persistence.