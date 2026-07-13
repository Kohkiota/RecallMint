# Codex independent review — ios-webkit-t5-fallback (2026-07-13)

- **作成日**: 2026-07-13
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The fallback path is incompatible with the production reserve action for JPEG files, causing a documented success path to fail before upload. This is a functional issue in the changed code.

Review comment:

- [P2] Avoid advertising JPEG fallback as uploadable — /workspaces/RecallMint/lib/media/upload.ts:259-262
  When fallback succeeds for a JPEG, this returns `mime: 'image/jpeg'`, but the real `reserveAsset` action only accepts `image/webp` or `image/png` (`z.enum(['image/webp', 'image/png'])`). In that scenario the new fallback path will always stop at `RESERVE_FAILED` instead of uploading the original file, so JPEG compression/validation failures do not get the intended recovery path; the tests miss this because the mocked reserve action accepts JPEG.