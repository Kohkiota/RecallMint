# RLS-P1 実行 role 分離(`recallmint_app`)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(推奨)or `superpowers:executing-plans`。**本 plan は OT 承認までで停止**(spec→plan→codex-plan-review が今 sprint の scope。実装着手は OT の別 GO)。

**Goal:** runtime の DB 接続を owner から最小権限 role `recallmint_app` へ分離し、無印 `DATABASE_URL` を全廃する。

**Architecture:** `getDb()`=app role(`DATABASE_URL_APP`)/ 新 `getAdminDb()`=owner(`DATABASE_URL_ADMIN`、実行時供給)。grant は CRUD のみ + `ALTER DEFAULT PRIVILEGES` で将来 table を自動被覆。test:iso は code-under-test を app role で走らせ grant 不足を loud 検出、setup/reset は owner。

**Tech Stack:** PostgreSQL 17(Supabase prod)/ postgres-js(`prepare:false`)/ drizzle / vitest(`test:iso`)/ Vercel。

## Global Constraints(全 task に暗黙適用・spec より verbatim)

- role = `recallmint_app` `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` 非所有者。grant = `SELECT/INSERT/UPDATE/DELETE` のみ(TRUNCATE/REFERENCES/CREATE/DDL 禁止)。
- 無印 `DATABASE_URL` を読むコードを**ゼロ**にする。runtime=`DATABASE_URL_APP` / migration・operator=`DATABASE_URL_ADMIN`。
- guard(owner 判別 throw)は**作らない**(OT 決定)。owner URL 排除は「常設環境に無い」構造 + smoke で担保。
- 新 env 参照コードと**同 commit で `.env.example`** 更新(CLAUDE.md env 規律)。
- 完了 gate: whole-repo `pnpm lint`(--max-warnings=0)exit 0 + `pnpm test:iso` green(**app role 接続で**)。依存/config を触るため `pnpm typecheck` + `pnpm build` も exit 0。
- Supabase での role/grant/Vercel 変更は **OT 専権**(§OT 手順)。secret(password/owner URL)は commit しない。

---

### Task 1: grants SQL 正本 + ローカル role provisioning

**目的:** versioned grants file と、test:iso 用ローカル role を用意(以後の全 task の前提)。
**Files:** Create `db/roles/recallmint_app-grants.sql` / Modify `.devcontainer/pg-setup.sh`。
**制約:** grants file は password を含めない(commit 可)。`pg-setup.sh` の role 作成は冪等(`pg_roles` 存在チェック)。ローカル password は throwaway(`recallmint_app`)。owner 名は `postgres`(§open-2)。
**grants file 内容(全文・owner 実行前提):**
```sql
GRANT USAGE ON SCHEMA public TO recallmint_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recallmint_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recallmint_app;
```
**pg-setup.sh 追加(role のみ・grants は global-setup が DB 毎に適用):**
```sql
-- 冪等: 無ければ作る
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='recallmint_app')
  THEN CREATE ROLE recallmint_app LOGIN PASSWORD 'recallmint_app'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$;
```
**完了条件:** `pg-setup.sh` 再実行が冪等 exit 0 / `\du` に `recallmint_app`(No* 属性)/ grants file が commit 済 / test:iso は不変で green(まだ owner getDb)。

---

### Task 2: `lib/db` 二本立て accessor + placeholder rename

**目的:** `getDb()` を app role へ、owner 用 `getAdminDb()` を新設。
**Files:** Modify `lib/db/index.ts` / `vitest.setup.ts` / `.env.example`。
**制約:** `getDb()`→`DATABASE_URL_APP`、`getAdminDb()`→`DATABASE_URL_ADMIN`(各 lazy singleton・未設定時 throw)。`closeDb()` は両 client を close し両 singleton を null clear(scripts の 1 回呼びで足りる)。`vitest.setup.ts` は `DATABASE_URL_APP ??= 'postgresql://fake…'`。`.env.example` は `DATABASE_URL` 行を削除し `DATABASE_URL_APP=`(app pooler)+ `DATABASE_URL_ADMIN=`(owner・**実行時供給**の注記)を追加。
**制約(coupling):** 本 task 単独では test:iso の env-guard が旧 `DATABASE_URL` を set するため getDb が undefined になる。→ **Task 3 と連続実行し、間で test:iso を回さない(同一 review 単位)**。
**完了条件:** typecheck exit 0 / `getAdminDb` の unit 追加(env 未設定 throw・別 singleton)red 検証 / mock 済 unit suite green(getDb を mock する既存 test は不変)。

---

### Task 3: test:iso harness を app-role へ flip(setup=owner / query=app)

