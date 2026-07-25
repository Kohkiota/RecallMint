# Codex independent review — task1-audit-gate (2026-07-25)

- **作成日**: 2026-07-25
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The audit wrapper generally works, but malformed expiry dates can silently extend vulnerability acceptance, contradicting its fail-closed policy.

Review comment:

- [P2] Reject invalid calendar dates in allowlist expiries — /workspaces/RecallMint/scripts/audit-gate.mjs:128-130
  The regex validates only the shape of `expiry`, so values such as `2026-13-01` or `2026-02-31` are accepted. Because expiry enforcement uses lexical comparison, a typo like `2026-13-01` can keep a vulnerable dependency accepted beyond the intended deadline instead of failing closed; parse the components and verify they form the same real UTC date.