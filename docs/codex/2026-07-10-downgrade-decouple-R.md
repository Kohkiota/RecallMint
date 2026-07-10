# Codex independent review — downgrade-decouple-R (2026-07-10)

- **作成日**: 2026-07-10
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new retry path misses the existing idempotent success handling for already-released or missing schedules, causing false failures in a race scenario. Other reviewed changes and tests appear consistent.

Review comment:

- [P2] Preserve idempotent release handling on retry — /workspaces/RecallMint/lib/stripe/subscription.ts:215-215
  When the first release call is rate-limited, the retry on this line bypasses `isAlreadyReleasedOrMissing`, so a retry that races with another release and returns `resource_missing` or “already released/completed” is surfaced as an error even though the helper’s contract treats that terminal state as success. This can make `cancelDowngrade` fail for the user or emit webhook failure notifications after the schedule has already been detached; the retry path should normalize those same terminal Stripe errors before rethrowing.