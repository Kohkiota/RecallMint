# Codex independent review — t3-shared-script-infra (2026-07-28)

- **作成日**: 2026-07-28
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The timeout wrapper can hang indefinitely when the SDK does not honor the abort signal, contradicting its intended behavior. The added tests and type checking otherwise pass.

Review comment:

- [P2] Race the SDK request against the timeout — /workspaces/RecallMint/scripts/ai/lib/gemini-raw.ts:66-66
  If the SDK ignores `abortSignal` and never settles, this `await` remains pending forever because aborting the controller does not itself reject `generateContent`. The post-await aborted check only handles a late resolution, so the advertised timeout is not enforced for a stuck request; race the request against a rejecting timeout promise.