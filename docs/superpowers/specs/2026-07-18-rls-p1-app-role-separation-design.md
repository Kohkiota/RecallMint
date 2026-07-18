# RLS-P1: 実行 role 分離(非所有者 `recallmint_app`)— 設計 spec

- 日付: 2026-07-18 / branch: `develop`
- 目的: アプリ runtime の DB 接続を「テーブル所有者(`postgres`)」から「最小権限の専用 role `recallmint_app`」へ分離する。**RLS 本体(P2)の前提部品**であり、role 単独でも **爆発半径制限**(DDL/TRUNCATE/policy 変更をアプリ経路から構造的に排除)の価値がある。
- **scope**: role 作成 + grants + 接続 URL 二本立て(runtime=app / migration・operator=owner)+ 追随箇所の全消し込み + test:iso 構造検証。**実装は本 spec の scope 外**(spec→plan→codex-plan-review で停止)。
- **非 goal**: RLS policy 有効化(P2)/ FORCE RLS / superuser 廃止 / owner role 自体の変更。**非所有者方式を維持**(FORCE RLS でなく、P2 で `recallmint_app` が policy に服する前提)。
- 関連: Perf-0(`docs/audit/2026-07-18-rls-performance-before-factfinding.md`)/ Iso-0(`docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md`)/ test-quality-audit §RLS。

---

## 0. 確定事項(OT 決定・再議論しない)

1. role = `recallmint_app`。`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`。**非所有者**。
2. grant = `SELECT / INSERT / UPDATE / DELETE` のみ。**TRUNCATE / REFERENCES / CREATE / DDL は与えない**。
3. **接続 URL 二本立て + 無印 `DATABASE_URL` 全廃**:
   - runtime(app)= **`DATABASE_URL_APP` のみ**を読む(`getDb()` 変更)。
   - migration / operator script(owner)= **`DATABASE_URL_ADMIN`**(明示名)。OT が保管場所から**実行時にのみ**供給、常設環境に置かない。
   - **無印 `DATABASE_URL` はいかなる経路も読まない状態にする**(「無印=フル権限」の慣習ごと廃止)。
4. **owner 判別 guard(throw)は不採用**(OT 決定)。owner URL 排除の担保 = 「**常設環境に owner URL が存在しない**」構造 + smoke での `current_user` 確認。
5. **常設環境から owner URL を全廃**: Vercel(stg/prod)= `DATABASE_URL` 削除 + `DATABASE_URL_APP` 追加。ローカル `.env.local` も変数名・中身とも更新。
6. Supabase での role 作成・password・grant の**実行は OT 専権**(SQL は CC 起案 / OT が SQL Editor 実行)。Vercel env 変更も OT 専権。stg で全検証 → prod は OT 独自判断。
7. rollback = **URL を旧に戻すだけで即復旧**(guard 不採用ゆえ構造的阻害なし)。

---

## 1. Step 0 事実(現物確認済 — 設計の接地)

| 項目 | 事実 | 設計含意 |
|---|---|---|
| sequence / serial / identity | **皆無**(全 PK は `gen_random_uuid()` UUID、PUBLIC) | **sequence USAGE grant 不要** |
| schema | `public` のみ(`CREATE SCHEMA` 0 hit) | grant は `ON ALL TABLES IN SCHEMA public` で足りる |
| runtime の DB 操作 | CRUD + advisory lock(`pg_try_advisory_xact_lock`/`hashtext`)+ `gen_random_uuid`。**DDL/TRUNCATE 皆無** | `SELECT/INSERT/UPDATE/DELETE` grant で完全(advisory/uuid は PUBLIC EXECUTE) |
| `__drizzle_migrations` | runtime access なし・migrate は owner | 当 table への grant 不要 |
| 現行の DB URL 読取口 | `getDb()`(`lib/db/index.ts`)/ `drizzle.config.ts` / scripts(getDb 経由)/ test harness / `vitest.setup.ts` が **全て `DATABASE_URL`** | 全消し込みが本 sprint 本体(§4) |
| Vercel cron / runtime 特権処理 | **なし**(`vercel.json` に cron なし・runtime に DDL/TRUNCATE なし) | runtime は app role で完結(owner を要する runtime 経路ゼロ) |
| Supabase pooler | pool size 15 は **(user,db) 毎**(Perf-0)→ `recallmint_app` は専用 15-pool を得る | 接続容量は独立(含意のみ) |
| table owner | ローカル=`postgres` / Supabase=`postgres`(要 OT 確認) | `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` の前提 |

---

## 2. 設計

### 2.1 role + grants(versioned SQL = `db/roles/recallmint_app-grants.sql`)

