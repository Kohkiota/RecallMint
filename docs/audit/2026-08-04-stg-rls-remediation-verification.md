# stg RLS 是正の実効検証 + prod 確認材料(read-only・調査のみ)

**日付**: 2026-08-04 / **範囲**: 実装・変更・commit なし。**prod には接続していない**。
**経緯**: 2026-08-04 の fact-finding で stg の `source_assets` / `upload_operations` / `asset_derivations` が **RLS 無効・policy 0 件**と判明(`docs/audit/2026-08-04-single-invocation-feasibility-factfinding.md` §0)。OT が `db/policies/ocr-2-4a-enable.sql` を SQL Editor(owner)で適用。**ledger に「適用済み・合格」と記録されていたが現物は未適用だった経緯があるため、本 doc は実出力を証跡として残す**。

---

## 1. stg 実効検証(app role 接続・検出時と同一手順)

**接続**: `DATABASE_URL_APP`(= `recallmint_app`)。**owner / SQL Editor では素通しになり検証にならない**ため使用しない。

### 1.1 修正前(2026-08-04・検出時の実測)

```
BEGIN; SELECT set_config('app.user_id','00000000-0000-0000-0000-000000000000',true);
  bogus_ctx_rows=2      -- source_assets: 他 user の行が読めた
  bogus_ctx_exams=0     -- exams: 正常
COMMIT;

-- 別 user context(85541b25)で upload_operations を読むと他 user の行が混在した
op_user_id=85541b25-51e9-44a3-8952-e383f98d4ae3 status=completed
op_user_id=2ac594a5-7965-4323-b47d-1057abb54c26 status=completed
op_user_id=2ac594a5-7965-4323-b47d-1057abb54c26 status=awaiting_sources

pg_class: RLS_OFF に asset_derivations / source_assets / upload_operations
RLS_ON_count=18 / policies_on_ocr_tables=0
```

### 1.2 修正後(本日・生出力そのまま)

```
=== who am I (app role であること) ===
  current_user  | current_database 
----------------+------------------
 recallmint_app | postgres
(1 row)

=== A. bogus context(無関係 user)= 検出時と同一手順 ===
BEGIN
                 ctx                  
--------------------------------------
 00000000-0000-0000-0000-000000000000
(1 row)

          tbl           | rows 
------------------------+------
 asset_derivations      |    0
 exams (対照・RLS 正常) |    0
 source_assets          |    0
 upload_operations      |    0
(4 rows)

COMMIT
=== B. 正しい context(実在 user 2ac594a5)= 自分の行は見えること ===
BEGIN
                 ctx                  
--------------------------------------
 2ac594a5-7965-4323-b47d-1057abb54c26
(1 row)

        tbl        | rows 
-------------------+------
 asset_derivations |    0
 exams (対照)      |    2
 source_assets     |    2
 upload_operations |    2
(4 rows)

COMMIT
=== C. 別 user context(85541b25)= 他 user の行が混ざらないこと ===
BEGIN
                 ctx                  
--------------------------------------
 85541b25-51e9-44a3-8952-e383f98d4ae3
(1 row)

               user_id                |  status   | count 
--------------------------------------+-----------+-------
 85541b25-51e9-44a3-8952-e383f98d4ae3 | completed |     1
(1 row)

 source_assets_rows 
--------------------
                  0
(1 row)

COMMIT
```

```
=== D. 構造 readback: 3 表の RLS + policy ===
      relname      | relrowsecurity | relforcerowsecurity 
-------------------+----------------+---------------------
 asset_derivations | t              | f
 source_assets     | t              | f
 upload_operations | t              | f
(3 rows)

     tablename     |        policyname        |      roles       | cmd | permissive |                                qual                                |                             with_check                             
-------------------+--------------------------+------------------+-----+------------+--------------------------------------------------------------------+--------------------------------------------------------------------
 asset_derivations | asset_derivations_tenant | {recallmint_app} | ALL | PERMISSIVE | (user_id = ( SELECT app_current_user_id() AS app_current_user_id)) | (user_id = ( SELECT app_current_user_id() AS app_current_user_id))
 source_assets     | source_assets_tenant     | {recallmint_app} | ALL | PERMISSIVE | (user_id = ( SELECT app_current_user_id() AS app_current_user_id)) | (user_id = ( SELECT app_current_user_id() AS app_current_user_id))
 upload_operations | upload_operations_tenant | {recallmint_app} | ALL | PERMISSIVE | (user_id = ( SELECT app_current_user_id() AS app_current_user_id)) | (user_id = ( SELECT app_current_user_id() AS app_current_user_id))
(3 rows)

=== E. 件数 sanity(drift test の期待カタログ = 21 表 / 23 policy) ===
 rls_on_tables | total_policies 
---------------+----------------
            21 |             23
(1 row)

=== F. RLS 無効のまま残る表(非対象 5 表であること) ===
       relname        
----------------------
 ai_usage
 clerk_events
 contact_messages
 integration_failures
 stripe_events
(5 rows)
```

