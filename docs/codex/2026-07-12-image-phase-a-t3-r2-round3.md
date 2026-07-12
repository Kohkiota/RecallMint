# Codex independent review — image-phase-a-t3-r2-round3 (2026-07-12)

- **作成日**: 2026-07-12
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The R2 helpers mostly work, but HEAD verification is not actually bounded by the intended timeout under retryable R2 failures because aws4fetch's retry backoff is outside the abort signal.

Review comment:

- [P2] Disable aws4fetch retries for bounded HEAD timeout — /workspaces/RecallMint/lib/storage/r2.ts:40-45
  When R2 returns repeated 500/429 responses, `AwsClient.fetch` retries with exponential backoff sleeps that do not observe the `AbortSignal.timeout(10_000)` passed to `fetch`, so `headObject` can block well beyond the intended 10-second external API timeout before normalizing to `exists:false`. Configure this client/call with no retries or wrap the whole HEAD operation in a timeout so finalize paths do not stall during R2 outages.