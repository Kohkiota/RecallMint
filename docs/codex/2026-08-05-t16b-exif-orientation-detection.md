# Codex independent review — t16b-exif-orientation-detection (2026-08-05)

- **作成日**: 2026-08-05
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new orientation classification works in the normal path, but its ordering causes rotated figures to be misclassified whenever the crop deadline has already expired.

Review comment:

- [P2] Classify unsupported orientation before deadline exhaustion — /workspaces/RecallMint/app/(app)/app/upload/_lib/upload-pipeline.ts:407-415
  When the crop budget is already exhausted, this check is never reached because the figure is first assigned `deadline_excluded`. Consequently, figures from an EXIF-rotated source are reported as being omitted due to a time limit rather than as `orientation_unsupported`, even though their orientation was known before the crop phase and they could never have been cropped. Check the source orientation before applying the crop-budget disposition so the new exclusion count remains accurate.