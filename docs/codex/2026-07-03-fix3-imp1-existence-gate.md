# Codex independent review — fix3-imp1-existence-gate (2026-07-03)

- **作成日**: 2026-07-03
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new unmount cleanup can duplicate the normal blur commit when unmount happens before the state update is reflected in the latest ref. This is a functional regression for realistic blur-then-unmount flows.

Review comment:

- [P2] Avoid re-committing after blur-before-unmount — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/inline-text-field.tsx:162-168
  When a dirty field blurs and the component is unmounted before React gets a chance to re-render, `setEditing(false)` has not yet updated `latestRef.current`, so this cleanup still sees `editing=true` and calls `commit` a second time. This can enqueue/send a duplicate `update_field` mutation in blur-then-navigation/removal scenarios; update the ref synchronously in `handleBlur` or otherwise mark the edit as already committed before the cleanup runs.