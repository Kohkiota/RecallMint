# Sprint B(DB 全体掃除)— 適用 Runbook(migration 0036)

**対象**: `develop` の `1cc9729`〜`1066446`(+ docs)を stg / prod へ反映する際の DB 手順。**owner(`postgres` = `DATABASE_URL_ADMIN`・direct 5432)実行前提**。実行は OT、CC は read-only 調査のみ。

- 設計の正 = `docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md`(凍結)
- 実施記録 = `docs/superpowers/sessions/2026-08-12-sprint-b-db-cleanup.md`
- migration 現物 = `drizzle/migrations/0036_sprint_b_db_cleanup.sql`
- 接続 2 系統の定義 = `docs/ops/connections-and-env.md` §1

---

## 0. この runbook が存在する理由(先に読む)

`0036` は 1 本の migration だが、性質の違う 5 種類の DDL が同居しており、それぞれ別の理由で順序と事前確認を要求する。

| DDL | 件数 | 効く制約 |
|---|---|---|
| `DROP COLUMN` | **13** | **不可逆**。旧 code の Drizzle SELECT は削除列を明示列挙するため、**migrate 先行は旧 code を全面的に壊す**。適用後の code rollback も同じ理由で不可 |
| `DROP INDEX` | **3** | 影響は plan のみ(§4 で実データ EXPLAIN を 1 本取る) |
| `SET NOT NULL` | **1**(`upload_operations.source_document_id`) | **既存行に NULL が 1 行でもあると全体が rollback する**(§1.2 — 未確認の残リスク) |
| FK 張替(DROP + ADD) | **1** | `ON DELETE SET NULL` → `CASCADE`。NOT NULL 化と両立させるため必須(spec §1.10-1) |
| `ADD CONSTRAINT … CHECK` | **27** | **既存行を検証しながらロックを取る**。違反行があればその時点で全体が rollback(§1.3) |

**全部で 1 トランザクション**: `drizzle-kit migrate` → drizzle-orm の postgres-js migrator は未適用 migration のループ全体を `session.transaction()` で包む(`node_modules/drizzle-orm/pg-core/dialect.js:60` — `drizzle-orm@0.45.2` で現物確認・2026-08-12)。したがって **「途中まで当たった中間状態」は生じない**。失敗したら原因を潰してそのまま再実行してよい。

> この性質は drizzle の実装依存。drizzle-orm / drizzle-kit を bump したら同 file を再確認する(per-migration tx に変わると上記前提が崩れる)。

**ユーザー 0 前提**: 適用窓の間に upload / publish が失敗することを設計として受容している(spec §8-3・OT 承認済み)。§2 の窓中は OT が upload / publish 操作をしないこと。

---

## 1. 適用前確認(着手前・**owner 接続で実行**)

> **なぜ owner か**: app role(`recallmint_app`)は NOBYPASSRLS で、policy `user_id = app_current_user_id()` が全 tenant 表に効く。app role で「0 行」を見ても、それが**本当に 0 行なのか policy で濾されたのか区別できない**。以下の診断はすべて owner(`postgres`)で実行する。

### 1.1 到達点が 0035 であること

```sql
-- (1) 適用済み件数。期待 = 36(0000〜0035)。
--     ※ この表は id / hash / created_at しか持たず、**migration の tag 名は記録されない**
--        (hash は SQL 本文の SHA)。よって「どこまで当たったか」は件数 + 下の実体確認で見る。
SELECT count(*) AS applied FROM drizzle.__drizzle_migrations;
SELECT to_timestamp(created_at/1000) AS latest_applied_at
FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1;

-- (2) 0035(FSRS 整合 Sprint A)が当たっていることの実体確認。
--     期待: study_sessions = NULL / reviews = NULL / answer_events = 表名が返る
SELECT to_regclass('public.study_sessions') AS study_sessions_expect_null,
       to_regclass('public.reviews')        AS reviews_expect_null,
       to_regclass('public.answer_events')  AS answer_events_expect_present;

-- (3) 0036 が **まだ** 当たっていないことの確認。期待 = 13
SELECT count(*) AS columns_to_be_dropped_expect_13
FROM information_schema.columns
WHERE table_schema='public' AND (
     (table_name='assets'               AND column_name='reference_count')
  OR (table_name='exams'                AND column_name IN ('question_no_format','archived_at','card_count'))
  OR (table_name='integration_failures' AND column_name IN ('retry_count','next_retry_at','resolved_at','resolution_note'))
  OR (table_name='source_documents'     AND column_name IN ('mode','ocr_cost_yen'))
  OR (table_name='upload_records'       AND column_name IN ('filename','file_size_bytes','ocr_cost_yen'))
);
```

- (3) が **0** なら 0036 は適用済み = 本手順は不要。**0 < n < 13** は想定外(手で列を触った跡)なので OT に上げる。
- **0034 / 0035 が未適用((1) が 36 未満 / (2) が期待と違う)なら本 runbook を実行しない**。`pnpm db:migrate` は未適用分を**まとめて 1 tx で流す**ため、0034 / 0035 / 0036 が同時に走ってしまう。先に `docs/ops/fsrs-sprint-a-stg-migration-runbook.md` を完了させること(あちらは表の DROP/CREATE に伴う **grants / RLS policy の再適用**を含み、0036 の手順には無い)。

### 1.2 ★ `upload_operations.source_document_id` の NULL 行(**最重要・未確認**)

```sql
SELECT id, user_id, status, created_at, lease_expires_at, attempt_count, last_error_code
FROM upload_operations
WHERE source_document_id IS NULL
ORDER BY created_at;
```

**期待 = 0 行。1 行でもあれば `ALTER COLUMN … SET NOT NULL` が `23502` で失敗し、0036 全体(DROP COLUMN 13 本と CHECK 27 本を含む)が rollback する。**

#### この確認が「未確認」である理由(取り繕わない)

**stg / prod のどちらに対しても、この query はまだ一度も実行されていない。**

- 本 repo には **owner 権限の credential が無い**(`DATABASE_URL_ADMIN` は常設環境に置かない運用 — `connections-and-env.md` §1)。CC が持つのは app role(`DATABASE_URL_APP`)のみ。
- app role で引いても答えにならない。`upload_operations` は RLS 対象で、**「0 行」と「他 tenant の行が policy で濾された」が区別できない**。
- したがって現時点の正しい記述は「**NULL 行は無い**」ではなく「**NULL 行の有無は未確認**」。

#### なぜ実在しうるか(推測ではなく migration 履歴から)

- `source_document_id` は **0027 の時点で nullable** として作られた(0035 snapshot でも `notNull=false`)。
- 0032 は legacy state の terminal 化を行ったが、**`source_document_id` の backfill はしていない**。
- よって 0027 世代から持ち上がった DB には NULL 行が残っている可能性がある。**新規に作った DB(iso / 自動テスト)には構造的に存在しない**ため、自動テストはこの分岐を一度も踏まない。

#### 0 行でなかった場合の分岐(**中断だけで終わらせない**)

1 行でも出たら、まず **その行が何なのか**を確定させる。

