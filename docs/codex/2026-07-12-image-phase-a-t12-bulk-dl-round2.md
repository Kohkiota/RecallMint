# Codex independent review — image-phase-a-t12-bulk-dl-round2 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch mostly implements the new download flow, but the sweep liveness check can corrupt active downloads in environments without Web Locks because the fallback path always runs cleanup.

Review comment:

- [P2] Preserve live downloads when Web Locks are unavailable — /workspaces/RecallMint/lib/media/sweep.ts:117-130
  In browsers where `navigator.locks` is unavailable, `withWebLock` falls back to running the callback immediately, so this liveness probe always treats every `downloading` job as abandoned. If a second tab mounts and runs the startup sweep while another tab is actively downloading, this path deletes that job's `added_asset_ids` blobs and removes the job row, breaking the active download's progress/all-or-nothing behavior. Consider skipping download-job cleanup or retaining a time-based fallback when Web Locks cannot actually arbitrate liveness.