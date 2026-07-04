# Codex independent review — s2-1-app-shell-chrome (2026-07-04)

- **作成日**: 2026-07-04
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch introduces client-side relative time formatting for server-rendered markup, which can produce hydration mismatches around time boundaries. Otherwise the changes build and tests pass.

Review comment:

- [P2] Stabilize relative-time rendering across hydration — /workspaces/RecallMint/app/(app)/app/exams/[id]/_components/exam-detail-view.tsx:130-130
  Because this client component is still server-rendered before hydration, calling `formatRelativeJa(createdAt)`/`formatRelativeJa(updatedAt)` here evaluates `new Date()` once on the server and again in the browser. When hydration crosses a minute/hour/day boundary for either timestamp (common for a just-updated exam), the rendered text can differ and trigger a hydration mismatch/content jump. Pass a preformatted string or a stable `now` value from the server for the initial render.