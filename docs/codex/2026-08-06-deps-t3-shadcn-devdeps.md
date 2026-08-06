# Codex independent review — deps-t3-shadcn-devdeps (2026-08-06)

- **作成日**: 2026-08-06
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The dependency classification change is consistent across package.json and the lockfile. Since the project already requires devDependencies such as Tailwind and PostCSS during its Vercel build phase, moving the build-only shadcn package does not introduce a new failure mode.