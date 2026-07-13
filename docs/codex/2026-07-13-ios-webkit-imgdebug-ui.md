# Codex independent review — ios-webkit-imgdebug-ui (2026-07-13)

- **作成日**: 2026-07-13
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new diagnostic UI is wired through the final telemetry record, but successful fallback overwrites the exact rejected output metadata the UI was added to inspect. This makes the primary diagnostic scenario unreliable.

Review comment:

- [P2] Preserve rejected output metadata across fallback — /workspaces/RecallMint/lib/media/upload.ts:641-647
  When a validation failure on the compressed blob is followed by a successful original-image fallback, these lines overwrite the `t.output` captured from `ValidationFailedError` with the fallback file's metadata. In the intended `?imgdebug=1` iPad diagnostic path, this hides the rejected compressed output bytes/dimensions (for example the 856 B/empty blob case), so the debug panel cannot distinguish compression corruption from validation mis-rejects for JPEG/PNG inputs where fallback succeeds.