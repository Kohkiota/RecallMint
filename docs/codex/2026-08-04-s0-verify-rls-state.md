# Codex independent review — s0-verify-rls-state (2026-08-04)

- **作成日**: 2026-08-04
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new verifier can return a successful exit code after requested effectiveness checks fail, and its grant audit misses excess privileges on newly introduced tables. Both create false-green results in the security verification the patch is intended to provide.

Full review comments:

- [P1] Fail when an effectiveness probe cannot run — /workspaces/RecallMint/scripts/verify-rls-state.ts:601-603
  When a context observation errors, the result is only logged and omitted, so `evaluateEffectiveness` can still return PASS from an unrelated P0RLS probe and the CLI exits 0. For example, an invalid `--user` UUID makes every requested user observation fail at the cast while the verification is nevertheless reported successful; unexpected probe errors represented as `rows: -1` have the same issue. Treat any failed probe/observation as a nonzero verification result rather than silently evaluating the remaining subset.

- [P2] Reject grants on tables outside the expected catalog — /workspaces/RecallMint/scripts/verify-rls-state.ts:259-263
  The comparison checks only entries in `EXPECTED_GRANTS`, so direct grants to `recallmint_app` on an unknown table are silently accepted. This is especially relevant because the repository's default privileges grant blanket CRUD to newly created tables: forgetting to add the corresponding hardening/catalog entry would make this verifier report success despite excess app-role access. Iterate over actual table grants as well and flag tables absent from the expected catalog.