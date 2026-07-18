# RLS-P1 実行 role 分離(`recallmint_app`)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(推奨)or `superpowers:executing-plans`。**本 plan は OT 承認までで停止**(実装着手は OT の別 GO)。

**Goal:** runtime の DB 接続を owner から最小権限 role `recallmint_app` へ分離し、無印 `DATABASE_URL` を全廃する。

**Architecture:** `getDb()`=app role(`DATABASE_URL_APP`)/ 新 `getAdminDb()`=owner(`DATABASE_URL_ADMIN`、実行時供給)。grant は table CRUD + schema USAGE のみ。`ALTER DEFAULT PRIVILEGES` で将来 table を自動被覆。test:iso は code-under-test を app role で走らせ、**positive(CRUD 可)+ negative(DDL/TRUNCATE 不可)+ current_user 恒久 assert** で最小権限を構造検証。setup/reset は owner。

**Tech Stack:** PostgreSQL 17.10(Supabase prod=17)/ postgres-js(`prepare:false`)/ drizzle / vitest(`test:iso`)/ Vercel。

## Global Constraints(全 task 暗黙適用・spec verbatim)

- role `recallmint_app` `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` 非所有者。grant = table `SELECT/INSERT/UPDATE/DELETE` + schema `USAGE`(補助として必須)のみ。TRUNCATE/REFERENCES/CREATE/DDL 禁止。
- 無印 `DATABASE_URL` を読むコードを**ゼロ**に(実行可能経路 0。凍結 docs の言及は据置可)。runtime=`DATABASE_URL_APP` / migration・operator=`DATABASE_URL_ADMIN`。
- guard(owner 判別 throw)は作らない(OT 決定)。owner URL 排除は「常設環境に無い」構造 + smoke の `current_user` で担保。
- 新 env 参照コードと**同 commit で `.env.example`**。secret(password/owner URL)は commit しない。
- 完了 gate: whole-repo `pnpm lint`(--max-warnings=0)/ `pnpm typecheck` / `pnpm build` / `pnpm test:iso`(app role)全 exit 0。
- Supabase の role/grant/Vercel 変更は **OT 専権**。

## 実効権限の事実(local PG17.10 で確認済・設計前提)

- `__drizzle_migrations` は **`drizzle` schema**(public 外)→ `ON ALL TABLES IN SCHEMA public` は付与せず、app role は USAGE なしで触れない(over-grant なし)。
- PG15+ 既定で **PUBLIC は `public` に CREATE を持たない**(`has_schema_privilege('public','public','CREATE')=f`)→ app role は永続 table を作れない(blast-radius 成立)。PUBLIC の `TEMP`(session-local・良性)と `USAGE` は残る(TEMP の全体 REVOKE は Supabase 全体影響ゆえ scope 外)。
- user-defined / SECURITY DEFINER function は無し(migration に `CREATE FUNCTION` 0)→ PUBLIC EXECUTE leak は組込関数のみ(必要・良性)。
- **stg/prod は Supabase 差分があり得る**ため、上記 3 点は §OT 手順の catalog-check(`has_*_privilege`)で実環境再確認する。

---

### Task 1: grants SQL 正本 + ローカル role provisioning

**目的:** versioned grants file と test:iso 用ローカル role を用意(全 task の前提)。
**Files:** Create `db/roles/recallmint_app-grants.sql` / Modify `.devcontainer/pg-setup.sh`。
**制約:** grants file は password 非包含(commit 可)。owner 名=`postgres`(§OT catalog-check で確定)。`pg-setup.sh` の role 作成は冪等 + **既存 role は属性を矯正**(`ALTER ROLE` で No* 再適用・membership 検査コメント)。ローカル pw は throwaway。
**grants file 全文(owner 実行):**
```sql
GRANT USAGE ON SCHEMA public TO recallmint_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recallmint_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recallmint_app;
```
**pg-setup.sh 追加:**
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='recallmint_app')
    THEN CREATE ROLE recallmint_app LOGIN PASSWORD 'recallmint_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE ALTER ROLE recallmint_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS LOGIN;
  END IF; END $$;
