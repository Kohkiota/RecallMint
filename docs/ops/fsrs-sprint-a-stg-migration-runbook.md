# FSRS 整合 Sprint A — stg 適用 Runbook(migration 0034 / 0035 + grants + RLS policy)

**対象**: `develop` の `0596807`〜(T1)〜 docs までを stg へ反映する際の DB 手順。**owner(postgres = `DATABASE_URL_ADMIN`)実行前提**。実行は OT、CC は readonly 調査のみ。

設計の正 = `docs/superpowers/specs/2026-08-11-fsrs-consistency-sprint-a-design.md`(凍結)。実施記録 = `docs/superpowers/sessions/2026-08-12-fsrs-consistency-sprint-a.md`。

---

## 0. この runbook が存在する理由(先に読む)

本 sprint の 2 本の migration は、**どちらも「適用したら戻せない」性質**を別々の理由で持つ。順序を誤ると app が壊れるか、無防備窓ができる。

| migration | 性質 | 効く順序制約 |
|---|---|---|
| `0034_lazy_retro_girl` | **後方非互換**。cards の FSRS 列 11 本から `DEFAULT` を落とす(+ `stability`/`difficulty` を `double precision` 化 + `state` に CHECK) | **code deploy → migration apply**。旧 code は列 default に依存して card を作るため、**先に migration を当てると card 作成が壊れる**。かつ**適用後の code rollback も card 作成を壊す**(戻す先の code が default に依存しており、その default はもう無い) |
| `0035_overconfident_the_phantom` | **表の DROP/CREATE**。`answer_events` を作り直し、`reviews` / `study_sessions` を DROP、`study_days` を TRUNCATE | **policy と grant が表と一緒に落ちる**。`migrate → grants → wave1-enable → verify-rls-state` を**同一メンテ窓で連続実行**すること(間に窓を空けると、その間 `answer_events` は RLS 無効 = テナント隔離なしで存在する) |

**ユーザー 0 前提**: 既存の復習データは全捨てで OT 承認済み(spec §10)。`study_days` も TRUNCATE される。stg/prod とも実データ保護は不要。

---

## 1. 適用前確認(着手前・read-only)

| # | 確認 | 方法(owner 接続 / SQL Editor) | 期待 / NG 時 |
|---|---|---|---|
| 1.1 | **`cards.state` に 0-3 以外が無い** | `SELECT DISTINCT state FROM cards ORDER BY 1;` | 期待 = 0〜3 のみ(空でも可)。**範囲外が 1 行でもあると 0034 の `ADD CONSTRAINT cards_state_range` が 23514 で中断する**。中断は安全側に倒れる(下記 ★)が、原因データを直すまで migration は 1 mm も進まないので先に見ておく |
| 1.2 | 現在の migration 到達点 | `SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3;` | 0033 まで適用済であること。0034/0035 が既にあれば本手順は不要 |
| 1.3 | `DATABASE_URL_ADMIN`(owner)/ `DATABASE_URL_APP`(app-role)が stg scope に設定済 | Vercel → Settings → Environment Variables(Preview scope) | 両方存在 |
| 1.4 | **新規 env なし**の確認 | 本 sprint は env を追加していない | `.env.example` 差分ゼロ |

---

## 2. 適用順序(厳守)

### Step 0 — **先に code を deploy する**

`0034` は後方非互換(上表)。**app deploy が先**。deploy 完了(新 code が stg で稼働中)を確認してから Step 1 へ。

> **注意**: この時点では新 code + 旧 schema なので、**演習の回答 flush は失敗する**(server が `reviews` / 旧 `answer_events` を前提にしない SQL を撃つ)。窓を短くするため Step 0〜3 は連続実行する。ユーザー 0 なので実害はない。

### Step 1 — migrate(OT・ADMIN inline)

```sh
DATABASE_URL_ADMIN='<stg owner 接続文字列>' pnpm db:migrate
```

適用される 2 本:

1. **`0034_lazy_retro_girl`** — cards: `stability` / `difficulty` を `double precision` 化、FSRS 列 **11 本の DROP DEFAULT**(`answered` / `current_streak` / `due` / `stability` / `difficulty` / `elapsed_days` / `scheduled_days` / `reps` / `lapses` / `state` / `learning_steps`)、`cards_state_range` CHECK(0-3)追加。
2. **`0035_overconfident_the_phantom`** — `DROP TABLE answer_events / reviews / study_sessions CASCADE` → `CREATE TABLE answer_events`(新形・PK=`event_id` / `card_id` に FK なし / CHECK 3 本)+ FK(user_id → users CASCADE)+ index `answer_events_user_idx (user_id, answered_at)` → `TRUNCATE TABLE study_days`。