### 1.3 判定

| 観点 | 修正前 | 修正後 | 判定 |
|---|---|---|---|
| bogus context で `source_assets` が読めるか | **2 行** | **0 行** | ✅ 是正 |
| bogus context で `upload_operations` / `asset_derivations` | 読めた | **0 行** | ✅ 是正 |
| 対照 `exams`(既 RLS) | 0 行 | 0 行 | ✅ 不変 |
| 正しい context で自分の行が見えるか | — | source_assets 2 / upload_operations 2 / exams 2 | ✅ 過剰遮断なし |
| 別 user context で他 user 行の混入 | 3 行中 2 行が他 user | **自分の 1 行のみ** | ✅ 是正 |
| policy 定義 | 0 件 | 3 件・`{recallmint_app}` / ALL / PERMISSIVE / qual=with_check=`TENANT_PRED` | ✅ 期待カタログ一致(runbook §12.2 の `TENANT_PRED` と文字列一致) |
| 件数 | 18 表 / 20 policy | **21 表 / 23 policy** | ✅ `tests/integration/pg/rls-drift.test.ts:166-169` の期待カタログ(21/23)と一致 |
| `relforcerowsecurity` | — | 全 `f` | ✅ 設計どおり(`db/policies/ocr-2-4a-enable.sql:2-3`「FORCE RLS はしない (owner bypass で seed/migrate/operator を素通し)」) |

**stg 是正 = 実効レベルで確認済み。**(owner 権限の script(`scripts/gc-image-assets.ts` / `gc-abandoned-operations.ts` = `getAdminDb()`)は FORCE 無しゆえ従来どおり素通し。app 経路は全て `withTenantTx` 配下 = 本 doc §3 の grep 結果参照。)

---

## 2. prod 確認(OT が prod SQL Editor で実行・CC は接続しない)

### 2.1 確認 SQL(read-only)

```sql
-- (1) 3 表が prod に存在するか
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('source_assets','upload_operations','asset_derivations')
ORDER BY 1;

-- (2) 存在する場合の RLS 状態
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('source_assets','upload_operations','asset_derivations')
ORDER BY 1;

-- (3) policy の有無
SELECT tablename, policyname, roles, cmd, permissive, qual, with_check
FROM pg_policies WHERE schemaname = 'public'
  AND tablename IN ('source_assets','upload_operations','asset_derivations')
ORDER BY 1;

-- (4) prod 全体の RLS flip 状況(適用要否の判定に必須)
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) AS rls_on_tables,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS total_policies;
```

### 2.2 判定表

| (1) の結果 | (4) の結果 | 意味 | 必要な行動 |
|---|---|---|---|
| **0 行** | — | 3 表が prod に無い(migration 0026-0030 未適用) | **適用不要**。将来 prod へ migrate する際に `ocr-2-4a-enable.sql` を同一セッションで適用する運用に載せる(runbook §8 の「policy は versioned SQL ゆえ migrate 経路から prod へ混入しない」= 手動適用が必須という裏返し) |
| 3 行 | `rls_on_tables = 0` | prod は RLS 自体が未 flip(P2/P3 も未適用) | **3 表だけ先行適用しない**。prod flip 資材に `ocr-2-4a-enable.sql` を**追加**する(runbook §8「prod 方針」/ §11.6「prod 適用成果物」の並びに 4 本目として) |
| 3 行 | `rls_on_tables = 18` かつ (2) が全て `f` | **stg と同じ取りこぼしが prod にも存在** | **即適用**。手順は runbook §1.3(Step 3 — policy 適用・SQL Editor・owner)と同型で、対象 file を `db/policies/ocr-2-4a-enable.sql` に読み替え。適用後に本 doc §1 と同じ app role 実効検証を prod で実施 |
| 3 行 | `rls_on_tables = 21` かつ (2) が全て `t` | 既に適用済み | 行動不要(§1 同型の実効検証だけ実施して証跡化) |

