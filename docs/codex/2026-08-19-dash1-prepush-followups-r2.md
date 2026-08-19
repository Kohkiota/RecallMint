# Codex independent review — dash1-prepush-followups-r2 (2026-08-19)

- **作成日**: 2026-08-19
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new loading guard still permits destructive saves after an unsuccessful initial pull, which is one of the missing-mirror scenarios it is intended to prevent.

Review comment:

- [P1] Keep saving disabled after a failed initial pull — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/daily-new-target-field.tsx:78-80
  `firstPullSettled` becomes true when the initial pull rejects as well as when it succeeds. On a fresh browser whose pull fails transiently, `snapshot.exam` remains absent but this condition enables the blank field; if connectivity recovers enough for the server action, clicking Save writes `null` over an existing server-side target. The gate needs a successful mirror-readiness signal (or a server value) rather than the failure-inclusive settle latch.