```sql
-- (a) 対応する台帳行(upload_records)が存在するか = 「処理は完了したが op 行だけ壊れている」かの判別。
--     upload_records は operation を直接指す FK を持たないため、user + 時刻近傍での照合になる(厳密な同定ではない)。
SELECT o.id AS operation_id, o.user_id, o.status, o.created_at,
       (SELECT count(*) FROM upload_records r
         WHERE r.user_id = o.user_id
           AND r.created_at BETWEEN o.created_at - interval '1 hour'
                                AND o.created_at + interval '2 hours') AS nearby_upload_records
FROM upload_operations o
WHERE o.source_document_id IS NULL
ORDER BY o.created_at;

-- (b) 年齢と終端性の分布(古い terminal_failed だけなら削除判断が軽い)
SELECT status, count(*), min(created_at), max(created_at)
FROM upload_operations WHERE source_document_id IS NULL GROUP BY status;
```

そのうえで **OT に持っていく判断は 2 択**(CC が独断で決めない):

| 選択肢 | 内容 | 向くケース |
|---|---|---|
| **A. 孤児行を DELETE** | `DELETE FROM upload_operations WHERE source_document_id IS NULL;` | 全行が terminal(`completed` / `terminal_failed`)で古く、対応する成果物(cards)が既に別経路で存在する。**冪等 ledger としての価値が失われる**(同じ idempotency_key の再送が `exam_not_found` でなく新規実行になりうる)ことを承知の上で捨てる |
| **B. backfill** | 各行に対応する `source_documents.id` を特定して UPDATE | 非終端行が含まれる / 直近の行で成果物との対応が追える。**対応を機械的に決める列が無い**(op → doc の逆引きキーが存在しない)ため、user + 時刻 + exam_id での人手照合になる |

**どちらを選んでも、実行は 0036 適用の前**(NOT NULL 化と同 tx には入れられない)。判断が付かない間は migration を延期する — 適用して失敗させても DB は無傷だが、窓(§2)を無駄に開けたままにしない。

### 1.3 CHECK 27 本の diagnostic(違反行の PK + 実値を返す)

**1 ブロックで貼れる**。**期待 = 0 行**。1 行でも返ったら、その行を直すまで migrate しない。

```sql
-- Sprint B / migration 0036: CHECK 27 本の事前診断。owner 接続で実行。
-- 返る 1 行 = 「その CHECK が ADD された瞬間に 23514 を起こす行」。0 行が期待値。
WITH v AS (
  -- ===== enum 13 本 =====
  SELECT 'users_plan_enum'                  AS constraint_name, id::text AS pk, plan                AS value FROM users              WHERE plan NOT IN ('free','standard','pro')
  UNION ALL SELECT 'users_subscription_status_enum', id::text, subscription_status FROM users        WHERE subscription_status IS NOT NULL AND subscription_status NOT IN ('active','past_due','canceled')
  UNION ALL SELECT 'users_billing_interval_enum',    id::text, billing_interval    FROM users        WHERE billing_interval    IS NOT NULL AND billing_interval    NOT IN ('month','year')
  UNION ALL SELECT 'source_documents_file_type_enum', id::text, file_type FROM source_documents      WHERE file_type NOT IN ('pdf','image','csv','markdown')
  UNION ALL SELECT 'source_documents_status_enum',    id::text, status    FROM source_documents      WHERE status    NOT IN ('processing','completed','failed')
  UNION ALL SELECT 'upload_records_status_enum',      id::text, status    FROM upload_records        WHERE status    NOT IN ('completed','failed')
  UNION ALL SELECT 'contact_messages_status_enum',    id::text, status    FROM contact_messages      WHERE status    NOT IN ('open','in_progress','resolved')
  UNION ALL SELECT 'tag_categories_select_type_enum', id::text, select_type FROM tag_categories      WHERE select_type NOT IN ('single','multi')
  UNION ALL SELECT 'tombstones_entity_type_enum',     id::text, entity_type FROM tombstones          WHERE entity_type NOT IN ('exam','card','tag_category','tag_option')
  UNION ALL SELECT 'entity_mutations_entity_type_enum', id::text, entity_type FROM entity_mutations  WHERE entity_type NOT IN ('card','tag_category','tag_option')
  UNION ALL SELECT 'entity_mutations_op_enum',        id::text, op        FROM entity_mutations      WHERE op        NOT IN ('create','update_field','delete')
  UNION ALL SELECT 'assets_status_enum',              id::text, status    FROM assets                WHERE status    NOT IN ('reserved','ready','deleting','deleted')
  UNION ALL SELECT 'upload_operations_status_enum',   id::text, status    FROM upload_operations     WHERE status    NOT IN ('prepared','processing','completed','terminal_failed')

  -- ===== 非負 12 本 =====
  UNION ALL SELECT 'ai_usage_count_nonneg',        date::text,                        count::text FROM ai_usage        WHERE count < 0
  UNION ALL SELECT 'ai_usage_users_count_nonneg',  user_id::text || ' / ' || date::text, count::text FROM ai_usage_users WHERE count < 0
  UNION ALL SELECT 'assets_byte_size_nonneg',      id::text, byte_size::text FROM assets            WHERE byte_size < 0
  UNION ALL SELECT 'source_documents_file_size_bytes_nonneg', id::text, file_size_bytes::text FROM source_documents WHERE file_size_bytes < 0
  UNION ALL SELECT 'source_documents_pages_processed_nonneg', id::text, pages_processed::text FROM source_documents WHERE pages_processed < 0
  UNION ALL SELECT 'source_documents_pages_total_nonneg',     id::text, pages_total::text     FROM source_documents WHERE pages_total IS NOT NULL AND pages_total < 0
  UNION ALL SELECT 'study_days_review_count_nonneg',         user_id::text || ' / ' || day::text, review_count::text        FROM study_days WHERE review_count < 0
  UNION ALL SELECT 'study_days_correct_count_nonneg',        user_id::text || ' / ' || day::text, correct_count::text       FROM study_days WHERE correct_count < 0
  UNION ALL SELECT 'study_days_distinct_card_count_nonneg',  user_id::text || ' / ' || day::text, distinct_card_count::text FROM study_days WHERE distinct_card_count < 0
  UNION ALL SELECT 'upload_operations_attempt_count_nonneg',          id::text, attempt_count::text         FROM upload_operations WHERE attempt_count < 0
  UNION ALL SELECT 'upload_operations_expected_source_count_nonneg',  id::text, expected_source_count::text FROM upload_operations WHERE expected_source_count < 0
  UNION ALL SELECT 'upload_records_pages_processed_nonneg',           id::text, pages_processed::text       FROM upload_records    WHERE pages_processed < 0

  -- ===== 正数 2 本(0 も違反 — 寸法 0 の画像は存在しない) =====
  UNION ALL SELECT 'assets_width_positive',  id::text, width::text  FROM assets WHERE width  <= 0
  UNION ALL SELECT 'assets_height_positive', id::text, height::text FROM assets WHERE height <= 0
)
SELECT * FROM v ORDER BY constraint_name, pk;
```

