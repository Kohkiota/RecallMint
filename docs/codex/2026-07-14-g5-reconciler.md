# Codex independent review — g5-reconciler (2026-07-14)

- **作成日**: 2026-07-14
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new CLI script is not reliably executable as documented, and even non-deleting modes can fail during module initialization due to eager server/R2 imports. These startup failures block the intended GC/dry-run workflows.

Full review comments:

- [P1] Require the server condition for CLI execution — /workspaces/RecallMint/scripts/gc-image-assets.ts:37-37
  When running the documented commands such as `pnpm tsx scripts/gc-image-assets.ts --dry-run`, this top-level server dependency resolves `server-only` to its throwing entry unless `tsx` is invoked with `--conditions=react-server`, so the script exits before argument parsing. Existing scripts in this repo call out that condition; this script should either document/use it or avoid importing `server-only` guarded modules at startup.

- [P2] Defer R2 loading for mark and dry-run modes — /workspaces/RecallMint/scripts/gc-image-assets.ts:41-41
  For mark-only runs or `--dry-run`, this import still evaluates `lib/storage/r2.ts` at module load time, which requires all R2 environment variables before the script knows no R2 delete will be performed. In environments intended only for dry-run/backfill validation without R2 credentials, the script aborts with `R2_ACCOUNT_ID is not set`; lazy-loading/binding `deleteObject` only for real sweep collection would preserve the advertised write-free dry-run behavior.