- **CC は prod DB に接続していない**。`.env.local` に prod 接続情報は存在せず(`DATABASE_URL_ADMIN` は空・`DATABASE_URL_APP` は stg を指す)、**prod の現状は不明**。
- prod 適用時の rollback = `db/policies/ocr-2-4a-disable.sql`(DISABLE のみ・policy 定義は残置ゆえ即時再 ENABLE 可)。runbook §3.1 と同型。
- 実効検証は **必ず app role 接続で**。SQL Editor(owner)は FORCE RLS を張っていないため**素通しし false-green になる**(`ocr-2-4a-enable.sql:2-3`)。

---

## 3. 検出の穴(最重要)

### 3.1 穴の所在(現物)

- `tests/integration/pg/rls-drift.test.ts:41-70` は 3 表を期待カタログに含む(`source_assets` / `upload_operations` / `asset_derivations`)。期待値は **21 表 / 23 policy**(`:166-169`)。
- しかし実行先は **local iso PG に固定**: `tests/integration/pg/setup/db-url.ts` の `assertLocalTestDb(TEST_APP_DATABASE_URL)`(`:44`)。
- runbook 自身も限界を明記済み(`docs/ops/rls-p2-stg-runbook.md:366`):
  > 「drift test は「repo の enable SQL ↔ **test DB**」の整合のみを検出する。**stg/prod で operator が手動適用した後に誰かが直接 policy を変更した「手動適用 drift」は test:iso では検出できない**」
- **今回はその想定より 1 段手前の失敗**だった: 「手動適用の**後**の drift」ではなく「**手動適用そのものが実施されなかった**」。runbook には ②-4a の 3 表に対する適用手順が**そもそも存在しない**(runbook 内に `ocr-2-4a` / `source_assets` / `upload_operations` / `asset_derivations` の言及 **0 件**)。§12.1(C) の期待値も **18 / 20 のまま**(21/23 に未更新)。
- → 穴は 2 層: **(a) runbook に ②-4a の適用手順が無い**(実施漏れの直接原因)/ **(b) 実 DB(stg/prod)を機械照合する経路が無い**(漏れても気づけない原因)。

### 3.2 塞ぐ手段の選択肢(実装コスト / 確実性・**設計判断はしない**)

| # | 手段 | 実装コスト | 確実性 | 備考 |
|---|---|---|---|---|
| A | runbook に ②-4a 節を追記 + §12.1(C) の期待値を 21/23 へ更新 | **極小**(doc のみ) | **低**(人手・実行忘れが今回の原因そのもの) | (a) は塞ぐが (b) は塞がない。最低限これは要る |
| B | `scripts/verify-rls-state.ts`(read-only)を新設。`--env-file` で接続先を指定し、**app role で bogus-context 実効検証 + 期待カタログ突合**を一括実行 | **中**(script 1 本。期待カタログは `rls-drift.test.ts` から共有 export して SSoT 化) | **中〜高**(実行すれば確実。実行自体は手動) | CC/OT がワンコマンドで stg/prod を検査できる。今回 CC が手打ちした SQL の製品化に相当 |
| C | B を定期自動実行(Vercel cron / 外形監視) | **高** | **高**(自動) | 現状 cron 0 本(`vercel.json` に `crons` 無し)。GHA は CLAUDE.md で不採用方針 = **方針衝突あり** |
| D | `/api/health/rls` 等の self-check endpoint(bogus context で 0 行を確認) | 中(route + 認可 + 誤検知設計) | 中(叩かれないと無意味) | 叩く仕組み(C)が別途要る |
| E | policy を drizzle migration 化(`db/policies/` の versioned SQL 方針を変更) | 中(方針変更 + 既存 3 wave の扱い) | **高**(migrate と同時に必ず適用 = 取りこぼしが構造的に起きない) | 現行方針と正面衝突: `ocr-2-4a-enable.sql:9-11`「policy は drizzle migration にしない (P2 §2.9 踏襲)…prod は operator 手動適用」。**方針変更ゆえ OT 判断** |
| F | 書込経路に canary(自分以外の行が見えたら loud alert) | 高 | 中(偽陽性リスク・常時コスト) | 既存 P0RLS alert は「tenant context 未設定」を検出するもので、**「context はあるが policy が無い」今回のケースは検出できない** |

