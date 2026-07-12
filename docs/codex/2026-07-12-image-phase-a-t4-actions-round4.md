# Codex independent review — image-phase-a-t4-actions-round4 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new upload reservation flow issues presigned PUT URLs without enforcing the declared size, so the advertised upload cap can be bypassed and oversized orphan objects can be stored. This is a functional/security issue in the new code.

Review comment:

- [P1] Bind the upload URL to the declared size — /workspaces/RecallMint/app/(app)/app/exams/[id]/_actions/asset-actions.ts:111-111
  When a buggy or malicious authenticated client calls `reserveAsset` with an allowed `byteSize` but then PUTs a much larger body to the returned presigned URL, this URL only fixes the content type, so R2 accepts the oversized object. `finalizeAsset` will reject it later because the HEAD size differs, but the bytes remain in the bucket as an orphan, making the 5 MiB hard cap ineffective for storage/cost abuse. Include the expected content length in the signed request or clean up mismatched uploads.