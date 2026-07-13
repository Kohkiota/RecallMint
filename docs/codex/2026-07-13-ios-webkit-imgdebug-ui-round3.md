# Codex independent review — ios-webkit-imgdebug-ui-round3 (2026-07-13)

- **作成日**: 2026-07-13
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The upload path still appears intact, but the new diagnostic UI misclassifies a key decode-failure fallback scenario it was introduced to distinguish.

Review comment:

- [P2] Treat fallback decode failures as corruption — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/image-telemetry-debug.tsx:56-58
  When `validateCompressionOutput` rejects the compressed blob with `reason === 'decode_failed'` but the original JPEG/PNG fallback succeeds, this branch only shows 🅰 if `outputIsBlank()` is true. A larger corrupt/undecodable WebKit output will therefore render the neutral fallback message, even though validation correctly rejected a broken compressed output, which undermines the A/B diagnosis this debug panel is meant to provide.