role 作成(cluster 級・1 回・OT 手動 or `pg-setup.sh`):
```sql
CREATE ROLE recallmint_app LOGIN PASSWORD '<supplied>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
```
grants(versioned・owner 実行・冪等):
```sql
GRANT USAGE ON SCHEMA public TO recallmint_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recallmint_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recallmint_app;
```
- sequence 文なし(§1)。`CONNECT` は PUBLIC 既定に依存(DB 名非依存に保つため明示しない)。
- role 作成の password は versioned file に**含めない**(OT 供給)。grants file は password を含まない = commit 可。

### 2.2 grant 欠落への 3 層防御(論点1「本 sprint 最大の罠」)

1. **構造(主)= `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`**: 以後 owner=postgres が migrate で作る全 table は自動 grant → **prod で「新 table permission denied」が構造的に発生しない**。前提 = migration は owner で流す(§0.3 の `DATABASE_URL_ADMIN`)。
2. **冪等再適用(副)= grants file の `GRANT ON ALL`**: test:iso は毎 run 適用(§2.4)。prod は out-of-band 作成時のみ OT 再適用(idempotent)。
3. **loud 検出(backstop)= test:iso を app role で実行**: app コードが grant set 外の権限(TRUNCATE/DDL/新関数/sequence 等)を要求したら **`permission denied` で test がローカルで落ちる**(stg より前)。
- 残余(owner 以外が作成した table)= 「migration は owner で流す」を前提として doc 化(§6 OT 手順)。

### 2.3 接続 URL scheme(無印 `DATABASE_URL` 廃止)

| accessor | 読む env | role | 使用者 |
|---|---|---|---|
| `getDb()`(`lib/db/index.ts`) | **`DATABASE_URL_APP`** | app | runtime(RSC/route/action)/ local dev / test の code-under-test |
| `getAdminDb()`(**新設**) | **`DATABASE_URL_ADMIN`** | owner | operator scripts(seed/GC/backfill) |
| `drizzle.config.ts` | **`DATABASE_URL_ADMIN`** | owner | `pnpm db:migrate` / `db:studio` |
| test harness(setup/truncate/seed) | ローカル定数 `TEST_DATABASE_URL`(owner・127.0.0.1) | owner | provision / migrate / TRUNCATE / seed |

- `getDb()` と `getAdminDb()` は別 export・別 memoized singleton。`closeDb()` は両 client を close(scripts は `closeDb()` 1 回で足りる)。
- 常設環境(Vercel/`.env.local`)は `DATABASE_URL_APP` のみ持つ。`DATABASE_URL_ADMIN` は OT が実行時に inline 供給(`DATABASE_URL_ADMIN='...' pnpm db:migrate`)。
- **rollback**: Vercel の `DATABASE_URL_APP` に owner URL を入れれば旧挙動へ即復旧(guard なし=構造的阻害なし・§0.7)。

### 2.4 test:iso 構造検証(論点3・二本立て配線)

- `pg-setup.sh`: `CREATE ROLE recallmint_app`(cluster 級・冪等・ローカル throwaway password)を追加。DB 再作成を跨いで role は残る。
- `db-url.ts`: `TEST_DATABASE_URL`(owner・現状維持)に加え `TEST_APP_DATABASE_URL`(= `postgres://recallmint_app:<local>@127.0.0.1:5432/recallmint_test`)を追加。`assertLocalTestDb` は host/port/db を見る(user 非依存)ため両 URL に適用可。
- `global-setup.ts`: owner で DROP/CREATE/migrate(現状)→ **migrate 後に grants file を owner で適用**(fresh DB に grant を張る)。
- `env-guard.ts` / `hardSetTestDatabaseUrl()`: `process.env.DATABASE_URL_APP = TEST_APP_DATABASE_URL`(getDb=app role で code-under-test を走らせる)。
- `fixture.ts`: `truncateAllUserTables` / `seedTwoTenants` を **owner 専用接続**(`TEST_DATABASE_URL` の別 client)へ切替。TRUNCATE が app role で通らない = 意図どおり(reset/seed は owner)。
- 効果 = **postcondition の DB 版**: grant set が app の全経路に十分かを 74 本が app role で検証。不足は permission denied で loud fail。

---

## 3. データフロー / role 境界(まとめ)

```
[Vercel runtime] --DATABASE_URL_APP--> getDb() --app role--> CRUD only (RLS-ready)
[OT: pnpm db:migrate] --DATABASE_URL_ADMIN(inline)--> drizzle-kit --owner--> DDL/migrate
[OT: operator script] --DATABASE_URL_ADMIN(inline)--> getAdminDb() --owner--> maintenance
[test:iso] setup/truncate/seed --TEST_DATABASE_URL--> owner ; code-under-test --TEST_APP_DATABASE_URL--> app role
```
- 常設環境に owner URL が**存在しない** = アプリ経路から DDL/TRUNCATE/policy 変更が構造的に不能(爆発半径制限)。

---

## 4. 追随箇所の全消し込み(sweep — 本 sprint 本体の一つ)

`DATABASE_URL` 全 grep 済。分類:

