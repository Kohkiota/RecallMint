# RLS-P1 実行 role 分離 — 実装記録(Tasks 1-6)

- 日付: 2026-07-18 / branch: `develop`(未 push)
- spec: `docs/superpowers/specs/2026-07-18-rls-p1-app-role-separation-design.md` / plan: `docs/superpowers/plans/2026-07-18-rls-p1-app-role-separation.md`
- 方式: `superpowers:subagent-driven-development`(fresh implementer per task + review)。CLAUDE.md 準拠へ適応 = implementer は commit せず、controller が canonical(`requesting-code-review`)+ Codex review 後に commit。

## 結論
- **code 実装(Tasks 1-5)完了・review 通過・commit 済**。sprint gate 全 green。
- **runtime の stg/prod 有効化 + smoke は OT(Task 6 runbook・plan §OT 実行手順)** = 本 [reviewed] の runtime 検証窓。role 作成 / grants 適用 / Vercel env 変更は OT 専権。

## commit(range 起点 `64cac76`)
| commit | 内容 | tag |
|---|---|---|
| `c7ae8e1` | Task1: `db/roles/recallmint_app-grants.sql` + `pg-setup.sh` role provisioning | chore [no-review] |
| `ee341f2` | **Task2-4(folded): getDb=DATABASE_URL_APP / getAdminDb=DATABASE_URL_ADMIN / closeDb 両 close・test:iso app-role flip・role-privilege+index unit test・drizzle.config+scripts→ADMIN・無印 DATABASE_URL 全廃** | **feat [reviewed]** |
| `8cf89d5` | Codex review 4 周の raw findings | docs [no-review] |
| `d1842ce` | Task5: live runbook docs を新 env 名へ | docs [no-review] |
| (他) | plan open-gate 解消 / gitignore .superpowers | docs/chore [no-review] |

## review(Task2-4)
- canonical = `requesting-code-review`(general-purpose + `code-reviewer.md`・改変なし・read-only)+ Codex 独立 4 周。
- 収束: **Critical 0 / Important 0 / Minor 0**(Codex round 4)。道中 fix:
  1. `closeDb()` を `Promise.allSettled` 化(片方の `.end()` reject が他方 close を止めない・singleton は await 前に null)。
  2. plan 必須の `lib/db/index.test.ts` 追加(getAdminDb env 未設定 throw / 独立 singleton / closeDb 独立 close 回帰・mock で red 検証)。
  3. Task4 を fold in(commit の coherence: 無印 DATABASE_URL を読むコードを 0 に)。
  4. `recordIntegrationFailure` は実行文脈で接続選択(runtime=APP / script=ADMIN)、選択も `try` 内(throw も best-effort catch を通す)。
- test 追加は **保証増 → red 検証済**(role-privilege: owner 接続で current_user+6 negative の 7 assert が fail / index.test: closeDb 回帰が pre-fix で fail)。
- 実効権限の裏取り(local PG17.10): `__drizzle_migrations`=`drizzle` schema(over-grant なし)/ PUBLIC は `public` に CREATE 不可(app role は永続 DDL 不能)。

## gate(Task6)
- whole-repo `pnpm lint`(--max-warnings=0)exit 0 / `pnpm typecheck` exit 0 / `pnpm build` exit 0 / `pnpm test:iso` **85 passed**(code-under-test=recallmint_app)。full `pnpm test` 3769 green。

## OT 実行(plan §OT 実行手順・要点)
1. stg catalog-check(owner=postgres 確認)→ 2. `CREATE ROLE recallmint_app`(URL-safe 長 pw)+ grants file 適用 → 3. app URL 直接接続確認(pooler `recallmint_app.<ref>`・:6543・current_user・CRUD・negative)→ 4. Vercel 全 scope に `DATABASE_URL_APP` **追加**(無印はまだ残す=互換期間)→ 5. deploy + smoke(`current_user='recallmint_app'`)+ operator script は `DATABASE_URL_ADMIN` inline → 6. 無印 `DATABASE_URL` 削除 + `.env.local` を `DATABASE_URL_APP` へ → 7. prod 反復 → 8. rollback = `DATABASE_URL_APP` に owner URL 差替 + redeploy(互換期間中は code rollback も可)。

## Minor 据置(reviewers が harmless 判定)
- `role-privilege.test.ts` の relowner assert は provisioning の構造不変量(app コード回帰ではない)= 低 signal だが将来 owner 誤譲渡の catch として保持。
- `permissionSemanticsIn` の message 正規表現 fallback(SQLSTATE 42501 を優先評価するため実害低)。

## 未 push
本 session の全 commit は未 push(OT が push → stg 反映 → OT runbook 実行)。
