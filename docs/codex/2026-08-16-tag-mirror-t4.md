# Codex independent review — tag-mirror-t4 (2026-08-16)

- **作成日**: 2026-08-16
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The owner-scoping changes can lose the only initial pull for a newly selected account when an old-owner pull or lock is active. This leaves the new account's local mirror unhydrated until an unrelated future trigger.

Review comment:

- [P1] Retry the pull after an account switch — /workspaces/RecallMint/app/(app)/app/_components/pull-trigger.tsx:47-50
  When `userId` changes while the previous user's pull is still in flight, this new mount kick is discarded by the module-global `pullInFlight` guard (or the global Web Lock). The old request will then normally fail the new owner-echo check, while no pull for the new user is queued, leaving their filtered mirror empty or stale until a later visibility/online event. The owner-change path needs to wait for or retry after the old pull completes rather than treating `inflight-skip`/`lock-busy` as final.