**目的:** code-under-test を `recallmint_app` で実行、setup/reset を owner に分離(論点3)。
**Files:** Modify `tests/integration/pg/setup/db-url.ts` / `env-guard.ts` / `global-setup.ts` / `fixture.ts` / `db-url.test.ts`。
**制約:** `db-url.ts` に `TEST_APP_DATABASE_URL='postgres://recallmint_app:recallmint_app@127.0.0.1:5432/recallmint_test'` 追加(`assertLocalTestDb` を通す=host/port/db 検査)。`hardSetTestDatabaseUrl()` は `process.env.DATABASE_URL_APP` へ代入。`global-setup.ts` は migrate 後に **grants file(Task 1)を owner で適用**(`recallmint_test` fresh DB に grant を張る)。`fixture.ts` の `truncateAllUserTables`/`seedTwoTenants` は owner 専用 client(`TEST_DATABASE_URL`)へ切替(getDb を使わない)。`db-url.test.ts` は新 var 名へ追随。
**完了条件:** `pnpm test:iso` 74 本 green(**code-under-test が recallmint_app 接続**)/ grant 不足があれば `42501 permission denied` で loud fail することを、grants file の 1 文を一時コメントアウトして手元で確認(red 検証・commit message に記録、確認後戻す)。Task 2+3 の合流で test:iso green を回復。

---

### Task 4: operator scripts + drizzle.config を owner(`DATABASE_URL_ADMIN`)へ

**目的:** owner を要する経路を `getAdminDb`/`DATABASE_URL_ADMIN` に載せ替え、無印 `DATABASE_URL` 参照を消す。
**Files:** Modify `drizzle.config.ts` / `scripts/seed-perf-exam.ts` / `scripts/gc-image-assets.ts` / `scripts/backfill-clerk-metadata.ts` / `scripts/backfill-card-asset-refs.ts`。
**制約:** `drizzle.config.ts` は `process.env.DATABASE_URL_ADMIN`。4 scripts は `getDb`→`getAdminDb`。`seed-perf-exam.ts` の L2 token guard が読む `process.env.DATABASE_URL`→`DATABASE_URL_ADMIN`(guard ロジック不変)。scripts の起動例コメントも `DATABASE_URL_ADMIN=…` へ。**この task 完了時点で `grep -rn "process.env.DATABASE_URL\b" lib app scripts drizzle.config.ts vitest.setup.ts tests` が 0 hit**。
**完了条件:** `grep` で無印 `DATABASE_URL` code 参照 0 hit を報告行に明記 / typecheck exit 0 / seed dry-run 相当が `DATABASE_URL_ADMIN` で従来どおり(実接続は OT、ここは型・参照整合まで)。

---

### Task 5: live runbook docs sweep

**目的:** 動く手順書の env 名を更新(凍結記録は据置)。
**Files:** Modify `README.md`(db:migrate / env 表)/ `docs/02-tech-spec.md` env 表 / `docs/architecture-guide.md` env 表 / `docs/audit/2026-07-16-seed-perf-exam-reseed-procedure.md` / `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md` / `.devcontainer/README.md`。
**制約:** operator 手順は `DATABASE_URL_ADMIN='…' <cmd>` の inline 供給形へ。runtime 言及は `DATABASE_URL_APP`。過去 "Neon" 表記は Supabase に是正。**session log / plan / 旧 spec / 本 spec 以外の audit の DATABASE_URL 言及は当時記録ゆえ触らない**。
**完了条件:** 上記 live doc に無印 `DATABASE_URL` の手順記載が残らない / `docs(_)` + `[no-review]` で commit。

---

### Task 6: 検証 + OT 実行 runbook 確定

**目的:** sprint gate 通過を確認し、OT が実環境へ反映する手順を確定。
**Files:** Create/Modify plan 内 §OT 手順(本 file)/ 完了報告。
**制約:** whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test:iso`(app role)全 exit 0。permission denied は `42501` で検出。
**完了条件:** 4 gate exit 0 を報告行に明記 / 下記 OT 手順が SQL 全文・Vercel 変更・順序・rollback 込みで揃う / open gate(§下)を OT へ提示して**停止**。

---

## OT 実行手順(実環境反映・OT 専権)

**前提 gate(自走しない):** Supavisor が custom role を受けるか(§未解決1)を **先に確認**。NG なら停止・報告。

1. **stg Supabase(SQL Editor)**:
   - `CREATE ROLE recallmint_app LOGIN PASSWORD '<強力な値>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`
   - `db/roles/recallmint_app-grants.sql` を実行(owner=postgres で)。
2. **Vercel(stg scope)**: `DATABASE_URL` を**削除** → `DATABASE_URL_APP` = app-role pooler URL(`recallmint_app.<project_ref>` 形式・pw)を追加。
3. **migration**: 以後 `DATABASE_URL_ADMIN='<owner pooler URL>' pnpm db:migrate`(inline 供給・常設 env に置かない)。
4. **stg smoke**: 通常操作一巡 + `SELECT current_user` = `recallmint_app` 確認 + operator script(GC dry-run)が `DATABASE_URL_ADMIN` で owner 動作。
5. **prod**: stg OK 後、OT 独自判断で 1–2 を prod scope に反復。
6. **rollback(即時)**: Vercel `DATABASE_URL_APP` を owner URL に戻すだけ(guard なし=構造的阻害なし)。

## 未解決論点(codex-plan-review 後・OT 判断で停止)

1. **[gate] Supabase Transaction Pooler(Supavisor)が custom LOGIN role `recallmint_app` を受けるか + username 形式**。NG = 唯一のブロッカー(direct 接続化の再検討)。OT/Context7 で裏取り、NG なら自走停止。
2. Supabase の table owner role 名が `postgres` か(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres` の前提)。異なれば grants file を訂正。
3. local dev は `.env.local` の `DATABASE_URL_APP` が指す project に role+grants 在ることに依存(rollout 順序の含意)。