#### NULL の別掲(`NOT IN` が黙って飛ばす行を数える)

上の診断は **`NOT IN (...)` が NULL 行を評価せず素通しする**ため、NULL を許す 3 列については「違反 0 件」が「全行が有効値」を意味しない。**この 3 列は制約自体が NULL を許容している**(`col IS NULL OR col IN (…)` / `col IS NULL OR col >= 0`)ので NULL は違反ではない — 下の件数は「診断が何行を評価対象外にしたか」を明示するための情報。

```sql
SELECT 'users.subscription_status'      AS col, count(*) FILTER (WHERE subscription_status IS NULL) AS null_rows, count(*) AS total FROM users
UNION ALL
SELECT 'users.billing_interval',              count(*) FILTER (WHERE billing_interval    IS NULL),      count(*) FROM users
UNION ALL
SELECT 'source_documents.pages_total',        count(*) FILTER (WHERE pages_total         IS NULL),      count(*) FROM source_documents;
```

> `users.plan` は NOT NULL(default `'free'`)、その他 23 本の対象列も NOT NULL のため(27 制約の対象列 27 本 − nullable 3 本 − `users.plan` = 23)、NULL 別掲は上記 3 列のみで足りる(`drizzle/migrations/meta/0035_snapshot.json` で確認)。

---

## 2. 適用順序(厳守)= 【Dexie v10 seed】→ code deploy → drain → backup → migrate

### 2.0 なぜこの順序しかないか

| 順序 | 何が起きるか |
|---|---|
| **migrate 先行** | 旧 code の Drizzle SELECT は削除される 13 列を**明示列挙**する。exam 一覧・upload・pull を含む読み経路が `42703`(undefined_column)で全面的に壊れる。**採らない** |
| **code 先行(採用)** | 窓の間、**新 code の INSERT が `23502` で失敗**する。`source_documents.mode` / `upload_records.filename` / `upload_records.file_size_bytes` は **NOT NULL かつ default 無し**(0035 snapshot で確認)で、新 code はこれらの値を組み立てないため。**読みは無傷 / 壊れるのは upload と publish だけ** |

**窓の代償はユーザー 0 前提で受容済み**(spec §8-3・OT 承認)。**窓の間、OT は upload / publish 操作をしない。** maintenance UI / 受付停止機構は作らない(ユーザー 0 に対して過剰・spec §9)。

### Step 0 — code を deploy する

> **★ deploy の前に §6.2(a) 手順 1(Dexie v10 の seed)を済ませる。** IndexedDB は origin scope なので、**deploy 後には stg origin で v10 を作れない**(新 code が即座に v12 へ上げる。Vercel の deployment 個別 URL は別 origin なので回避にならない)。ここを飛ばすと「他タブが v10 を握った状態での upgrade blocked」の検証が**恒久的に不可能**になる。

新 deployment が **ACTIVE** になったことを Vercel dashboard で確認してから Step 1 へ。

### Step 1 — drain を確認する

**2 条件を両方満たすまで migrate しない。**

#### (1) 非終端 operation がゼロ

```sql
SELECT status, count(*) FROM upload_operations
WHERE status IN ('processing','prepared')
GROUP BY status;
```

**期待 = 0 行。**

- `processing` = 旧 deployment の OCR invocation がまだ動いている可能性。migrate 後にその invocation が削除列へ INSERT して失敗する。
- **`prepared` も含める理由**: prepared 残があると publish 経路が `upload_records` へ `filename` / `file_size_bytes` を INSERT する。**窓を跨ぐ publish は新旧どちらの組でも失敗する**(旧 schema × 新 code = 23502 / 新 schema × 旧 code = 42703)。spec §9。

#### (2) 旧 invocation の生存上限が経過している

status が 0 でも、**行を書く前に落ちた invocation が生きている**可能性があるため、直近 deploy から Function の最大実行時間を待つ。

- **`vercel.json` は upload 系 route の `maxDuration` を pin していない** — `functions` に載っているのは `app/api/webhooks/clerk/route.ts` と `app/api/webhooks/stripe/route.ts` の **60s だけ**(現物確認・2026-08-12)。**しかしこれは「dashboard の現在値を読みに行く」根拠にはならない**: upload 系 route は Next.js の **route segment config** で自前の `maxDuration` を宣言しており(`app/(app)/app/upload/page.tsx:23` — `export const maxDuration = 720`)、route segment config は **dashboard の Function Max Duration を上書きする**(同 file `:19-20` のコメントに明記)。したがって upload 経路(同一 invocation 内で `publishPreparedUploadTx` も走るため publish 経路も同じ上限に入る)の実効上限は、dashboard の設定値に関わらず **720 秒**。`app/(app)/app/upload/_actions/submit-upload.test.ts` がこの literal と行の存在自体を pin しており、drift すればテストが落ちる。
- **待つのは 720 秒**(`app/(app)/app/upload/page.tsx:23` を正とする — bump したらこの runbook も合わせて更新する)。**dashboard の Function Max Duration がこれより大きい値になっていた場合はその値を待つ**(route segment config が上書きするとはいえ、dashboard 側がより長い値を強制するケースを安全側で排除しないため — fail-closed に「長い方」を待つ)。dashboard を確認する目的はこの safety net のみで、720 秒を下回る根拠には使わない。

### Step 1' — **drain が終わらないときの分岐**(無期限に待たない)

`processing` / `prepared` が減らない場合、それは「動いている」のではなく「放置されている」可能性が高い。まず正体を確定する。

```sql
SELECT id, user_id, status, created_at, lease_expires_at, attempt_count, last_error_code,
       (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS live
FROM upload_operations
WHERE status IN ('processing','prepared')
ORDER BY created_at;
```

| `live` | 意味 | 対応 |
|---|---|---|
| **true** | 有効 lease を持つ = 進行中の invocation が実在する扱い | **待つ**。lease は発行時 `now() + 15 分`(`LEASE_TTL_MS` = `app/(app)/app/upload/_lib/constants.ts:55`)。`lease_expires_at` を過ぎれば false に落ちる |
| **false**(lease が NULL / 失効) | **放置 op**。これを進める主体は存在しない(新経路に resume は無い) | 下記のいずれかで terminal 化する |

**放置 op の terminal 化(既存経路・推奨)** — `scripts/gc-abandoned-operations.ts`。候補選定と UPDATE の両方に同じ述語(非終端 かつ `NOT live`)を再適用する fenced CAS で、その間に live 化した行は静かに skip する。

```sh
# 予告のみ(write ゼロ)。--conditions=react-server は必須(getAdminDb が 'server-only' を持つため)
DATABASE_URL_ADMIN='<owner 接続文字列>' pnpm tsx --conditions=react-server \
  scripts/gc-abandoned-operations.ts --dry-run

# 対象 user を絞って本実行(stg 検証時は必ず --user から)
DATABASE_URL_ADMIN='<owner 接続文字列>' pnpm tsx --conditions=react-server \
  scripts/gc-abandoned-operations.ts --user <userId>

# 全 user 本実行
DATABASE_URL_ADMIN='<owner 接続文字列>' pnpm tsx --conditions=react-server \
  scripts/gc-abandoned-operations.ts
```

