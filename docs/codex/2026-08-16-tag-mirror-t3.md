# Codex independent review — tag-mirror-t3 (2026-08-16)

- **作成日**: 2026-08-16
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

Scoped storage works for stable owners, but an in-place account change retains and can persist the previous owner's preferences under the new owner. This violates the isolation goal of the change.

Review comment:

- [P1] Reload preferences when the owner changes — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-detail-view.tsx:90-90
  When `userId` changes without this component being remounted, this mount-only effect keeps the previous user's preferences in state and never reads the new scoped key. Because the persist effect now depends on `userId`, a later interaction can then write those stale preferences into the new user's namespace, defeating the intended account isolation. The load lifecycle and interaction guard should be reset and rerun for each `userId`.