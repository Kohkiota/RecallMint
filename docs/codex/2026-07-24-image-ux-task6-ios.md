# Codex independent review — image-ux-task6-ios (2026-07-24)

- **作成日**: 2026-07-24
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The scroll-lock implementation is covered by passing tests, but the global viewport change introduces unsafe-area regressions outside PhotoSwipe on notched iOS devices.

Review comment:

- [P1] Preserve safe-area padding for the rest of the application — /workspaces/RecallMint/app/layout.tsx:70-70
  On notched iOS devices, `viewportFit: 'cover'` expands the entire application into the unsafe screen regions, not just PhotoSwipe. The added CSS compensates only `.pswp__top-bar`, so ordinary page headers, controls, and content can now render beneath the notch or home indicator, especially in landscape. Add safe-area handling to the application shell as well as the modal before enabling this globally.