**この script は `upload_operations` しか触らない**(`status='terminal_failed'` + `prepared_payload=NULL` + `last_error_code`/`result_summary` 設定・現物確認)。対応する `source_documents` は `'processing'` のまま残る — それは `reconcileStaleProcessing`(唯一の production 呼び出し元 = `/api/exams/status` の polling・`app/api/exams/status/route.ts:162`。exam 一覧 render からの呼び出しは S2.0.7 で撤去済 — `app/(app)/app/exams/page.tsx:9` の comment 参照・15 分超の stale を failed 化)が後で回収する。**0036 の適用条件は `upload_operations` 側なので、source doc の後追いを待つ必要はない。**

**手動 SQL fallback**(script が動かせない場合のみ・owner)。**上の script が `--dry-run` / `--user` で対象を絞れるのに対し、生 SQL は既定で全 user に効く** — この project の破壊操作の規律(確認 → 実行の 2 段分離・対象は個別指定)に合わせ、(a) 対象行を確認してから (b) を流す。`<uuid>` を埋めれば `--user` 相当に絞れる(既定はコメントアウトのまま = 全 user)。

```sql
-- (a) 確認: (b) を流す前に対象行を目視する(script の --dry-run に相当)。
SELECT id, user_id, status, created_at, lease_expires_at, attempt_count, last_error_code
FROM upload_operations
WHERE status IN ('prepared','processing')
  AND NOT (lease_expires_at IS NOT NULL AND lease_expires_at > now())  -- live な行は触らない
  -- AND user_id = '<uuid>'  -- 対象 user を絞る場合のみ有効化(script の --user に相当)
ORDER BY created_at;
```

```sql
-- (b) 実行: (a) で確認した行と一致することを確かめてから流す。WHERE は (a) と同一に保つ。
UPDATE upload_operations
SET status = 'terminal_failed',
    prepared_payload = NULL,
    last_error_code = 'abandoned_retention_exceeded',
    result_summary = '{"reason":"abandoned_retention_exceeded"}'::jsonb
WHERE status IN ('prepared','processing')
  AND NOT (lease_expires_at IS NOT NULL AND lease_expires_at > now())  -- live な行は触らない
  -- AND user_id = '<uuid>'  -- (a) と同じ絞り込みを使うこと
RETURNING id, user_id, status;
```

> `NOT (… IS NOT NULL AND … > now())` の形を崩さないこと。`lease_expires_at > now()` 単独は `lease_expires_at IS NULL` のとき **false でなく NULL** に評価され、放置行の**支配的なケース**(lease を張らない legacy prepare / 失敗経路の lease NULL 化)が WHERE から静かに落ちる(`lib/exams/source-doc-status.ts:100-118` の解説と同じ罠)。

**live=true の行が居座り続ける場合**は terminal 化しない。**migration を延期する**のが正しい — 生きている invocation を殺してから migrate すると、その invocation が書きかけた状態が残る。

### Step 2 — **backup を取る(prod は必須・ここが最後の退路)**

**この step を飛ばして Step 3 に進むと、13 列が落ちた後に退路が無いことに気付くことになる。**

| 環境 | 要否 |
|---|---|
| **prod** | **必須**。`pg_dump -Fc` を取得し、`pg_restore --list` で TOC を確認するところまで(**現状の水準** — 実 restore 検証への格上げトリガーは §5.2) |
| stg | 任意(取らずに進めてよい。ただし取らない判断をしたことを記録に残す) |

- **取得タイミングはここ**(drain 完了後・migrate 直前)。窓の前に取ると、窓中に起きた変更が復元対象から漏れる。
- **実体 = `pg_dump` の一択**。本 project の Supabase は **Free プラン**で、PITR も scheduled backup も**有料機能ゆえ存在しない**(dashboard 実測・2026-08-13)。「PITR があるはず」で進めないこと。
  - 有料プランへ移行したら選択肢が増える。その時点で本節を書き直す。

#### (a) 事前確認(1 回・毎回やる)

```sh
# client 版 >= server 版(major)であること。pg_dump は自分より新しい server を dump できない。
pg_dump --version    # 期待: 17.x(devcontainer 実測 = 17.10)
psql "$DATABASE_URL_ADMIN" -X -tAc "SHOW server_version;"   # 期待: 17.x
```

> devcontainer の `pg_dump` は `postgresql-17` package(`.devcontainer/pg-setup.sh` が `test:iso` 用 cluster のために install)の依存として入る `postgresql-client-17` が提供する。**rebuild しても post-create で再 install されるため追加の永続化は不要**。逆に言えば pg-setup.sh の PG major を上げたら client 版も一緒に動く — その時は上の突き合わせで気付く。
> **server が client より新しい major になったら、その時点で dump は失敗する**(例: Supabase が PG18 へ移行 / client は 17 のまま)。エラーを見てから慌てないよう、この確認を毎回先に置く。

#### (b) 取得

```sh
# 出力先は git 管理外(リポジトリ直下 backups/ は .gitignore 済み)。
mkdir -p backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="backups/prod-pre-0036-${STAMP}.dump"

# direct 5432(owner)で取る。pooler(6543)は transaction mode ゆえ pg_dump に使わない。
# -Fc = custom format(pg_restore で選択復元・並列復元ができる。素の SQL より復元時に強い)
# --no-owner だけ付ける: 復元先の role 名が一致しない場合に備える。
# **--no-privileges は付けない** — 付けると GRANT が dump から落ち、復元しても
# recallmint_app が権限ゼロで復元後の app が動かない(RLS policy は schema の一部なので
# dump に入るが、GRANT は privileges 側)。
pg_dump "$DATABASE_URL_ADMIN" -Fc --no-owner -f "$DUMP"
ls -lh "$DUMP"
```

> **復元する日に読むこと**: `--no-owner` で取っているため、復元後は object owner が復元実行 role になる。GRANT は dump に含まれるが、**復元先で role 名が違えば GRANT は当たらない**。その場合は `db/roles/recallmint_app-grants.sql` → `recallmint_app-grants-phase3.sql` → `db/policies/*-enable.sql` の順で再適用する(いずれも冪等)。

#### (c) 検証(**現状はここまでで足りる**)

```sh
pg_restore --list "$DUMP" | head -40
pg_restore --list "$DUMP" | wc -l                          # TOC entry 数(0 / 極端に少ない = 異常)
pg_restore --list "$DUMP" | grep "TABLE DATA" | sort        # ← 実体はこれを目で見る
```

**判定は件数でなく「一覧に何が居るか」で行う**: `public` の 23 表(`lib/db/schema.ts` の `pgTable` 定義数と一致)が `TABLE DATA` に揃っていること。加えて `drizzle.__drizzle_migrations`(migration 履歴)も dump に含まれる — **これが無い dump から復元すると migration 履歴を失い、次の `db:migrate` が 0000 から流れる**ので、存在を必ず確認する。

