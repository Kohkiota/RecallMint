# Codex independent review — task1-audit-gate-r3 (2026-07-25)

- **作成日**: 2026-07-25
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The audit gate generally works, but allowlist expiration is conditional on the advisory appearing in the current audit response. This leaves stale expired entries undetected and does not provide the documented unconditional expiry enforcement.

Review comment:

- [P2] Enforce expiry for every allowlist entry — /workspaces/RecallMint/scripts/audit-gate.mjs:194-196
  When an allowlisted advisory is absent from the current registry response, its expiry is never checked because this condition runs only while iterating reported advisories. Consequently, after 2026-08-22 the gate can still pass with the expired entry present if the advisory is temporarily withdrawn or the vulnerable dependency disappears, contrary to the documented automatic expiry enforcement; validate all entry expiries when loading the allowlist.