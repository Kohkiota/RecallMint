# Codex independent review — image-phase-a-t3-r2 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The R2 module otherwise type-checks and its tests pass, but it does not enforce one of the documented required R2 environment variables, undermining the intended fail-fast behavior.

Review comment:

- [P2] Validate all required R2 environment variables — /workspaces/RecallMint/lib/storage/r2.ts:13-16
  The task contract calls for fail-fast validation of all five `R2_*` settings, but this module only reads/checks four of them, so a deployment with `R2_PUBLIC_URL` missing will still start successfully and the misconfiguration won't be caught at module load. Please include `R2_PUBLIC_URL` in the required-env validation (and add the corresponding test) or adjust the documented contract if it is intentionally no longer required.