**A. code(必ず変更)**
- `lib/db/index.ts`: `getDb()`→`DATABASE_URL_APP` / `getAdminDb()`+`DATABASE_URL_ADMIN` 新設 / `closeDb()` 両対応。
- `drizzle.config.ts`: `DATABASE_URL`→`DATABASE_URL_ADMIN`。
- `scripts/seed-perf-exam.ts`(getDb→getAdminDb・L2 guard の `process.env.DATABASE_URL`→`DATABASE_URL_ADMIN`)/ `scripts/gc-image-assets.ts` / `scripts/backfill-clerk-metadata.ts` / `scripts/backfill-card-asset-refs.ts`(getDb→getAdminDb)。
- `vitest.setup.ts`: `DATABASE_URL ??= fake`→`DATABASE_URL_APP ??= fake`。
- test harness: `db-url.ts`(定数追加 + hard-set 先を `DATABASE_URL_APP`)/ `env-guard.ts` / `global-setup.ts`(grants 適用追加)/ `fixture.ts`(owner 接続化)/ `db-url.test.ts`(新 var へ追随)。

**B. env / config(コードと同 commit で)**
- `.env.example`: `DATABASE_URL=` を **削除** → `DATABASE_URL_APP=`(app)+ `DATABASE_URL_ADMIN=`(owner・実行時供給の注記)を追加。
- `.env.local`(gitignore・OT): `DATABASE_URL`→`DATABASE_URL_APP`(値=app-role URL)。**OT 作業**(role password が要るため)。
- `.devcontainer/pg-setup.sh`: role 作成追加。`post-create.sh` postcondition は local `postgres` 接続ゆえ `DATABASE_URL` 非依存(変更不要・要再確認)。

**C. live runbook docs(手順が動く)**
- `README.md`(db:migrate / env 表)/ `docs/02-tech-spec.md` env 表 / `docs/architecture-guide.md` env 表(現状 "Neon" 表記の陳腐化も同時是正)/ `docs/audit/2026-07-16-seed-perf-exam-reseed-procedure.md` / `docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md` / `.devcontainer/README.md`。→ operator が `DATABASE_URL_ADMIN` を inline 供給する形へ更新。

**D. 凍結記録(変更しない)**: 過去の session log / plan / spec / audit の DATABASE_URL 言及は当時状態の記録ゆえ据置(遡及改変しない)。

---

## 5. 検証計画

1. **test:iso 74 本 green（app role 接続で）** = grant set 十分性の loud gate。permission denied 検出 = grant 不足の証拠。
2. **whole-repo lint / typecheck / build exit 0**（scripts/config の型・参照整合)。
3. **stg smoke(OT push 後)**:
   - 通常操作一巡(upload→OCR→編集→復習→削除)が app role で成功。
   - `SELECT current_user` 相当で **runtime が `recallmint_app` で接続していること**を確認(owner URL 排除の担保 = §0.4)。
   - operator script(seed/GC dry-run)が `DATABASE_URL_ADMIN` 供給で従来どおり owner 動作。
4. **permission denied の検出方法**: postgres error code `42501`。test では throw を assert、stg では操作失敗 + server log。

---

## 6. OT 実行手順(plan で全文確定・本 spec は骨子)

1. **[gate] Supavisor が custom role を受けるか確認**(§7 open-1)。NG なら停止・報告。
2. stg Supabase: `CREATE ROLE recallmint_app ...`(password 設定)→ grants file 適用(SQL Editor)。
3. Vercel(stg scope): `DATABASE_URL` 削除 + `DATABASE_URL_APP`(app-role pooler URL)追加。
4. `pnpm db:migrate` は `DATABASE_URL_ADMIN='<owner>'` inline で実行(以後の migration も同形)。
5. stg smoke(§5.3)→ OK なら OT 独自判断で prod 反復(role/grants/Vercel prod scope)。
6. **rollback**: Vercel `DATABASE_URL_APP` を owner URL に戻す(即時)。

---

## 7. 未解決論点(停止して列挙)

1. **[gate] Supabase Transaction Pooler(Supavisor)が custom LOGIN role `recallmint_app` を受けるか + pooler username 形式（`recallmint_app.<project_ref>` か）**。受けない場合、app-role を pooler 越しに使えず direct 接続化(pooler 便益 + `prepare:false` 前提の再検討)が要る = **唯一の潜在ブロッカー**。→ Context7/Supabase docs + OT 確認。NG なら自走停止(§0 OT 指示)。
2. Supabase の table owner role 名が `postgres` であることの OT 確認(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres` の前提)。異なれば grants file の owner 名を訂正。
3. local dev(`pnpm dev`)は `.env.local` の `DATABASE_URL_APP` が指す Supabase project に `recallmint_app` + grants が在ることに依存 = role 作成前は local dev も app role で繋がらない(rollout 順序の含意)。
