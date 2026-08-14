# Codex independent review — grid-3-t6-bulk-move-fix2 (2026-08-14)

- **作成日**: 2026-08-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The bulk-move implementation generally works, but split-out predictably fails when its synchronization pull overlaps another active pull because its retry is immediate and therefore ineffective.

Review comment:

- [P2] Wait before retrying a skipped pull — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-card-table.tsx:668-670
  When another pull is already in flight or holds the Web Lock, `runGuardedPull` returns immediately, so calling it again immediately will normally return the same skip outcome. The code then attempts the move before the newly created exam reaches the mirror, causing “新規試験へ切り出し” to fail and require another user click whenever it overlaps an existing pull. Retry only after the conflicting pull can finish, or otherwise wait for the exam to appear in the mirror.