### 3.3 塞げない場合の「証明の空白」記載案

正本 = `docs/architecture.md:129`「## 証明の空白(証明テストが無い不変条件・取り繕わない)」の表に 1 行追加(既存フォーマット = `| 空白 | 重さの所見 |`):

```markdown
| **stg/prod の実 RLS 状態と repo の enable SQL の一致**(§RLS)| 重。drift test(`rls-drift.test.ts`・期待 21 表/23 policy)は `assertLocalTestDb` で **local test DB 固定**ゆえ、stg/prod の未適用・手動 drift を構造的に検出できない。2026-08-04 に stg で `source_assets` / `upload_operations` / `asset_derivations` の **RLS 未適用**(ledger は「適用済み」と記録)を手動 SQL で偶然検出した実績あり。**手当て = operator の app role 実効検証**(bogus context で 0 行)を policy 適用直後および定期に実施(runbook §12.1)。自動化は未実装 |
```

---

## 4. ledger 是正(文面案・commit はしない)

**対象**: `.superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/progress.md:521`

**現行(事実と異なる)**:

```
stg DB: migration 0026-0030 + grants(base→phase3)+ RLS policy(ocr-2-4a-enable.sql)適用・runbook §2 検証SQL合格.
```

**誤りの内訳**(注記でなく置換すべき理由):
- 「RLS policy(ocr-2-4a-enable.sql)適用」= **事実でない**(2026-08-04 実測で `relrowsecurity=false` / policy 0 件)。
- 「runbook §2 検証SQL合格」= **二重に誤り**。runbook §2 は RLS-P2 の 5 表 / 7 policy を対象とする確認 SQL であり、**②-4a の 3 表を 1 つも含まない**(runbook 内に 3 表の言及 0 件)。ゆえにこの SQL が「合格」しても 3 表については何も証明しない。
- migration 0026-0030 適用と grants は**事実**(3 表が存在し `recallmint_app` に SELECT/INSERT/UPDATE/DELETE が付与済であることを 2026-08-04 に実測)。

**置換案**:

```
stg DB: migration 0026-0030 + grants(base→phase3)適用済(2026-08-04 実測: 3 表とも recallmint_app に CRUD grant あり)。
**RLS policy(ocr-2-4a-enable.sql)は本時点では未適用だった** — 当初この行は「適用・runbook §2 検証SQL合格」と記録していたが誤り(§2 は P2 の 5 表/7 policy 用で ②-4a の 3 表を含まないため、そもそも当該 SQL では 3 表を検証できない)。2026-08-04 の fact-finding が app role 接続で未適用を検出(bogus context で source_assets が 2 行読めた)→ OT が同日 ocr-2-4a-enable.sql を適用 → app role 実効検証で是正確認(bogus context 全 0 行 / 21 表 23 policy / qual=TENANT_PRED 一致)。証跡 = docs/audit/2026-08-04-stg-rls-remediation-verification.md。
教訓: 実 DB(stg/prod)の RLS 状態は test:iso の射程外(rls-drift.test.ts は assertLocalTestDb で local 固定)。適用の主張は **app role 接続の実効検証**を証跡として残すまで「合格」と書かない。
```

---

## 5. 不明(推測で埋めていないもの)

- **prod の 3 表の存在・RLS 状態** = 不明(CC は prod に接続していない・接続情報も持たない)。§2.1 の SQL を OT が実行して判定。
- 未適用がいつから続いていたか(適用が試みられて失敗したのか、実施自体がなかったのか)= **不明**(SQL Editor の実行履歴は repo に無い)。
- 未適用期間に app-role 経由で実際に他 tenant の行が読まれた事実の有無 = **不明**(app コードは全経路で `WHERE user_id` を持つため設計上は起きないが、ログからの事後確認手段は無い)。
