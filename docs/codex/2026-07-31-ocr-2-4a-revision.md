# Codex independent review — ocr-2-4a-revision (2026-07-31)

- **作成日**: 2026-07-31
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The revised design leaves a TOCTOU window in which a finalized source object can be replaced, invalidating the server-verified fingerprint and dimensions used by later processing.

Review comment:

- [P1] Prevent source mutation after finalize — /workspaces/RecallMint/docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md:116-116
  If the presigned PUT URL remains valid after `finalize`, the client can overwrite the object after its hash and dimensions are recorded. Claiming then fingerprints the old hash while Gemini/crop reads new bytes, and the stored dimensions may produce an invalid crop. Make the finalized object immutable (for example, upload to a temporary key and promote conditionally) or revalidate the hash and dimensions when claiming before processing.