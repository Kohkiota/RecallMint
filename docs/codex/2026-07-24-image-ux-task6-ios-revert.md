# Codex independent review — image-ux-task6-ios-revert (2026-07-24)

- **作成日**: 2026-07-24
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

Navigating away shortly after opening the viewer can leave the document body fixed and the PhotoSwipe instance alive because its opening animation rejects the cleanup's `close()` call.

Review comment:

- [P1] Release the scroll lock when unmounting during opening — /workspaces/RecallMint/components/media/use-image-zoom.ts:162-165
  If the component unmounts during PhotoSwipe's opening animation, the cleanup calls `close()`, but PhotoSwipe ignores `close()` while its opener is still opening. Consequently no `destroy` event fires, so the newly added fixed-body lock remains active indefinitely after navigation. The cleanup must force destruction or explicitly unlock the body when closing cannot complete.