# Codex independent review — dash1-t6-session-pool (2026-08-18)

- **作成日**: 2026-08-18
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The one-shot selection guard can retain an empty or previous-exam card pool after URL normalization or client-side exam changes, causing incorrect study sessions.

Review comment:

- [P1] Re-select cards when the resolved exam or fallback changes — /workspaces/RecallMint/app/(app)/app/study/smart/_components/study-session-host.tsx:95-97
  The permanent ref guard prevents this effect from reacting to dependencies that legitimately change. In particular, bookmark navigation without `exam` initially selects with `serverCards=[]`; after `useSelectedExam` adds the resolved exam to the URL, the refreshed page supplies server cards, but the preserved host skips selection and remains incorrectly empty. Changing the exam during client navigation can likewise leave cards from the previous exam displayed. Scope the guard to the current selection inputs or cancel and restart selection when they change.