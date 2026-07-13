# Codex independent review — ios-webkit-imgdebug-ui-round2 (2026-07-13)

- **作成日**: 2026-07-13
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The functional upload path still tests cleanly, but the newly added diagnostic UI can misclassify a key failure mode it was introduced to distinguish.

Review comment:

- [P2] Treat decode failures as compression-side corruption — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/image-telemetry-debug.tsx:56-58
  When `validateCompressionOutput` rejects a compressed blob with `reason === 'decode_failed'` and the blob is larger than 2 KB, a JPEG/PNG fallback can still succeed, but this branch only reports 🅰 when `outputIsBlank()` is true. The debug panel then shows a neutral fallback message instead of identifying that validation correctly rejected an undecodable compressed output, which undermines the intended A/B diagnosis for large corrupt WebKit outputs.