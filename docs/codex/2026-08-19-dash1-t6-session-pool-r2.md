# Codex independent review — dash1-t6-session-pool-r2 (2026-08-19)

- **作成日**: 2026-08-19
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The new exam resolution path makes valid server-backed study sessions depend on the Dexie exams mirror already being populated. This breaks a common fresh-client or stale-mirror scenario despite successful server card retrieval.

Review comment:

- [P1] Preserve valid URL exams when the local mirror is empty — /workspaces/RecallMint/app/(app)/app/study/smart/_components/study-session-host.tsx:60-66
  On a fresh browser, cleared IndexedDB, or incomplete exam pull, this query resolves to `[]` even when `?exam=` identifies a valid server-side exam and `page.tsx` has already fetched its cards. Passing only these mirrored IDs to `useSelectedExam` makes it reject the URL exam (and potentially remove it), so the host discards the valid server cards and shows an empty session. The authoritative server result or URL exam needs to remain usable when the local exam mirror has not populated yet.