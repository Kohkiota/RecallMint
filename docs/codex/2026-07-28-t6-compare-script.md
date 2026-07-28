# Codex independent review — t6-compare-script (2026-07-28)

- **作成日**: 2026-07-28
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The primary documented two-stage arm A/B workflow cannot produce an A/B comparison and overwrites the first stage's results. This prevents the script from fulfilling a core purpose.

Review comment:

- [P1] Preserve arm A results when running arm B separately — /workspaces/RecallMint/scripts/ai/ocr-compare.ts:684-689
  When the documented batch-2 command uses `--arm B`, `results` contains only arm B entries, so `buildComparisons` cannot form any A/B pair; this run then overwrites the fixed report and JSON paths from the earlier arm A run. The resulting report says there are no comparison pairs and destroys the arm A data needed for the intended comparison. Merge the prior arm A results or write distinct outputs that can be compared together.