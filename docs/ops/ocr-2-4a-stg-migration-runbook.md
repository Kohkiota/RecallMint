# ②-4a stg DB 反映 Runbook(migration + grants + RLS policy)

**背景**: 4 回目 smoke で `relation "upload_operations" does not exist (42P01)` = ②-4a の migration が stg 未適用(開発中は test:iso の DB のみに適用していた)。**owner(postgres = `DATABASE_URL_ADMIN`)実行前提**。RLS の適用順(migrate → grants → policies)は spec §2.9 / test:iso global-setup が正本。

readonly 調査ベース(CC は stg に触れない)。実行は OT。

---

## 0. 前提確認(着手前)

| # | 確認 | 方法 | 期待 |
|---|---|---|---|
| 0.1 | Vercel stg scope に `DATABASE_URL_ADMIN`(owner)/ `DATABASE_URL_APP`(app-role)が設定済 | Vercel → Settings → Environment Variables(Preview scope) | 両方存在 |
| 0.2 | `0025_rls_p2_functions` が適用済(`app_current_user_id()` が存在)= RLS-P2 stg 反映済(2026-07-22 完了) | SQL Editor: `SELECT proname FROM pg_proc WHERE proname='app_current_user_id';` | 1 行。無ければ Step 1 の migrate が 0025 も一緒に適用する |
| 0.3 | **env 差分なし**: ②-4a は新規 env を導入していない(コードが読む env = `GEMINI_DAILY_LIMIT` / `VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_ENV` / `NODE_ENV` のみ。すべて既存 or Vercel 自動)。crop は R2(`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`)を使うが**画像フェーズ A で既出**。 | stg に R2_* + GEMINI_* が設定済か目視 | 設定済(画像フェーズ A 由来)。欠落なら追加 |

## 1. 適用順序(厳守・逆順禁止)

### Step 1 — migrate(OT・ADMIN inline)= テーブル作成
```sh
DATABASE_URL_ADMIN='<stg owner 接続文字列>' pnpm db:migrate
```
- `drizzle.config.ts` が `DATABASE_URL_ADMIN` を読む。inline 供給が `.env.local` を上書き(dotenv は既存 process.env を上書きしないため shell inline が勝つ)。
- **適用される ②-4a migration**(未適用分を drizzle が順に適用):
  - `0026_icy_dakota_north` = **source_assets** CREATE(1 upload:N ファイルの source 台帳)+ FK
  - `0027_yummy_trish_tilby` = **upload_operations** CREATE(冪等 upload/OCR 状態機械 ledger)+ FK
  - `0028_huge_colossus` = **asset_derivations** CREATE(crop provenance・PK=asset_id)+ FK
  - `0029_slow_tarantula` = source_assets の 5 列 nullable 化 + upload_operations.input_fingerprint DROP
  - `0030_messy_blazing_skull` = upload_operations に `expected_source_count` 追加
  - (0024=card_asset_refs は画像 GC で既適用の可能性。未適用なら一緒に適用される)
- **migration に RLS/POLICY/GRANT は含まれない**(P2 §2.9 踏襲・CREATE TABLE + FK のみ)。
- NG: permission denied → `DATABASE_URL_ADMIN` が owner でない。RLS 状態不変ゆえ失敗しても既存機能に影響なし(再実行するだけ)。

### Step 2 — grants 再適用(OT・SQL Editor・owner)= app-role が新表にアクセス可
`recallmint_app-grants.sql` は blanket `GRANT … ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES`。stg に DEFAULT PRIVILEGES が設定済(RLS-P2 由来)なら Step 1 で作成した新表は**自動 grant されている**が、**確実化のため再適用**(冪等)。
1. `db/roles/recallmint_app-grants.sql` 全文を貼付実行(base grant)。
2. **直後に** `db/roles/recallmint_app-grants-phase3.sql` 全文を貼付実行(非 RLS 5 表の REVOKE 縮小・**base → revoke の順固定**。逆順は REVOKE が無効化する)。
- phase3 の REVOKE 対象は RLS 非対象 5 表(contact_messages 等)のみで、②-4a 新表(RLS 対象)は触らない。

### Step 3 — RLS policy 適用(OT・SQL Editor・owner)= RLS on
`db/policies/ocr-2-4a-enable.sql` **全文**を貼付実行(実行直前に file 再確認)。3 表に `ENABLE ROW LEVEL SECURITY` + tenant policy(`FOR ALL TO recallmint_app` / `USING = WITH CHECK = user_id = (SELECT public.app_current_user_id())`)を作成。冪等(各 CREATE の前に DROP POLICY IF EXISTS)。
- p2 / wave1 / wave2 の enable は stg 適用済(RLS-P2〜Phase3 sprint)ゆえ**再適用不要。ocr-2-4a-enable.sql のみが新規**。

## 2. 適用後確認 SQL(Step 3 直後・OT・SQL Editor)

```sql
-- 2.1 テーブル存在(3 表)
SELECT tablename FROM pg_tables
WHERE tablename IN ('upload_operations','source_assets','asset_derivations') ORDER BY 1;
-- 期待: 3 行

-- 2.2 RLS 有効(relrowsecurity=t)
SELECT relname, relrowsecurity FROM pg_class
WHERE relname IN ('upload_operations','source_assets','asset_derivations') ORDER BY 1;
-- 期待: 3 行・全て relrowsecurity=t

-- 2.3 policy 存在(各表 1 本・recallmint_app 宛)
SELECT tablename, policyname, roles FROM pg_policies
WHERE tablename IN ('upload_operations','source_assets','asset_derivations') ORDER BY 1;
-- 期待: 3 行(source_assets_tenant / upload_operations_tenant / asset_derivations_tenant・roles={recallmint_app})

-- 2.4 GRANT(recallmint_app が 4 コマンド持つ)
SELECT
  has_table_privilege('recallmint_app','upload_operations','SELECT') AS uo_sel,
  has_table_privilege('recallmint_app','upload_operations','INSERT') AS uo_ins,
  has_table_privilege('recallmint_app','upload_operations','UPDATE') AS uo_upd,
  has_table_privilege('recallmint_app','upload_operations','DELETE') AS uo_del,
  has_table_privilege('recallmint_app','source_assets','SELECT') AS sa_sel,
  has_table_privilege('recallmint_app','asset_derivations','SELECT') AS ad_sel;
-- 期待: 全て t

-- 2.5 expected_source_count 列(0030)
SELECT column_name FROM information_schema.columns
WHERE table_name='upload_operations' AND column_name='expected_source_count';
-- 期待: 1 行
```

## 3. Rollback(incident 時)

RLS を即時 DISABLE(policy 定義は残置)して旧動作へ戻す想定だが、②-4a 用 disable file は未作成。必要時は SQL Editor で:
```sql
ALTER TABLE upload_operations DISABLE ROW LEVEL SECURITY;
ALTER TABLE source_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE asset_derivations DISABLE ROW LEVEL SECURITY;
```
（テーブル DROP は破壊ゆえしない。migration の rollback は drizzle 非対応 — 影響が出たら OT 判断）。

## 4. この後

Step 1-3 + §2 確認 → deploy に fix commit(`71c2e05` 以降)が含まれることを確認(smoke 手順書 §0)→ **4/5 回目 smoke 再開**。今回初めて prepareUpload → claim → stage → **publish** まで到達しうる(publish 到達で `71c2e05` の型 export fix と、2 回目 smoke の 300s maxDuration 再発有無を実環境で確認)。
