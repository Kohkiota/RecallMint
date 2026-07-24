# Codex independent review — image-ux-z2-escape-fix (2026-07-24)

- **作成日**: 2026-07-24
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The normal Escape isolation behavior works, but an initialization exception leaks a global capture listener that suppresses Escape throughout the application.

Review comment:

- [P2] Remove the Escape listener when initialization fails — /workspaces/RecallMint/components/media/use-image-zoom.ts:241-243
  If `pswp.init()` throws—for example due to malformed image data or an unexpected PhotoSwipe initialization error—the `finally` block only resets `openingRef`, leaving this window capture listener installed. Subsequent Escape presses are then prevented from reaching the rest of the application until the hook unmounts, and `pswpRef` also prevents retrying `open`; clean up the listener and instance on this failure path.