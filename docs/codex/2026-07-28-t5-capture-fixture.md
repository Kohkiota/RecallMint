# Codex independent review — t5-capture-fixture (2026-07-28)

- **作成日**: 2026-07-28
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The basic capture path and tests work, but the implementation can silently overwrite fixtures under concurrent execution and performs a paid API request before detecting predictable destination errors.

Full review comments:

- [P2] Reserve output paths without overwrite-capable rename — /workspaces/RecallMint/scripts/ai/ocr-capture-fixture.ts:115-116
  When two capture processes use the same fixture name concurrently, both can pass the preceding `existsSync` checks, and POSIX `renameSync` will replace an existing destination. The later process can therefore silently overwrite the earlier fixture despite the documented no-overwrite guarantee; use an exclusive reservation/write mechanism rather than a check followed by overwrite-capable renames.

- [P2] Validate the fixture destination before calling Gemini — /workspaces/RecallMint/scripts/ai/ocr-capture-fixture.ts:153-158
  When the name is unsafe or either destination file already exists, `runCapture` still loads the image and performs the paid, potentially 220-second Gemini request before `writeFixturePair` rejects it. Perform the name and destination checks before `callGeminiRaw` so predictable local input errors and duplicate captures fail without incurring an API call.