```
**完了条件:** `pg-setup.sh` 再実行が冪等 exit 0 / `\du recallmint_app` が No* 属性・membership 空 / grants file commit / test:iso 不変で green。

---

### Task 2: `lib/db` 二本立て accessor + placeholder rename

**目的:** `getDb()`=app role、owner 用 `getAdminDb()` 新設。
**Files:** Modify `lib/db/index.ts` / `vitest.setup.ts` / `.env.example`。
**制約:** `getDb()`→`DATABASE_URL_APP`、`getAdminDb()`→`DATABASE_URL_ADMIN`(各 lazy 別 singleton・未設定 throw)。`closeDb()` は両 client close + 両 singleton null。`vitest.setup.ts`→`DATABASE_URL_APP ??= 'postgresql://fake…'`。`.env.example` は `DATABASE_URL` 行削除 → `DATABASE_URL_APP=`(app)+ `DATABASE_URL_ADMIN=`(owner・**実行時供給**注記)。
**coupling:** 本 task 単独では test:iso の env-guard が旧 var を set し getDb=undefined。→ **Task 3 と連続実行、間で test:iso を回さない(同一 review 単位)**。
**完了条件:** typecheck exit 0 / `getAdminDb` unit(env 未設定 throw・app とは別 singleton)red 検証 / mock 済 unit suite green。

---

### Task 3: test:iso harness flip + 最小権限の構造検証

**目的:** code-under-test を app role 実行、setup/reset を owner 分離、最小権限を positive/negative/current_user で証明(Codex 反映)。
**Files:** Modify `tests/integration/pg/setup/db-url.ts` / `env-guard.ts` / `global-setup.ts` / `fixture.ts` / `db-url.test.ts` / Create `tests/integration/pg/role-privilege.test.ts`。
**制約:** `db-url.ts` に `TEST_APP_DATABASE_URL='postgres://recallmint_app:recallmint_app@127.0.0.1:5432/recallmint_test'`(`assertLocalTestDb` を通す)。`hardSetTestDatabaseUrl()` は `process.env.DATABASE_URL_APP` へ代入。`global-setup.ts` は migrate 後に grants file を owner で適用。`fixture.ts` の truncate/seed は **harness ローカルの owner `postgres()` client**(`TEST_DATABASE_URL`)を新設して使う(`getAdminDb` を使わない=`closeDb()` の両閉じと干渉させない・teardown で自前 `.end()`)。
**新 assert(role-privilege.test.ts):** app 接続で ① `current_user='recallmint_app'`(恒久・env 退行検知)② 各 business table の `relowner<>'recallmint_app'` ③ **negative**: `CREATE TABLE public.x()` / `TRUNCATE <table>` / `ALTER TABLE` / `DROP TABLE` / `CREATE POLICY` / `SET ROLE postgres` が `42501`(or 権限 error)で失敗 ④ **positive**: business table への CRUD 成功。
**完了条件:** `pnpm test:iso` green(code-under-test=recallmint_app)/ 新 assert は **保証増ゆえ red 検証**(grants file の該当行を一時除去 or role を owner に差し替えると fail する実証・commit message に「red 検証」記録)+ 主張正確性の簡易 review。

---

### Task 4: operator scripts + drizzle.config を owner へ + 無印全消し

**目的:** owner 経路を `getAdminDb`/`DATABASE_URL_ADMIN` に載せ替え、無印 `DATABASE_URL` の実行可能経路を消す。
**Files:** Modify `drizzle.config.ts` / `scripts/seed-perf-exam.ts` / `scripts/gc-image-assets.ts` / `scripts/backfill-clerk-metadata.ts` / `scripts/backfill-card-asset-refs.ts` / `package.json`(script 内 env 言及あれば)。
**制約:** `drizzle.config.ts`→`DATABASE_URL_ADMIN`。4 scripts は `getDb`→`getAdminDb`。`seed-perf-exam.ts` の L2 token guard が読む env→`DATABASE_URL_ADMIN`(ロジック不変)。起動例コメントも `DATABASE_URL_ADMIN=…`。**広域 grep で追随漏れ検査**: `grep -rn "DATABASE_URL\b" .`(node_modules/.git/凍結 docs 除く)で `process.env.DATABASE_URL` / package.json / `.devcontainer` / shell に無印の**実行経路**が残らないこと(GHA は不採用ゆえ workflow 対象外)。
**完了条件:** 「無印 `DATABASE_URL` の実行可能経路 0 hit」を報告行に明記 / typecheck exit 0。

---

### Task 5: live runbook docs sweep

**目的:** 動く手順書の env 名更新(凍結記録は据置)。
**Files:** Modify `README.md`(db:migrate / env 表)/ `docs/02-tech-spec.md` env 表 / `docs/architecture-guide.md` env 表 / `docs/audit/2026-07-16-seed-perf-exam-reseed-procedure.md` / `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md` / `.devcontainer/README.md`。
**制約:** operator 手順は `DATABASE_URL_ADMIN='…' <cmd>` 供給形。runtime 言及は `DATABASE_URL_APP`。"Neon" 表記は Supabase に是正。**session log / plan / 旧 spec / 他 audit の言及は当時記録ゆえ触らない**。
**完了条件:** live doc に無印 `DATABASE_URL` の手順が残らない / `docs(_)` + `[no-review]` commit。

---

### Task 6: 検証 + OT runbook 確定 + 停止

**目的:** gate 通過確認と OT 反映手順の確定、open gate 提示で停止。
**制約:** whole-repo `pnpm lint` / `typecheck` / `build` / `test:iso`(app role)全 exit 0。permission denied=`42501`。
**完了条件:** 4 gate exit 0 を報告 / 下記 OT 手順が揃う / open gate を OT へ提示して**停止**。

---

## OT 実行手順(実環境反映・OT 専権)

**前提 gate(自走しない):** §未解決1(Supavisor が custom role を受けるか)を先に確認。NG なら停止・報告。

1. **stg Supabase catalog-check(反映前)**: table owner role 名 = `postgres` か(`SELECT relowner::regrole FROM pg_class …`)/ `has_schema_privilege('public','public','CREATE')` = f か / user-defined SECURITY DEFINER function 有無。差分あれば grants file / 前提を訂正。
2. **role + grants(SQL Editor, owner=postgres)**: `CREATE ROLE recallmint_app LOGIN PASSWORD '<強 pw>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`(既存なら `ALTER ROLE` で属性矯正 + membership 検査)→ `db/roles/recallmint_app-grants.sql` 適用。**pw は英数字のみ・長め(例 32+ 桁)で生成すれば URL encode 不要**(生 URL 連結で壊れない)。pw の生成/保管/rotation/stg・prod 分離は OT 管理。
3. **app URL 直接接続確認(pooler 経由)**: username `recallmint_app.<project_ref>`、**host は Supabase dashboard の Connection → Transaction pooler からコピーした実値**(例 `aws-1-ap-northeast-1.pooler.supabase.com`)を使う。① login ② `current_user='recallmint_app'` ③ CRUD + advisory lock 動作 ④ negative(CREATE/TRUNCATE 失敗)⑤ `prepare:false` 適合 ⑥ pool(15/(user,db))が owner 系と分離。
4. **Vercel env 追加(先)**: 全 scope(Production/Preview/Development)に `DATABASE_URL_APP`(app-role pooler URL、**ポート 6543 = transaction mode・現行 runtime の無印 DATABASE_URL と同一**)を**追加**。無印 `DATABASE_URL` は**まだ消さない**(互換期間)。
5. **新コード deploy → stg smoke**: 通常操作一巡 + `current_user='recallmint_app'`(OT が app creds で psql 実行。runtime 診断 endpoint は恒久追加しない)+ operator script(GC dry-run)が `DATABASE_URL_ADMIN='<owner>'` inline で owner 動作。
6. **無印 `DATABASE_URL` 削除(後)**: smoke OK 後に全 scope から削除 → 再 deploy/再確認。ローカル `.env.local` も `DATABASE_URL`→`DATABASE_URL_APP`(値=app URL)へ(OT 作業=pw 要)。
7. **prod**: stg 完了後 OT 独自判断で 1–6 を prod scope に反復(prod catalog-check・app URL 確認・smoke 含む)。
8. **rollback(2 種・redeploy 要ゆえ即時でなく短時間)**: ① credential rollback = `DATABASE_URL_APP` を owner URL に差替 + 再 deploy(分離を一時破棄・incident 扱い/期限/事後再分離を記録)② code rollback = 旧版 redeploy。旧版は無印 `DATABASE_URL` を読むため、**互換期間(手順4–6 の間)は無印を残す**ことでコード rollback を可能に保つ。

