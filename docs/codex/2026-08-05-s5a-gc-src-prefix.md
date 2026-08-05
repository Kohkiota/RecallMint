# Codex independent review — s5a-gc-src-prefix (2026-08-05)

- **作成日**: 2026-08-05
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

A successful but malformed LIST response is silently normalized to an empty listing, which can cause the destructive cleanup script's readback verification to report success without establishing that deletion completed.

Review comment:

- [P1] Reject malformed successful LIST responses — /workspaces/RecallMint/lib/storage/r2.ts:293-299
  When R2 or an intermediary returns HTTP 200 with an empty, truncated, or otherwise malformed XML body, the regexes find no keys and no literal `IsTruncated=true`, so this returns `[]`. In the destructive script's post-delete readback, that is interpreted as proof that no objects remain, recreating the exact “unknown equals empty” failure the throwing contract is intended to prevent. Validate the expected `ListBucketResult` structure and a parseable `IsTruncated` value before accepting a page.