> 数値を 1 つ暗記して突き合わせる形にしないのは、表数が sprint ごとに動くため(本 migration 後は 23 のまま・列だけが減る)。**一覧を見て欠けが無いか**を見るほうが陳腐化しない。

**なぜ TOC 確認で足りるか**(判断とトリガーを明示する): 現状は**実ユーザー 0**で、prod に守るべき利用者データが無い。この状況で守っているのは「OT 自身の検証データ」だけであり、失われた場合のコストは再投入の手間に留まる。よって「**dump が構造的に健全で、期待した表数のデータ section を含む**」ところまで確認すれば、費用対効果として十分と判断する。

> **格上げトリガー = 実ユーザー獲得(公開)**。その時点で、この (c) を「空 DB へ実際に `pg_restore` して行数を突き合わせる」手順に差し替える。**復元できない backup は backup ではない**が、それが判明するのは 13 列が消えた後 — というリスクを、ユーザー 0 の間だけ意図的に受容している。

#### (d) 記録(手順の一部・省略しない)

**Step 3 に進む前に**、session doc(`docs/superpowers/sessions/`)へ次の 4 点を書く:

1. dump ファイル名(= `prod-pre-0036-<UTC stamp>.dump`)
2. 取得時刻(UTC)と取得先環境(prod / stg)
3. ファイルサイズ
4. `pg_restore --list` の確認結果(TOC entry 数 / `TABLE DATA` 数、および先頭数行)

記録が無い backup は「取ったつもり」と区別できない。

### Step 3 — migrate(owner・inline 供給)

#### (a) 先に session の timeout を設定する

行数は僅少なので所要時間は問題にならないが、**何かがロックを掴んでいた場合に無限に待たせない**ための fail-fast。

`pnpm db:migrate` の接続は drizzle-kit が自前で張るため、shell から `SET` を渡せない。**role 既定として設定 → migrate → RESET** の 3 手で行う(owner・SQL Editor):

```sql
-- 適用直前
ALTER ROLE postgres IN DATABASE postgres SET lock_timeout      = '5s';
ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '120s';
```

- **これは新規に張られる session にだけ効く**(既に開いている session には効かない)。migrate は新規接続なので目的を満たす。
- database 名 / role 名は環境で異なる。`SELECT current_database(), current_user;` で実物を確認してから貼る。
- 効いたことの確認は、migrate 後の session で `SHOW lock_timeout;`。

#### (b) 適用

```sh
DATABASE_URL_ADMIN='<owner 接続文字列>' pnpm db:migrate
```

> **inline 供給を忘れないこと。** `drizzle.config.ts` は `.env.local` を明示 load する。dotenv は既存の `process.env` を上書きしないので **inline 指定があればそちらが勝つ**が、**忘れると `.env.local` の値が黙って使われる**(ローカルの `.env.local` は基本 stg を指す — `connections-and-env.md`)。prod 適用時は特に、実行前に接続先を目視で確認する。

適用される 1 本 = **`0036_sprint_b_db_cleanup`**:

1. FK `upload_operations_source_document_id_source_documents_id_fk` を DROP
2. `DROP INDEX` × 3(`cards_answered_idx` / `entity_mutations_entity_idx` / `source_docs_user_exam_idx`)
3. `upload_operations.source_document_id` を **SET NOT NULL**
4. 同 FK を **`ON DELETE CASCADE`** で ADD
5. `DROP COLUMN` × 13 — `assets.reference_count` / `exams.question_no_format` / `exams.archived_at` / `exams.card_count` / `integration_failures.{retry_count,next_retry_at,resolved_at,resolution_note}` / `source_documents.{mode,ocr_cost_yen}` / `upload_records.{filename,file_size_bytes,ocr_cost_yen}`
6. `ADD CONSTRAINT … CHECK` × 27

**表の DROP / CREATE は無い** → **policy も grant も落ちない**。FSRS Sprint A のような grants / RLS 再適用の後続手順は**不要**(`fsrs-sprint-a-stg-migration-runbook.md` の Step 2 = grants 再適用 / Step 3 = RLS policy 再適用 に相当するものは、本 runbook には存在しない)。

#### (c) 失敗したら

DB は適用前のまま(全体 1 tx)。エラーの SQLSTATE で原因が分かれる:

| SQLSTATE | 原因 | 戻る先 |
|---|---|---|
| `23502` | `SET NOT NULL` が NULL 行に当たった | §1.2 の分岐へ |
| `23514` | `ADD CONSTRAINT CHECK` が違反行に当たった。エラーメッセージに **constraint 名**が出る | §1.3 の該当行を潰す |
| `55P03` / lock timeout | 誰かが対象表のロックを保持 | 保持元を `pg_locks` で特定して解放 → 再実行 |

いずれも **rollback はしない・原因を潰してそのまま再実行**する。

> **★ 原因調査に入る前に (a) の role timeout を RESET する。**
> `ALTER ROLE … IN DATABASE … SET` は**その role の以後の全 session に効く database 既定**なので、放置すると調査 SQL・他の運用 script・別件の管理作業まで 5 秒 lock timeout / 120 秒 statement timeout に縛られる(migration を延期している間ずっと)。
>
> ```sql
> ALTER ROLE postgres IN DATABASE postgres RESET lock_timeout;
> ALTER ROLE postgres IN DATABASE postgres RESET statement_timeout;
> ```
>
> **再実行する直前に (a) をもう一度適用する。** 「失敗 → RESET → 調査・修正 → (a) 再適用 → 再実行」が 1 周。

#### (d) TOCTOU の位置づけ(事前確認は正しさの根拠ではない)

§1.2 / §1.3 の確認と DDL の間には隙がある — Stripe / Clerk の webhook 書込や、drain をすり抜けた invocation が、その隙に違反行を作りうる。

**それでも安全側に倒れる**: `ALTER TABLE … ADD CONSTRAINT … CHECK` は既存行を**検証しながらロックを取る**ため、すり抜けた行があれば **DDL 自身が失敗し、全体が rollback する**。`SET NOT NULL` も同じ。

したがって:

- **正しさを保証しているのは DDL であって事前確認ではない。**
- **事前確認の目的は「失敗を事前に知る」こと**(窓を開けてから初めて違反行の存在を知る、という最悪の順序を避ける)。
- `NOT VALID` → `VALIDATE` の 2 段は採らない(ユーザー 0・行数僅少・spec §5.2 で YAGNI 判定済み)。

---

## 3. 適用後照合 SQL(migrate 直後・owner・1 ブロック)

**6 つの `SELECT` すべてが期待どおりであること。**

