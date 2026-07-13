# Codex independent review — ios-webkit-t6-telemetry (2026-07-13)

- **作成日**: 2026-07-13
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The functional upload path still appears to work, but the new telemetry misclassifies fallback decode failures and omits the required reason for that scenario.

Review comment:

- [P2] Preserve decode failures in fallback telemetry — /workspaces/RecallMint/lib/media/upload.ts:357-357
  When fallback is attempted for a jpeg/png but `validateImageStructure` fails with `reason: 'decode_failed'`, this collapses the failure to `validation_failed` and, for a prior compression crash, the later code keeps reporting `compress_failed`. That means corrupt or undecodable originals cannot produce the required `decode_failed` telemetry reason, making these attach failures indistinguishable from unrelated compression failures.