★ **未適用の migration は全部まとめて 1 tx で流れる**(`drizzle-kit migrate` → drizzle-orm の postgres-js migrator。`drizzle-orm@0.45.2` の `pg-core/dialect.js:60` が `session.transaction()` で全 migration ループを包む — 現物確認済・2026-08-12)。したがって **0034 が途中で失敗すれば 0035 も含めて全部 rollback** し、DB は適用前の状態のまま残る。**「途中まで当たった中間状態」は生じない**ので、失敗したら原因(1.1 の範囲外 `state` 等)を直して**そのまま再実行**してよい。

> この性質は drizzle の実装依存なので、drizzle-kit / drizzle-orm を bump した際は同 file を再確認すること(挙動が per-migration tx に変わると上記の前提が崩れる)。

**適用が成功した時点で `answer_events` は RLS 無効・app-role の grant も無い**(表と一緒に落ちた)。Step 2・3 を空けずに続ける。

### Step 2 — grants 再適用(OT・SQL Editor・owner)

`db/roles/recallmint_app-grants.sql` は blanket(`GRANT … ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES`)なので、DEFAULT PRIVILEGES 設定済なら新 `answer_events` は自動 grant されているはずだが、**DROP/CREATE では取りこぼしうるので必ず再適用**(冪等)。

1. `db/roles/recallmint_app-grants.sql` 全文を貼付実行(base grant)。
2. **直後に** `db/roles/recallmint_app-grants-phase3.sql` 全文を貼付実行(非 RLS 5 表の REVOKE 縮小。**base → revoke の順固定**・逆順は REVOKE が無効化される)。

### Step 3 — RLS policy 再適用(OT・SQL Editor・owner)

`db/policies/rls-p3-wave1-enable.sql` **全文**を貼付実行(実行直前に file 再確認)。冪等(各 CREATE POLICY の前に DROP POLICY IF EXISTS)。

- 本 sprint で **Wave 1 は 8 表 → 7 表**(`reviews` block 削除)、`answer_events` block は新表向けに書き直し済み。
- **`rls-p3-wave2-enable.sql` の再実行は不要**(`study_sessions` は表ごと消えており、残る 4 表の policy は 0035 で落ちていない)。実行しても冪等で害はない。
- `rls-p2-enable.sql` / `ocr-2-4a-enable.sql` も再実行不要(対象表を 0035 が触っていない)。

### Step 4 — 実効検証(OT または CC)

```sh
RLS_VERIFY_DATABASE_URL='<stg app-role 接続文字列>' pnpm tsx scripts/verify-rls-state.ts
```

**app role 専用**(owner 接続では policy が素通しになり false-green になるため script が fail-closed で弾く)。手順の詳細は `docs/ops/rls-p2-stg-runbook.md` §12。

- 期待カタログは本 sprint で **RLS 対象 20 表 → 18 表 / policy 22 → 20** に縮んでいる。finding **0 件**であること。
- finding に `reviews` / `study_sessions` が「カタログ外の表が RLS on」として出たら **Step 1 が当たっていない**(migration 未適用)。

---

## 3. 適用後確認 SQL(Step 3 直後・owner・SQL Editor)

```sql
-- 3.1 消えた 2 表
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('reviews','study_sessions');
-- 期待: 0 行

-- 3.2 answer_events の制約(PK + FK + CHECK 3 = 5 件ちょうど)
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid='answer_events'::regclass AND contype IN ('p','f','c') ORDER BY conname;
-- 期待: 5 行
--   answer_events_answered_at_le_created_at | CHECK ((answered_at <= created_at))
--   answer_events_elapsed_ms_nonneg         | CHECK (((elapsed_ms IS NULL) OR (elapsed_ms >= 0)))
--   answer_events_pkey                      | PRIMARY KEY (event_id)
--   answer_events_rating_range              | CHECK (((rating >= 1) AND (rating <= 4)))
--   answer_events_user_id_users_id_fk       | FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- ★ card_id への FK が「無い」ことが設計どおり(dangling が正規状態)

-- 3.3 index は 2 本ちょうど
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='answer_events' ORDER BY 1;
-- 期待: answer_events_pkey / answer_events_user_idx (USING btree (user_id, answered_at))

-- 3.4 RLS 有効 + policy 1 本
SELECT relrowsecurity FROM pg_class WHERE relname='answer_events';   -- 期待: t
SELECT policyname, cmd, roles FROM pg_policies WHERE tablename='answer_events';
-- 期待: answer_events_tenant / ALL / {recallmint_app}

-- 3.5 grant 4 件ちょうど
SELECT privilege_type FROM information_schema.role_table_grants
WHERE grantee='recallmint_app' AND table_name='answer_events' ORDER BY 1;
-- 期待: DELETE / INSERT / SELECT / UPDATE

-- 3.6 cards の型と CHECK と default 撤去
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name='cards' AND column_name IN ('stability','difficulty','state','reps','due') ORDER BY 1;
-- 期待: stability / difficulty = double precision、5 列とも column_default が NULL
SELECT conname FROM pg_constraint WHERE conrelid='cards'::regclass AND conname='cards_state_range';
-- 期待: 1 行

-- 3.7 study_days は空
SELECT count(*) FROM study_days;   -- 期待: 0
```