```sql
-- 3.1 消えた 13 列 — 期待: 0 行
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'public' AND (
     (table_name='assets'               AND column_name='reference_count')
  OR (table_name='exams'                AND column_name IN ('question_no_format','archived_at','card_count'))
  OR (table_name='integration_failures' AND column_name IN ('retry_count','next_retry_at','resolved_at','resolution_note'))
  OR (table_name='source_documents'     AND column_name IN ('mode','ocr_cost_yen'))
  OR (table_name='upload_records'       AND column_name IN ('filename','file_size_bytes','ocr_cost_yen'))
);

-- 3.2 消えた 3 index — 期待: 0 行
SELECT indexname FROM pg_indexes
WHERE schemaname='public'
  AND indexname IN ('cards_answered_idx','entity_mutations_entity_idx','source_docs_user_exam_idx');

-- 3.3 upload_operations.source_document_id = NOT NULL + FK が CASCADE
--     期待: 1 行 / is_nullable = 'NO'
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='upload_operations' AND column_name='source_document_id';
--     期待: 1 行 / … ON DELETE CASCADE
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid='upload_operations'::regclass AND contype='f'
  AND conname='upload_operations_source_document_id_source_documents_id_fk';

-- 3.4 / 3.5 CHECK 27 本 — 期待した 27 個の (名前, 表) の組を明示列挙して照合する。
--     (名前 LIKE '%_nonneg' 等での抽出はしない: Sprint A の
--      answer_events_elapsed_ms_nonneg が混ざり件数がズレるため。表も突き合わせる理由:
--      名前だけの一致だと、同名 CHECK が誤った表に付いていても found=27 / missing=0 と
--      誤報告する — conrelid を e.tbl と突き合わせて初めて「正しい表に付いた 27 本」を保証する。)
WITH expected(conname, tbl) AS (VALUES
  ('users_plan_enum','users'),('users_subscription_status_enum','users'),('users_billing_interval_enum','users'),
  ('source_documents_file_type_enum','source_documents'),('source_documents_status_enum','source_documents'),
  ('upload_records_status_enum','upload_records'),('contact_messages_status_enum','contact_messages'),
  ('tag_categories_select_type_enum','tag_categories'),('tombstones_entity_type_enum','tombstones'),
  ('entity_mutations_entity_type_enum','entity_mutations'),('entity_mutations_op_enum','entity_mutations'),
  ('assets_status_enum','assets'),('upload_operations_status_enum','upload_operations'),
  ('ai_usage_count_nonneg','ai_usage'),('ai_usage_users_count_nonneg','ai_usage_users'),('assets_byte_size_nonneg','assets'),
  ('source_documents_file_size_bytes_nonneg','source_documents'),('source_documents_pages_processed_nonneg','source_documents'),
  ('source_documents_pages_total_nonneg','source_documents'),
  ('study_days_review_count_nonneg','study_days'),('study_days_correct_count_nonneg','study_days'),
  ('study_days_distinct_card_count_nonneg','study_days'),
  ('upload_operations_attempt_count_nonneg','upload_operations'),('upload_operations_expected_source_count_nonneg','upload_operations'),
  ('upload_records_pages_processed_nonneg','upload_records'),
  ('assets_width_positive','assets'),('assets_height_positive','assets')
)
-- 3.4 サマリ — 期待: expected = 27 / found = 27 / missing = 0 / not_validated = 0
--     conrelid = e.tbl::regclass を join 条件に含める(名前一致だけでは誤った表への付与を
--     見逃す。上記コメント参照)。
SELECT (SELECT count(*) FROM expected) AS expected,
       count(c.oid)                                        AS found,
       (SELECT count(*) FROM expected) - count(c.oid)      AS missing,
       count(*) FILTER (WHERE c.oid IS NOT NULL AND NOT c.convalidated) AS not_validated
FROM expected e
LEFT JOIN pg_constraint c
  ON c.conname = e.conname AND c.contype='c' AND c.connamespace='public'::regnamespace
  AND c.conrelid = e.tbl::regclass;

-- 3.5 明細 — 期待: 27 行・actual_tbl が expected_tbl と一致・def が全て NULL でない(found)。
--     conrelid では絞らない(3.4 と違い、誤った表に付いていた場合に「見つからない」ではなく
--     「actual_tbl が expected_tbl と食い違う行」として可視化するため)。
--     def(許容値セットの実体)は自動照合しない — pg_get_constraintdef の正規化表記が
--     書き手の想定表記と字面一致しない場合に false mismatch を出すリスクの方が、人手で
--     migration(drizzle/migrations/0036_sprint_b_db_cleanup.sql)と読み比べる手間より高いと
--     判断した。値セットの取り違えは def を migration 本文と目視突き合わせて確認すること。
WITH expected(conname, tbl) AS (VALUES
  ('users_plan_enum','users'),('users_subscription_status_enum','users'),('users_billing_interval_enum','users'),
  ('source_documents_file_type_enum','source_documents'),('source_documents_status_enum','source_documents'),
  ('upload_records_status_enum','upload_records'),('contact_messages_status_enum','contact_messages'),
  ('tag_categories_select_type_enum','tag_categories'),('tombstones_entity_type_enum','tombstones'),
  ('entity_mutations_entity_type_enum','entity_mutations'),('entity_mutations_op_enum','entity_mutations'),
  ('assets_status_enum','assets'),('upload_operations_status_enum','upload_operations'),
  ('ai_usage_count_nonneg','ai_usage'),('ai_usage_users_count_nonneg','ai_usage_users'),('assets_byte_size_nonneg','assets'),
  ('source_documents_file_size_bytes_nonneg','source_documents'),('source_documents_pages_processed_nonneg','source_documents'),
  ('source_documents_pages_total_nonneg','source_documents'),
  ('study_days_review_count_nonneg','study_days'),('study_days_correct_count_nonneg','study_days'),
  ('study_days_distinct_card_count_nonneg','study_days'),
  ('upload_operations_attempt_count_nonneg','upload_operations'),('upload_operations_expected_source_count_nonneg','upload_operations'),
  ('upload_records_pages_processed_nonneg','upload_records'),
  ('assets_width_positive','assets'),('assets_height_positive','assets')
)
SELECT e.conname,
       e.tbl                          AS expected_tbl,
       c.conrelid::regclass           AS actual_tbl,
       pg_get_constraintdef(c.oid)    AS def,
       c.convalidated
FROM expected e
LEFT JOIN pg_constraint c
  ON c.conname = e.conname AND c.contype='c' AND c.connamespace='public'::regnamespace
ORDER BY e.conname;
```

> `pg_constraint.convalidated` は **`NOT VALID` で追加された制約だけが false** になる。0036 は `NOT VALID` を使っていないので全 27 本が true のはず — false があれば手で入れ直された制約が混ざっている。

**timeout を戻す**:

```sql
ALTER ROLE postgres IN DATABASE postgres RESET lock_timeout;
ALTER ROLE postgres IN DATABASE postgres RESET statement_timeout;
```

---

## 4. `source_docs_user_exam_idx` 削除後の EXPLAIN(**stg 実データで 1 本**)

`source_docs_user_exam_idx (user_id, exam_id)` は `source_docs_user_exam_created_idx (user_id, exam_id, created_at DESC)` の**厳密 prefix** なので冗長 — というのが削除根拠(spec §1)。**冗長性の主張は plan を見るまで検証されていない**ので、削除後に実データで 1 回だけ確認する。

**自動テストに入れていない理由**: iso の fixture は数行しかなく、その規模では planner が index を使わず seq scan を選ぶ。**小さい fixture で `Index Scan` を期待する assert は、正しい設計でも red になる**(逆に seq scan を許す assert は何も pin しない)。よって実データのある stg でのみ確認する。

