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

---

## 5. migration 0032(S-5 旧経路撤去)— **不可逆**

§1-§4 は Phase A(新表の作成)の記録。本節は逆向き = 単一 invocation 経路への cutover 完了後に、**旧 prepare→publish 経路の schema を落とす** 0032 の適用手順。

### 5.0 前提(順序が効くのは 5.0.1 のみ — 新経路 GREEN 未確認のまま適用すると旧経路へ戻す手段が無くなる。5.0.2/5.0.3 は順序制約ではない)

| # | 前提 | 理由 |
|---|---|---|
| 5.0.1 | 新経路(S-1〜S-4 + I-3(b))が stg に deploy 済 + smoke pass 済 | 旧経路へ戻す手段が無くなるため、新経路が GREEN であることが唯一の安全網 |
| 5.0.2 | R2 の `users/*/src/` 一掃(`scripts/gc-src-prefix.ts`・dry-run → 本実行 → listing readback 0 件)。0032 の前後どちらでも実施可 | 順序は必須ではない。同 script は listing 駆動で DB を一切見ないため 0032 の前後どちらでも同様に動く。0032 より前に実施すると listing 結果を `source_assets.object_key` と突合できる、という弱い利点があるのみ |
| 5.0.3 | **手作業は不要**(0032 が同一 tx で処理する)。件数だけ見ておきたい場合は下記 SELECT | 旧 status(`awaiting_sources` / `claimed`)の行が非終端で残ったまま drop すると、どの gate / sweep / reconciler からも到達不能な dead row になる。**`scripts/gc-abandoned-operations.ts` では掃けない** — S-5 で同 script の非終端集合が `['prepared','processing']` に縮み、旧 status を候補にできないため(0 件を見て clean と誤認する)。ゆえに手順書でなく 0032 の 1 文目で構造的に閉じる |

### 5.0.4 事前観測(任意・read-only)

適用前に旧 status 行の件数を見ておきたい場合のみ。**掃除は 0032 が行うので UPDATE を手で流す必要はない**。

```sql
SELECT status, count(*) FROM upload_operations
WHERE status IN ('awaiting_sources','claimed') GROUP BY status;
```

### 5.1 適用(OT・ADMIN inline)

```sh
DATABASE_URL_ADMIN='<stg owner 接続文字列>' pnpm db:migrate
```

`0032_watery_scarlet_spider` が適用する 5 項目(SQL の順序も同じ):

1. **旧 status(`awaiting_sources` / `claimed`)の非終端 op を `terminal_failed` へ確定**(+ `prepared_payload` / `lease_expires_at` を NULL 化 + `last_error_code='legacy_path_removed'`)。列 drop より前に置く。対になる `source_documents` はここで触らない — `reconcileStaleProcessing` が 15 分超の processing doc を回収するため到達不能にならない
2. `asset_derivations.source_asset_id` **列 DROP**(`source_assets` への FK 本体。先に落とすことで次の DROP TABLE に CASCADE が要らない = 想定外の依存が残っていれば loud に失敗する)
3. `DROP TABLE source_assets`(RLS policy / grant は表と共に消える)
4. `upload_operations.next_retry_at` **列 DROP** + index `upload_operations_next_retry_idx` DROP(新経路に retryable 再開が無く dead。`attempt_count` / `last_error_code` は新経路も書くので**残す**)
5. `upload_operations.status` の **列 default を `'awaiting_sources'` → `'processing'`**(TS union から旧値が消えるため、列 default に頼る INSERT が union に無い値を書かないようにする)

**この時点から旧経路へは戻せない**(drop した行は復元不能・drizzle に down migration は無い)。

### 5.2 適用後確認 SQL(OT・SQL Editor)

```sql
-- 5.2.1 source_assets が存在しない
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name='source_assets';
-- 期待: 0 行

-- 5.2.2 asset_derivations.source_asset_id が存在しない
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='asset_derivations' AND column_name='source_asset_id';
-- 期待: 0 行

-- 5.2.3 upload_operations.next_retry_at が存在しない
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='upload_operations' AND column_name='next_retry_at';
-- 期待: 0 行

-- 5.2.4 upload_operations.status の列 default
SELECT column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='upload_operations' AND column_name='status';
-- 期待: 'processing'::text

-- 5.2.5 旧 status の行が残っていない(0032 の 1 文目が効いたことの確認)
SELECT count(*) FROM upload_operations WHERE status IN ('awaiting_sources','claimed');
-- 期待: 0
```

### 5.3 RLS oracle の追随(policy 再適用は不要)

`db/policies/ocr-2-4a-enable.sql` / `-disable.sql` は 2 表(`upload_operations` / `asset_derivations`)に縮んだ。**stg で再実行する必要はない** — drop した表の policy は表と共に消えており、残る 2 表の policy は不変。

`scripts/verify-rls-state.ts`(RLS 状態の readback ツール)の期待カタログも 1 表減っている(共通形 19 + users 3 = 22 policy / RLS 対象 20 表)。0032 適用後に走らせて finding 0 を確認すること。

**0032 未適用の環境(prod など)に向けると `source_assets` が「カタログ外の表が RLS on」として finding に出るのが正常**(表がまだ実在し RLS が有効なのに期待カタログから外れているため)。drift 検出としては正しい挙動なので、0032 適用前の実行ではこの 1 件を想定内として扱うこと。

### 5.4 Rollback

**無い**(不可逆)。incident 時は前方修正のみ。§3 の RLS DISABLE は残る 2 表に対しては引き続き有効。
