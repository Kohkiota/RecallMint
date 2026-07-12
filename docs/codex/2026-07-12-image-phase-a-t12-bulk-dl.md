# Codex independent review — image-phase-a-t12-bulk-dl (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new bulk download flow can be corrupted by the stale-download sweep for active jobs that exceed the fixed one-hour age threshold. This can leave users with a successful result but missing cached images.

Review comment:

- [P2] Avoid sweeping downloads that are still active after one hour — /workspaces/RecallMint/lib/media/sweep.ts:117-117
  For large decks or slow mobile networks, a legitimate `downloadDeckImages` run can last longer than one hour because assets are fetched sequentially, but `started_at` is never refreshed and the sweep does not coordinate with the per-exam download lock. If another tab runs `sweepStaleMedia` after that threshold, it deletes `added_asset_ids` and the job row while the download continues, so the original call can later report success with earlier cached blobs already removed.