対象 query = `/api/exams/status` と `getExamStatusMap` が撃つ `DISTINCT ON (exam_id)`(`app/api/exams/status/route.ts:80-91` / `lib/exams/source-doc-status.ts:155-166`)。

#### (a) app role で取る(**これが本番の plan**)

RLS policy `source_documents_tenant`(`user_id = (SELECT public.app_current_user_id())`)が述語に足されるため、**app role で取った plan が実際に本番で走る plan**。pooler は transaction mode なので `SET LOCAL` を明示 tx で囲む。

```sh
psql "$DATABASE_URL_APP"
```

```sql
BEGIN;
SELECT set_config('app.user_id', '<実在する user の uuid>', true);
EXPLAIN (ANALYZE, BUFFERS)
SELECT DISTINCT ON (exam_id) exam_id, id, status, created_at
FROM source_documents
WHERE user_id = '<同じ uuid>'
ORDER BY exam_id, created_at DESC;
COMMIT;
```

#### (b) owner で取る(policy 抜きの素の plan)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT DISTINCT ON (exam_id) exam_id, id, status, created_at
FROM source_documents
WHERE user_id = '<実在する user の uuid>'
ORDER BY exam_id, created_at DESC;
```

**期待**: `Index Scan` / `Index Only Scan` using **`source_docs_user_exam_created_idx`** が出て、`Sort` ノードが**入らない**(index が `(user_id, exam_id, created_at DESC)` の順序をそのまま供給するため、`Unique` の直下に Sort が要らない)。

**Seq Scan が出た場合**の読み方 — **即座に問題とは限らない**:

1. まず `SELECT count(*) FROM source_documents;` を見る。行数が数十なら planner が seq scan を選ぶのは正常(index を使う方が遅い)。**この場合は「確認できなかった」と記録する**(index が壊れている証拠にはならない)。
2. 行数が十分あるのに seq scan なら `ANALYZE source_documents;` 後に再取得。
3. それでも seq scan なら本物の回帰 — `source_docs_user_exam_created_idx` の存在(§3.2 の逆・`pg_indexes` で `indexdef` を見る)を確認して OT に上げる。

**取得した plan の生出力は session doc に貼る**(「index を使っていた」という要約だけ残さない)。

---

## 5. 不可逆性・backup・rollback

### 5.1 何が戻せないか

| 対象 | 可否 |
|---|---|
| **`DROP COLUMN` × 13** | **不可逆**。drizzle に down migration は無く、落とした列のデータは PG からも復元できない |
| **code rollback(0036 適用後)** | **不可**。戻す先の code は 13 列を SELECT で明示列挙するため `42703` で全面的に壊れる。**前方修正 or DB restore の 2 択** |
| `DROP INDEX` × 3 | 可(再 CREATE すれば戻る)。ただし単独で戻しても列は戻らない |
| CHECK 27 本 | 可(`DROP CONSTRAINT`)。incident 時の緊急退避のみ・恒久運用にしない |
| **Dexie v11 / v12(client)** | **不可逆**。§5.3 参照 |

### 5.2 prod 適用前に存在していなければならない backup

**手順上の位置 = §2 Step 2**(独立した step にしてある。migrate は Step 3)。ここは理由の説明。

- **実体は `pg_dump` の一択**。本 project の Supabase は **Free プラン**で PITR / scheduled backup を持たない(**有料機能・dashboard 実測 2026-08-13**)。spec §9 と本 runbook の旧版は「Supabase の PITR / 手動バックアップ、または pg_dump」と書いていたが、**前 2 者はこのプランでは存在しない選択肢**だった。手順の実体は §2 Step 2 (a)〜(d)。
- 取得タイミングを drain 完了後にする理由: 窓の前に取ると、窓中に起きた変更が復元対象から漏れる。
- **検証水準は現在「TOC 確認まで」**(`pg_restore --list`)。理由 = 実ユーザー 0 で、prod に守るべき利用者データが無いため、失われた場合のコストは OT の検証データ再投入に留まる。**格上げトリガー = 実ユーザー獲得(公開)** — その時点で「空 DB へ実 `pg_restore` して行数突合」へ差し替える。
  - この受容が何を意味するかは正直に書いておく: **復元できない backup は backup ではない**。TOC 確認は「dump が構造的に健全で期待した表数のデータ section を持つ」ことしか言わず、実際に復元が通るかは保証しない。ユーザー 0 の間だけこの差分を許容している(spec §9・Codex r3 指摘 18 の水準からは意図的に一段下げた運用判断)。
- backup ファイル名・取得時刻(UTC)・サイズ・`pg_restore --list` の結果を、適用の記録(session doc)に残す(§2 Step 2 (d))。
- **dump の置き場所は git 管理外**(`backups/` / `*.dump` / `*.sql.gz` を `.gitignore` 済み・2026-08-13)。DB dump には全 user の PII が入るため、誤 commit は情報漏洩に直結する。
- **client 版の前提**: `pg_dump` は自分より新しい major の server を dump できない。devcontainer の client は `postgresql-17`(`.devcontainer/pg-setup.sh` が `test:iso` 用に install)由来の **17.10**(実測)で、rebuild しても post-create で再取得されるため**別途の永続化は不要**。Supabase 側が PG18 以降へ上がった日に初めて壊れるので、§2 Step 2 (a) の版突合を毎回先に置いている。

> **この節が「復元できる」と言っていない点に注意**。言っているのは「復元の材料が、構造的に健全な形で、記録つきで手元にある」ところまで。実 restore の保証は公開時に格上げする(上記トリガー)。

### 5.3 Dexie(client)側も一方通行

code deploy と同時に、訪問したブラウザから順に **v10 → v11 → v12** の upgrade が走る(v11 で `user_settings` と `entity_mutations` を drop、v12 で `entity_mutations` を新 index で再作成)。

- **端末に残っていた未送信の entity mutation は失われる**(v11 の drop 時点)。ユーザー 0 前提で受容済み(spec §5.3・裁定 5)。
- **deploy を戻しても、既に upgrade された IndexedDB は v12 のまま**。したがって client 側も前方修正のみ。
- upgrade 失敗時は `getClientDb().open()` が reject し、**local-first 機能が全停止**する(演習・カード編集・pull)。IDB の versionchange tx は失敗時に原子的 rollback → 再 open で再実行されるため中間状態は残らないが、**同じ原因なら再 open でも同じ失敗を繰り返す**。
- **v12 以降、共有ブラウザに残る他 user の pending 行は無期限に溜まる**(各 user の flush は `[user_id+sync_status]` で自分の行しか拾わないため、他 user の行は誰にも drain されない)。**受容済み**(spec §5.3・answer_events と同じ意味論)。sign-out 時の purge は本 sprint では作っていない — 実害が出るのは共有端末で複数 account を使った場合の IDB 使用量のみ。

---

## 6. stg 適用がテストを兼ねている部分(省略できない理由)

### 6.1 「データ入り 0035 DB → 0036」経路は stg 適用が唯一の実証

自動テスト(`pnpm test:iso`)は **毎回まっさらな DB を作って全 migration を頭から流す**。つまり検証されているのは「**空の DB に 0036 が当たること**」だけで、**「0035 まで運用された、行の入っている DB に 0036 が当たること」は一度も実行されていない**。

具体的に、空 DB では構造的に起こりえない失敗:

- `SET NOT NULL` が既存 NULL 行に当たる(§1.2 — まさに未確認の残リスク)
- `ADD CONSTRAINT CHECK` が既存の違反行に当たる(§1.3)
- `DROP COLUMN` が想定外の依存オブジェクト(view / 関数)に当たる

**したがって stg 適用は「本番前の練習」ではなく、この経路の唯一の実行である。**§1 の診断結果と §3 の照合結果を、要約でなく**生出力で** session doc に残す。

### 6.2 stg smoke の必須項目

deploy + migrate 後、OT 指示で CC が DevTools MCP(Playwright)で実走する。

#### (a) **【必須】Dexie v10 → v12 upgrade を実ブラウザで・2 タブで**

自動テスト(`lib/client-db.upgrade.test.ts`)は fake-indexeddb 上で v10 を組み立てて upgrade を実走するが、**実ブラウザの IndexedDB 実装と、他タブが旧 version の接続を保持している状態での upgrade 調停は再現しない**。

> **何を確認するのかを取り違えないこと** — 検証対象は「**Dexie の versionchange 自動 close で upgrade が自力で進むこと**」であって「blocked のまま止まること」ではない。
> Dexie は**既定で** `versionchange` を購読しており、他タブが新 version を要求すると `console.warn("Another connection wants to upgrade database 'recallmint'. Closing db now to resume the upgrade.")` を出して**自分の接続を自動で閉じる**(`node_modules/dexie/dist/dexie.js` の `this.on('versionchange', …)` → `close({ disableAutoOpen: false })`・現物確認 2026-08-12)。
> したがって**操作者が 1 つ目のタブを閉じなくても upgrade は進むのが正常**。「blocked のまま解消しない」を期待値にすると、健全な状態を fail と判定してしまう。

> ### ★ **v10 の seed は deploy 前に済ませる(§2 Step 0 の前)。後からでは作れない。**
>
> IndexedDB は **origin scope**。deploy 後に stg origin(`stg.recallmint.nekotest.net`)で `/app` を開くと、その瞬間に**新 code の `ClientDb` 定義が走って v12 になる** — 「v10 を育てる」ことはもうできない。**旧 deploy の URL を開く回避も効かない**: Vercel の deployment 個別 URL は **別 origin** なので、そこで作った IndexedDB は stg origin の IndexedDB ではない。
>
> **したがって手順 1 は §2 Step 0(code deploy)より前に実行する。** これを飛ばした場合、この項目は**未実施として記録する**(「pass」と書かない)。強行するなら、stg origin の console から `indexedDB.open('recallmint', 10)` で v10 の store / index 構成を手で組み直すしかない(`lib/client-db.ts` の v1〜v10 宣言の累積を転記する必要があり、誤ると検証自体が無意味になる)。

1. **【deploy 前】** stg origin にサインイン済のブラウザ profile で `/app` を開き、IDB を **v10** まで育てる(下の手順 4 の console snippet で `version` が 10 であることを確認)。**このタブを開いたまま**にする(= Dexie の v10 接続を保持する)。site data を消さない。
2. **【deploy 後】** 手順 1 のタブを**開いたまま**、2 つ目のタブで `/app` を開く(= 1 つ目のタブが v10 接続を保持したまま、2 つ目が v12 への upgrade を要求する状態)。
3. **期待(操作者は 1 つ目のタブに触らない)**:
   - 1 つ目のタブの console に **`Another connection wants to upgrade database 'recallmint'. Closing db now to resume the upgrade.`** が出る(= Dexie の自動 close が発火した証拠)。
   - **2 つ目のタブの upgrade が自力で完走**し、`/app` が正常に描画される(手順 4 で `version` = 12)。2 つ目のタブに一瞬 `Upgrade 'recallmint' blocked by other connection holding version 10` が出てから解消するのは**正常**(Dexie の `blocked` 警告 → 自動 close → 再開)。
   - 1 つ目のタブは接続が閉じた状態になる。**その後の操作(reload / 画面遷移)で白画面・無限ローディングにならないこと**(Dexie は `disableAutoOpen: false` で閉じるため次の操作で v12 として再 open する)。
   - **NG = 2 つ目のタブが blocked のまま解消しない / どちらかのタブが白画面・無限ローディング。**
   - (任意)**本当の blocked を見たい場合**は、versionchange を購読しない生の接続を 1 つ目のタブで作る: `indexedDB.open('recallmint')` で得た `db` を閉じずに保持する。これは Dexie の調停を意図的に外した条件なので、**必須項目ではなく追加観察**として扱う。
4. IDB を直読みして確認(Dexie インスタンスは module scope なので console から掴めない):
   ```js
   await new Promise((res, rej) => {
     const r = indexedDB.open('recallmint')            // DB 名は lib/client-db.ts
     r.onsuccess = () => {
       const db = r.result
       console.log('version', db.version, 'stores', [...db.objectStoreNames])
       db.close(); res()
     }
     r.onerror = () => rej(r.error)
   })
   ```
   deploy 前(手順 1)は **`version` が 10**、upgrade 完了後(手順 3)は **`version` が 12** / `objectStoreNames` に **`user_settings` が無い** / `entity_mutations` は存在して **0 件**。
   > この snippet 自体は version 指定なしの `open` なので **upgrade を誘発しない**(既存 version でそのまま開く)。手順 1 の確認に使っても v10 を壊さない。
5. console に `UpgradeError` / `VersionError` / `DatabaseClosedError` が出ていないこと。

**失敗時**: 前方修正のみ(ユーザーに IDB 削除を求める運用は取らない)。deploy を戻しても壊れた IDB は残る。

#### (b) upload 一巡

窓が閉じた(= migrate 済み)後に、upload → OCR → prepared → publish → exam 一覧反映 まで 1 回通す。**窓中の 23502 が解消したことの確認**と、`upload_records` / `source_documents` の INSERT が新しい列構成で通ることの確認を兼ねる。

#### (c) exam 一覧 / 演習 / タグ編集

`archived_at` / `card_count` の読み手を全撤去した経路(exam 一覧の件数表示は Dexie 動的集計)と、owner-scope 化した entity_mutations flush(カード編集・タグ並べ替え)が動くこと。

---

## 7. prod 適用について

**本 runbook は stg 適用を主対象に書いている。** prod への反映は stg smoke の結果を見て OT が判断する別 phase であり、その時点で:

- §5.2 の **restore 検証済み backup** を用意する(prod では必須)
- §1.2 の NULL 行確認を **prod に対して改めて実行する**(stg で 0 行でも prod の答えにはならない — 別の DB であり、0027 世代からの持ち上がり方も違いうる)
- §1.3 の診断も prod に対して再実行する

を前提とする。stg の結果を prod の根拠に流用しない。