---

## 4. stg smoke 必須項目(push + deploy 後・OT 指示で CC が DevTools MCP 実走)

spec §9.3 に加えて、本 sprint 固有の必須項目が 1 つある。

### 4.1 **【必須・最優先】v8 世代 IndexedDB からの Dexie upgrade**

**なぜ必須か**: Dexie の `answer_events` store は **v9 で破棄 → v10 で再作成**する。unit test は `fake-indexeddb` で毎回**空の DB を新規作成**するため、**既存 DB に対する upgrade path は自動 test で一度も実行されていない**。ここが失敗すると `getClientDb().open()` が reject し、演習・カード編集・pull を含む local-first 機能が**全停止**する(blast radius が最大)。

手順:

1. **本 sprint の code を一度も開いていないブラウザ profile**(= v8 世代の IDB を持つ)で stg にサインイン済の状態を作る。作れない場合は、旧 deploy の URL で `/app` を開いて IDB を v8 まで育ててから新 deploy を開く。
2. `/app` を開く。**白画面・無限ローディングにならないこと**。
3. DevTools console で IDB を直読みして確認(Dexie インスタンスは module scope で console から掴めないため、`indexedDB` API を直に叩く):
   ```js
   await new Promise((res, rej) => {
     const r = indexedDB.open('recallmint')            // DB 名は lib/client-db.ts:263
     r.onsuccess = () => {
       const db = r.result
       console.log('version', db.version, 'stores', [...db.objectStoreNames])
       db.close(); res()
     }
     r.onerror = () => rej(r.error)
   })
   ```
   期待:
   - **`version` が 10**
   - `objectStoreNames` に **`answer_events` が存在**し、**`study_sessions` が存在しない**
   - `answer_events` が **0 件**(旧 store は v9 で破棄済み)。件数は Application → IndexedDB → recallmint → answer_events で目視
4. console に Dexie の `UpgradeError` / `VersionError` / `DatabaseClosedError` が出ていないこと。**`indexedDB.open()` が blocked のまま返らない場合も失敗**(他タブが旧 version で開いたままだと upgrade が待たされる — その場合は全タブを閉じて再現するか確認する)。

**失敗時**: 前方修正のみ(ユーザーに IDB 削除を求める運用は取らない)。deploy を戻しても壊れた IDB は残るため、`getClientDb()` の upgrade 定義を直して再 deploy する。

### 4.2 演習 E2E(spec §9.3)

- 演習 → 回答 → flush → cards / dashboard 反映。証跡 = Network の `POST /api/review-events/bulk`(request body が **`{ events: [...] }` で `session` を含まないこと**・response が `200 { ok: true, failed: [] }`)+ IDB の `answer_events` が `synced` へ遷移。
- **offline 蓄積 → 復帰 flush**: DevTools を offline にして数問回答 → pending が溜まる(**24h 経っても消えない** = drop 撤去の確認は時間的に無理なので、ここでは「offline 中に pending が失われない」まで)→ online 復帰で flush され `synced`。
- **`study_days` の絶対値再集計**: 同じ日に 2 回 flush して `review_count` が二重加算されないこと(dashboard の学習日数 / 回数が正しい)。

### 4.3 RLS 実効検証

Step 4 の `verify-rls-state.ts` を deploy 後にもう一度走らせ finding 0(policy を後から誰かが触っていないことの確認)。

---

## 5. Rollback

| 対象 | 可否 |
|---|---|
| code | **0034 適用後は不可**(戻す先の code が cards の列 default に依存しており、その default はもう無い = card 作成が壊れる)。前方修正のみ |
| 0034 / 0035 | **不可**(drizzle に down migration は無い。DROP した表は復元不能) |
| RLS policy | 可。`db/policies/rls-p3-wave1-disable.sql` で DISABLE(policy 定義は残置)。incident 時の緊急退避のみ・恒久運用にしない |

incident 時は前方修正が原則。`answer_events` は client 側 IDB に pending が残る設計(24h drop なし)なので、**server 側が一時的に 503 を返しても回答は失われない** — 復旧後の flush で回収される。
