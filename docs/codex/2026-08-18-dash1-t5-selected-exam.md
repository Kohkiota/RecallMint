# Codex independent review — dash1-t5-selected-exam (2026-08-18)

- **作成日**: 2026-08-18
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The readiness latch can settle before a competing tab's pull finishes, and the selected-exam epoch mechanism does not prevent an already-started stale write from winning. Both races can expose incorrect selection or empty-state behavior.

Full review comments:

- [P1] Wait for the lock holder before marking the pull settled — /workspaces/RecallMint/app/(app)/app/_components/pull-trigger.tsx:64-65
  When another tab currently holds the pull Web Lock, `runGuardedPull` returns `lock-busy` immediately even though that tab may still be fetching and has not updated the shared Dexie mirror. Marking the pull settled here lets Home interpret the current empty or stale mirror as final and briefly confirm states such as “0 exams”; `lock-busy` must remain unsettled until the active pull completes or the mirror's readiness is otherwise observed.

- [P2] Serialize selected-exam writes to prevent stale persistence — /workspaces/RecallMint/lib/dashboard/use-selected-exam.ts:125-131
  If `examIds` changes while this `setJsonSyncMeta` call is pending, the epoch guard cannot cancel the write because it has already been issued. A newer resolution can write exam B, after which the older exam A put may complete last and leave `selected_exam` persisted as A; the post-await guard only suppresses state and URL updates. The writes need serialization or a latest-decision check within an ordered transaction so stale operations cannot become the final stored value.