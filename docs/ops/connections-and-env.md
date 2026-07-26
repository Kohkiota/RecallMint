# 接続 / 環境変数の使い分け(運用)

> 本書は運用手順。**設計の理由は `docs/architecture.md`(H-1b で新設)を参照**。値の正本は `.env.example`(変数名)/ Supabase・Clerk・Stripe dashboard(実値)。**secret の実値は本書に書かない**。

## 1. DB 接続 2 系統(app / owner)

| 用途 | 変数 | role | port | 置き場 |
|---|---|---|---|---|
| アプリ runtime | `DATABASE_URL_APP` | `recallmint_app`(least-privilege・NOBYPASSRLS)| transaction pooler **6543** | Vercel env(prod scope=prod 値 / preview・stg scope=stg 値)/ ローカルは `.env.local`(基本 stg)|
| migration / operator script | `DATABASE_URL_ADMIN` | owner(postgres)| direct **5432** | **常設環境に置かない**。実行時 inline 供給 |

- **無印 `DATABASE_URL` は全廃**(参照ゼロ・grep 確認済)。必ず `_APP` / `_ADMIN` を使う。
- owner の inline 供給例: `DATABASE_URL_ADMIN='<owner 接続文字列>' pnpm db:migrate`。owner を要する script も同形(→ `scripts-and-seed.md`)。
- pooler は `prepare: false`(Supabase PgBouncer transaction mode の要件)。実装 = `lib/db/index.ts`(`getDb` = APP / `getAdminDb` = ADMIN / `getNonTenantDb` = APP・tenant context なし)。
- ※ owner の direct 5432 は Supabase 標準の direct connection 慣行 + devcontainer 常駐 PG(`test:iso`)の port と一致。実 port は Supabase dashboard で確認。

## 2. Supabase プロジェクト(stg / prod は別プロジェクト)

- stg / prod は**別 Supabase プロジェクト**(接続先が根本的に別)。
- project ref: **stg = `oxmbnzllwfalfgqjpssk` / prod = `wrxruoobnckfgeffpgfc`**(claude.ai 供給の識別子・正本 = Supabase dashboard。tracked repo には無い)。
- どちらに繋いでいるかは接続文字列の project ref で判別する(破壊操作前の env 目視の要点 → `scripts-and-seed.md`)。

## 3. RLS の適用順序(厳守・逆順禁止)

1. **functions**(drizzle migrate = `0025_rls_p2_functions.sql` 等)
2. **deploy**(push → 新コードが本番に乗る)
3. **policies**(`db/policies/*-enable.sql` を SQL Editor で適用)

- **逆順は P0RLS 事故**: 旧コード(context 未配線)× RLS-on = 全経路 P0RLS。必ず functions → deploy → policies。
- 詳細手順・適用後確認 SQL は `docs/ops/rls-p2-stg-runbook.md`(重複記述しない・本書はポインタ)。

## 4. RLS の検証は app-role 接続のみが正

- **SQL Editor / owner 接続は RLS を素通し**(false-green)。検証は app-role + tenant context でのみ成立。
- 毎回 `SELECT current_user` = `recallmint_app` を確認してから検証する(owner だと「動いた」が証明にならない)。

## 5. rollback(RLS policy 無効化)

- disable SQL 3 枚を **wave2 → wave1 → p2 の順**で適用。
- 実ファイル = `db/policies/{rls-p3-wave2,rls-p3-wave1,rls-p2}-disable.sql`(存在確認済)。
- 手順詳細は `docs/ops/rls-p2-stg-runbook.md` §3。

## 6. Stripe キーの使い分け

| 用途 | 変数 | prefix |
|---|---|---|
| アプリ runtime | `STRIPE_SECRET_KEY` | `rk_test_`(local/preview)/ `rk_live_`・`sk_live_`(prod・VERCEL_ENV=production で強制)|
| Test Clock 操作 | `STRIPE_TEST_CLOCK_SECRET_KEY` | `sk_test_` or `rk_test_`(`billing_clock_write` 権限付き。app の Restricted Key は通常この権限を持たない)|

- prefix 検証 = `lib/stripe/client.ts`(VERCEL_ENV-aware fail-fast)。
- **Stripe CLI**(webhook 転送)は `~/.config/stripe/config.toml` の CLI 専用 key を使い `.env.local` を参照しない(`stripe login` で設定・標準 CLI 挙動)。
- Test Clock 検証の運用は `docs/ops/stripe-test-clock-verify-runbook.md`(本書はポインタ)。