## Codex cross-check 反映(`docs/codex/2026-07-18-plan-rls-p1-app-role.md`)

**反映済**: 実効権限(PUBLIC leak)の catalog-check(手順1)/ negative + current_user 恒久 assert(Task 3)/ rollout 順序=APP 追加→deploy→smoke→無印削除(手順4–6)/ rollback 2 種の厳密化(手順8)/ .env.local を明示手順化(手順6)/ Vercel 全 scope(手順4)/ grep 広域化(Task 4)/ pooler gate 拡張(手順3)/ password 運用注記(手順2)/ 既存 role 属性矯正(Task 1)。
**scope 外として据置(理由付き)**: PUBLIC `TEMP` の全体 REVOKE(Supabase 全体影響・TEMP は良性)/ operator を owner 統一(確定事項3・専用保守 role 分離は後続)/ __drizzle_migrations 個別除外(既に `drizzle` schema で対象外)。

## 未解決論点(codex-plan-review 後・OT 判断で停止)

1. ~~[gate] Supavisor が custom role を受けるか~~ **解消済(claude.ai 裏取り 2026-07-18)**: Supabase 公式が service ごとの専用 role 作成を推奨(postgres/roles docs)/ username 形式 `recallmint_app.<project_ref>` で pooler 接続可(公式 troubleshooting + community 実証)。実装着手可。反映済 = 手順2/3/4。実接続確認は手順3の①–⑥で行う(念のための実証)。
2. Supabase の table owner role 名 = `postgres` の確認(手順1)。異なれば grants の `FOR ROLE` を訂正。
3. local dev は `.env.local` の `DATABASE_URL_APP` が指す project に role+grants 在ることに依存(rollout 順序の含意)。
