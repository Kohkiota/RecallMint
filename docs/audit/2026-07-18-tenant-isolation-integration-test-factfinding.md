# テナント隔離 統合テスト基盤 fact-finding(Iso-0)

- 日付: 2026-07-18 / branch: `develop`(HEAD `7140945`)
- 目的: launch blocker「実 PostgreSQL 2 テナント統合テスト」sprint の **spec 前提事実の確定**。todo v46 の launch blocker 節が出発点だが、記述を事実として扱わず現物で再確認した。
- **本 doc は調査のみ・変更なし・推奨なし**。乗り物採否 / RLS 導入判断は claude.ai / OT 専権(§5 比較表は事実のみ)。
- 方法: 4 並列 subagent(境界 inventory / DB client+migration / pull ページング / 既存資産)で網羅 sweep → **load-bearing な項目は CC 本体が現物 grep/Read で独立裏取り**。裏取り済み項目は「[裏取り済]」と明記。版情報は Context7 + 現物(sandbox が registry 直叩きを deny したため一部 pin 時再確認)。

---

## 0. 要約(load-bearing facts)

1. **[裏取り済] 隔離は 100% アプリ層**。migration 25 本(0000–0024)に **RLS / policy / trigger / plpgsql / enum / 拡張は皆無**(全 grep 0 hit)。テナント境界は例外なく `WHERE user_id = ?`(drizzle `eq(...)`)で、DB 側の強制機構は無い。→ この test の検証対象 = **クエリ構築層が正しく owner 列で絞れているか**であり、3 乗り物いずれも同一に実行する層。
2. **[裏取り済] 既存カバレッジは全て「構造 pin(eq-spy)」で挙動未検証**。`lib/exams/list.owner-isolation.test.ts` は自身の header に「`eq(userId)` を除去しても通過することを変異実測で確認済」と明記。= 「B のクエリに A の行が混ざらない」を観測する test は **1 本も無い**。これが launch blocker の核心 gap。
3. **[裏取り済] userId は常に auth 由来**。request body / outbox row / query param 由来の userId を `WHERE user_id` に使う経路は無い。client 供給は row ID(`entity_id` / `card_id` / `session_id` 等)のみ。
4. **[裏取り済] 例外 2 件が spec 設計に効く**:
   - **OCR completion/failure 書込が owner-scoped でない**(`completeUploadTx` / `markFailed` は `WHERE source_documents.id` のみ、`user_id` 述語なし)。`sourceDocumentId` は server 由来ゆえ現状 exploit 不可だが「全 query に user_id」規律の逸脱。behavioral 2 テナント test はこの 2 write を明示的に扱う必要あり。
   - RSC 4 page が tenant key に Clerk JWT claim `dbUserId`(server 署名・body 非由来・未浸透時 `getCurrentUser()` fallback)を使う。理論上のみの論点。
5. **[裏取り済] pull にサイズ page は存在しない**。delta(high-water-mark)同期で単発 unbounded `SELECT`。→ 課題文 §3「複数 chunk を強制する最小行数」は**実体なし**(何行 seed しても 2 chunk 目は発生しない)。
6. **[裏取り済] getDb() は `DATABASE_URL` 遅延 singleton**。実 PG 系乗り物(常駐 / testcontainers)は **env 差し替えのみでコード変更ゼロ**で注入可。pglite は in-process WASM で TCP endpoint を持たないため env では注入不可 = **`vi.mock('@/lib/db')` か getDb() リファクタが必要**(mock は既存 test の確立パターン)。
7. **[裏取り済] migration が使う PG 機能は全て pglite 対応範囲**(core `gen_random_uuid()` + jsonb/GIN/btree/array/numeric/FK/composite PK。拡張・trigger・RLS 不使用)。pglite 互換性の机上ブロッカーは検出されず。
8. どの乗り物でも新規に要る土台: **user 行生成 / N≥2 テナント fixture / test 用実 DB 接続 wiring / auth-context faker / migration 適用 / behavioral 隔離 assertion**。既存 seed/fixture は単一テナント前提で流用は部分的。

---

## 1. テナント境界 全経路 inventory

### 1.1 テナントモデル(userId の入手元)
テナント key = `users.id`(内部 UUID。**Clerk id ではない**)。server-trusted な 3 helper 経由:

- `getCurrentUser()` — `lib/auth/ensure-user.ts:38-51`。**[裏取り済]** `cache()` 済。Clerk `auth()` → `SELECT * FROM users WHERE clerk_id = auth().userId LIMIT 1`。全 server action / API route / page の正本。
- `getAuthContext()` — `lib/auth/ensure-user.ts:69-82`。**[裏取り済]** `auth().sessionClaims.dbUserId`(Clerk 署名 JWT の publicMetadata 由来)を DB SELECT 無しで読む。未浸透時 `undefined` → 呼出側で `getCurrentUser()` fallback。RSC 4 page のみ使用。
- `withReadOnlyAuth()` — `lib/auth/with-read-only-auth.ts:47-78`。read route を wrap、`getCurrentUser()` の `user` 行を handler に渡す。

`user_id` を持たない table(テナント WHERE 対象外): `ai_usage` / `stripe_events` / `clerk_events`(冪等・global)。`integration_failures` は nullable `user_id`・FK なし・append-only 監査(`WHERE user_id` で読まれない)。

### 1.2 経路 inventory(subagent 網羅 sweep。件数優先)
> 注: 下表は subagent の全 sweep 結果。§0/§1.3 の load-bearing 項目は CC 本体裏取り済、個々の行の file:line は未全数再検証(fact-finding の精度水準として受容)。「test」列は該当経路を pin する既存 test の有無(大半は **eq-spy = 構造 pin**、挙動未検証 — §4.1 参照)。

**(1) pull / sync reads** — 全て `GET /api/pull`(`app/api/pull/route.ts:56-73`)から `user.id`(`withReadOnlyAuth`)で dispatch。共有 factory `getDeltaRows`(`lib/db/pull-delta.ts:33-45`)が `conds=[eq(config.userIdCol,userId)]`。

| 経路 | 関数 | file:line | userId 源 | 既存 test |
|---|---|---|---|---|
| cards delta | `getCardsDelta` | `lib/db/cards-pull.ts:18-33` | auth | `cards-delta.test.ts`(eq-spy) |
| exams delta | `getExamsDelta` | `lib/db/exams-pull.ts:25-40` | auth | `exams-delta.test.ts`(eq-spy) |
| tombstones delta | `getTombstonesDelta` | `lib/db/tombstones-pull.ts:26-41` | auth | `tombstones-pull.test.ts`(eq-spy) |
| tag_categories delta | `getCategoriesDelta` | `lib/db/tag-categories-pull.ts:31-47` | auth | `pull-delta.test.ts`(eq-spy) |
| tag_options delta | `getOptionsDelta` | `lib/db/tag-options-pull.ts:30-46` | auth | `pull-delta.test.ts`(eq-spy) |
| card_tags delta | `getCardTagsDelta` | `lib/db/card-tags-pull.ts:33-49` | auth | `pull-delta.test.ts`(eq-spy) |
| study_days pull(90d) | `getAllStudyDaysForUser` | `lib/db/study-days-pull.ts:50-60` | auth(`study-days/pull/route.ts:25`) | `study-days-pull.test.ts`(eq-spy) |

**(2) mutation ingest(outbox apply)** — `POST /api/entity-mutations/bulk`(auth `:177`)。dedupe SELECT が `eq(mutationId) AND eq(entityMutations.userId,user.id)`(`:121-130`)、dispatch `entry.apply(tx, user.id, entity_id, patch)`。**client は `entity_id`/`patch` のみ、WHERE userId は常に `user.id`**。

| 経路 | 関数 | file:line | userId 源 | 既存 test |
|---|---|---|---|---|
| dispatch registry | `ENTITY_MUTATION_REGISTRY` | `lib/sync/server/entity-mutation-registry.ts:257-333` | arg `user.id` | `entity-mutation-registry.test.ts` |
| dedupe+log | `processMutation` | `app/api/entity-mutations/bulk/route.ts:97-166` | auth | route.test.ts |
| card create | `applyCardCreateWithId` | `lib/cards/apply-card-mutation.ts:67-115`(exam owner check `:78`) | arg(auth) | `apply-card-mutation.test.ts` |
| card delete | `applyCardDelete` | `lib/cards/apply-card-mutation.ts:131-167` | arg(auth) | 同上 |
| card update_field | `updateCardField` | `lib/cards/card-field-handlers.ts:95-106` | arg(auth) | `card-field-handlers.test.ts`(eq-spy) |
| card_count ± | `bumpExamCardCount` | `lib/cards/card-count.ts:24-40` | arg(auth) | `card-count.test.ts` |

**(3) cards CRUD(outbox 外)**

| 経路 | 関数 | file:line | userId 源 | 既存 test |
|---|---|---|---|---|
| exam-detail cards read | `getCardsForExam` | `lib/exams/list.ts:95-126` | auth | `list.owner-isolation.test.ts` |
| OCR-result cards read | `getCardsForSourceDocument` | `lib/exams/list.ts:165-194` | auth | 同上 / `list.test.ts` |
| options/images update | `handleOptions`/`handleImages` | `lib/cards/card-field-handlers.ts:147-232`(assets ready-check `:185`) | arg(auth) | `card-field-handlers.test.ts` |

**(4) tags CRUD** — `lib/tags/apply-tag-mutation.ts`(category create/update/delete `:44-161`、option create/update/delete `:174-355`)、`handleTagOptionIds`(`lib/cards/card-field-handlers.ts:251-320`、card_tags 全置換)、`applyOcrTags`(`lib/tags/apply-ocr-tags.ts:41-`)。全 SELECT/INSERT/DELETE が `eq(tagCategories.userId,userId)` / `eq(tagOptions.userId,userId)`、card_tags 行も `userId` 保持。test = `apply-tag-mutation.test.ts` / `apply-ocr-tags.test.ts`(owner-scope)。

**(5) exams / MCQ CRUD**

| 経路 | 関数 | file:line | userId 源 | 既存 test |
|---|---|---|---|---|
| active exams read | `getActiveExamsForUser` | `lib/exams/list.ts:24-38` | auth | `list.owner-isolation.test.ts` |
| exam-by-id read | `getExamByIdForUser` | `lib/exams/list.ts:49-66` | auth | 同上 |
| source-doc read(JOIN) | `getSourceDocumentForUser` | `lib/exams/list.ts:140-160` | auth | 同上 |
| create exam | `createExam` | `app/(app)/app/exams/_actions/create-exam.ts:44-56` | auth | `create-exam.test.ts` |
| delete exam(cascade) | `deleteExam` | `app/(app)/app/exams/_actions/delete-exam.ts:38-90` | auth | `delete-exam.test.ts`(owner-scope) |
| upload guard tx | `runUploadGuardTx` | `app/(app)/app/upload/_actions/upload-guard.ts:48-176`(advisory lock `hashtext(user.id)`) | arg(auth) | `process.test.ts` |
| OCR persistence | `saveExtractedCards` | `upload-persistence.ts:14-43` | arg `user.id` | `upload-persistence.test.ts` |
| **OCR completion** | `completeUploadTx` | `upload-persistence.ts:47-79` — **`UPDATE source_documents WHERE id` のみ(user_id なし)** | arg(auth) | 同上 |
| **OCR failure** | `markFailed` | `upload-persistence.ts:85-124` — **同上(user_id なし)** | arg(auth) | 同上 |
| stale reconcile | `reconcileStaleProcessing` | `lib/exams/source-doc-status.ts:77-134`(owner-scoped) | auth | `exams/status/route.test.ts` |
| OCR status poll read | inline | `app/api/exams/status/route.ts:49-57` | auth | 同上 |

**(6) review events / FSRS** — `POST /api/review-events/bulk`(auth `:53`)→ `processSession`(`lib/reviews/ingest-review-events.ts:80-223`)が全 repo call に `user.id`。`upsertSessionGuarded`(`session-repository.ts:281-333`)は `setWhere and(eq(userId,user.id),…)` で client `session_id` 経由の cross-tenant を封鎖。card states / answer_events / reviews / cards UPDATE / study_days UPSERT 全て `eq(cards.userId,userId)` 等(`session-repository.ts:40-260`)。test = `session-repository.test.ts` / `review-events/bulk/route.test.ts`。

**(7) dashboard / study reads** — `getReviewStatsForUser`(`lib/db/streak.ts:25-55`、raw `WHERE user_id = ${userId}::uuid`)、`getSessionCards`(`lib/cards/get-session-cards.ts:19-32`)、user_settings inline read(各 page)、`getCurrentMonthOcrPages`/`canRunOcr`(`lib/ai-usage-mcq.ts:45-96`)、`incrementAiUsage`(`lib/ai-usage-counter.ts:20-45`)。test = `streak.test.ts` / `get-session-cards.test.ts` / `ai-usage-mcq.test.ts` 等。

**(8) settings writes** — `saveSessionLimit` / `saveCustomSessionLimit` / `saveFsrsMode`(`settings/_actions/*`、user_settings UPSERT `userId:user.id`)。test 各 `*.test.ts`。

**(9) assets(image saga)** — `reserveAsset` / `finalizeAsset` / `resolveAssetUrls`(`asset-actions.ts:84-267`、全 `eq(assets.userId,user.id)`、objectKey `users/{user.id}/…`)。test = `asset-actions.test.ts`(owner-scope)。

**(10) GDPR** — **専用 export endpoint は無い**。account delete は Clerk webhook 駆動。`handleUserDeleted`(`lib/clerk/handle-clerk-event.ts:73-228`): `clerkId`→`internalUserId` 解決 → tx 内で users を PII scrub + `DELETE WHERE user_id = internalUserId` を **10 table**(exams, study_days, contact_messages, ai_usage_users, upload_records, user_settings, study_sessions, tombstones, entity_mutations, tag_categories)+ `assets SET status='deleting'`。test = `webhooks/clerk/route.test.ts`(delete-set + scrub invariant pin)。

**(11) Stripe webhook writes** — `whereFor`(`lib/stripe/subscription-repository.ts:34-45`)が SubKey→`eq(users.id|clerkId|stripeCustomerId|scheduleId)`。checkout.completed / subscription.created·updated·deleted / schedule.released 等(`lib/stripe/handle-stripe-event.ts`)。tenant は **Stripe 署名 event の識別子**由来(`constructEvent`)。user 起点 Stripe write(`changePlan`/`cancelDowngrade` 等 `upgrade/actions.ts`)は auth 由来 `user.id`。test = `subscription-repository.test.ts`。

**(別分類)operator / seed scripts**

| script | userId 源 | 注意 |
|---|---|---|
| `scripts/seed-perf-exam.ts` | **`--user-id` 必須**(既存 UUID) | 単一テナント/回。user 行は作らない |
| `scripts/gc-image-assets.ts` | `--user` **任意(省略=全 user)** | owner 条件は conditional |
| `scripts/backfill-card-asset-refs.ts` | `--user` **任意(省略=全 user)** | card ごとの `userId` で書込 |
| `scripts/backfill-clerk-metadata.ts` | なし(全 active user) | `users` 全体 sync |

### 1.3 userId trust-boundary(3 件・§0.3-0.4 の詳細)
**request body / outbox / query param 由来の userId を `WHERE user_id` に使う経路は無い**。以下 3 件のみ性質が異なる:

1. **[裏取り済] RSC 4 page が JWT claim `dbUserId` を tenant key に**(`ensure-user.ts:79`)。`upload/page.tsx:40-93`・`exams/[id]/page.tsx:21-31` は DB read の userId に直接使用(`exams/page.tsx`・`tags/page.tsx` は client component の Dexie key として渡すのみ)。`dbUserId` は Clerk publicMetadata(server が set)→ 署名 JWT 経由、body 偽造不可、未浸透時 `getCurrentUser()` fallback。**唯一 WHERE userId が `users` 直 lookup でない箇所**だが risk は理論上のみ。
2. **[裏取り済] `completeUploadTx`(`upload-persistence.ts:69`)/ `markFailed`(`:103`)は `WHERE eq(source_documents.id,…)` のみで `user_id` 述語なし**。`sourceDocumentId` は owner-scoped guard tx(`runUploadGuardTx`、`user.id` 生成)由来で client 非受領ゆえ現状 exploit 不可。ただし「全 server query に user_id」規律の逸脱で、**behavioral 2 テナント test はこの 2 write を明示設計に含める必要**(A のテナントで作った sourceDoc を B が完了/失敗させられないことの確認、または「id 経路の provenance 依存」を仕様として pin)。
3. **[裏取り済] Stripe/Clerk webhook は署名検証済 event 識別子で tenant 解決**(svix / `constructEvent`)。`auth()` とは別の trust anchor だが client-request の穴ではない。

---

## 2. 乗り物の選定材料(事実)

### 2.1 DB client 生成 / 差し替え口 [裏取り済 — `lib/db/index.ts` 全 Read]
- `getDb()`(`lib/db/index.ts:15-23`)= **遅延 factory + module-level memoized singleton**(import 時 eager 生成でない)。初回 call 時に `process.env.DATABASE_URL` を読み `postgres(url,{prepare:false})`(postgres-js)→ `drizzle(client,{schema})`。
- `prepare:false` は **Supabase Transaction pooler(PgBouncer transaction mode)要件**(comment `:13-14`)。= pooler は prod 固有要素で、いずれの local 乗り物も再現しない(隔離の正しさには無関係。§0.1)。
- `closeDb()`(`:40-48`)は `_client.end({timeout:5})` 後 finally で両 singleton を `null` clear → **env 差替 + `closeDb()` で mid-run 再 point 可**。
- **factory 引数注入は無い**(`getDb()` は無引数、client 注入 setter なし)。
- import 規模: `@/lib/db` を import する file **75**、`getDb()` call site **62**(subagent grep)。
- 現行 test 実践: 実 DB を叩かない。`vitest.setup.ts:21` が `DATABASE_URL ??= 'postgresql://fake:fake@localhost:5432/fake'`(placeholder)。`getDb` を参照する test は全て `vi.mock('@/lib/db')`(確立パターン)。

**注入経路の帰結(§0.6)**: 実 PG over TCP(常駐/testcontainers)は `DATABASE_URL` 差替のみで `getDb()` 無改変。pglite は in-process WASM で TCP endpoint 無 → `vi.mock('@/lib/db')` で `drizzle(pglite)` を返すか、`getDb()` に client 注入口を足す refactor が要る(pglite に TCP を持たせる `@electric-sql/pglite-socket` 別 package もあるが追加コスト)。

### 2.2 migration SQL の PG 機能 [裏取り済 — 全 grep]
- dir: `drizzle/migrations/`(`drizzle.config.ts:15` `out`)。**25 本(0000–0024)**、最新 `0024_bouncy_switch.sql`。snapshot/`_journal.json` は `meta/`。
- **不在(全 0 hit で確認)**: `CREATE EXTENSION` / `CREATE TRIGGER` / `CREATE FUNCTION` / `plpgsql` / `ROW LEVEL SECURITY` / `CREATE POLICY` / `CREATE TYPE` / `AS ENUM` / `GENERATED ALWAYS AS` / partial index(`CREATE INDEX … WHERE`)/ `uuid_generate_v4` / tsvector。
- **使用中の PG 機能**: `gen_random_uuid()`(**PG13+ core・pgcrypto 拡張なし**、8 file)/ uuid 列 / jsonb(+`::jsonb` cast)/ **GIN on jsonb**(0000 で作成 → 0020 で DROP)/ timestamptz `DEFAULT now()` / `text[]`(0003 → 0020 DROP)/ `numeric(10,4)` / `DESC NULLS LAST` index / `real`(float4)/ `USING btree` / `UNIQUE INDEX` / FK `ON DELETE cascade|set null|restrict` / `DROP TABLE … CASCADE` / data-migration DML(`UPDATE … SELECT` backfill、0005/0007)/ composite PK。

### 2.3 pglite 互換性 机上確認(Context7 裏取り)
- pglite = **WASM 版 Postgres**(Node/Bun/Deno、<3MB gzip、`.exec()` で複数文 migration、`.clone()` で per-test 隔離)。source: `/electric-sql/pglite`。
- contrib 拡張 30+ 同梱(`pgcrypto` / `uuid_ossp` / `citext` / `pg_trgm` / `btree_gin` 等)。`plpgsql` は `CREATE EXTENSION IF NOT EXISTS plpgsql` で有効化可。`information_schema` / `pg_catalog` 互換。
- **§2.2 の使用機能はすべて pglite 対応範囲**: `gen_random_uuid()` は PG13+ core(pglite の PG 基盤に内蔵)、jsonb/GIN/btree/array/numeric/FK/composite PK/data DML は全て core。**拡張・trigger・RLS・enum を一切使わない**ため pglite 側の追加有効化すら不要。→ **机上ブロッカー検出なし**。
- drizzle adapter: **[裏取り済]** `drizzle-orm@0.45.2` は `./pglite` export を同梱(disk 確認: `node_modules/drizzle-orm/pglite` 存在)。`import { drizzle } from 'drizzle-orm/pglite'` + `new PGlite()`。migration は `drizzle-orm/pglite/migrator` or `.exec()` で 25 本適用。
- **[裏取り済]** `@electric-sql/pglite` は**現状 未依存**(node_modules 不在)= 追加が要る。

### 2.4 版情報
| 項目 | 値 | 出所 |
|---|---|---|
| drizzle-orm | `0.45.2`(pglite adapter 同梱) | [裏取り済] node_modules |
| postgres-js | `3.4.9` | [裏取り済] package.json |
| pnpm / Node | `10.33.0` / `24.x` | [裏取り済] package.json |
| vitest | `4.1.5` | [裏取り済] package.json |
| `@electric-sql/pglite` | 未依存(要追加)。近時 release は 0.4–0.5 系 | [裏取り済 未依存] / Context7 CHANGELOG |
| pglite 基盤 PG major | **PostgreSQL 16.x 想定 — 本 session で未確定**。pin 時に registry で要確認(Context7 は明示せず、sandbox が registry 直叩き deny) | 要 pin 時確認 |
| Supabase 既定 PG(新規 project) | **PG 15**(2022-12 以降既定。project により 17 も) | Context7 supabase docs |
| `gen_random_uuid()` | Supabase/PG core builtin(拡張不要) | Context7 supabase docs |

> 忠実度の含意: pglite(WASM PG16 系)と Supabase server(native PG15/17)は **同じ Postgres エンジン系だが build/major が非一致**。ただし §2.2 の schema は major 差が効く機能(拡張・新 syntax)を使わない。

### 2.5 コンテナ内 postgres 常駐案のコスト [裏取り済 — subagent + 構造確認]
- devcontainer config: `.devcontainer/devcontainer.json` / `post-create.sh` / `README.md`。base image `mcr.microsoft.com/playwright:v1.58.2`、**単一コンテナ**(`dockerComposeFile` / `features` / Dockerfile なし)、`remoteUser=root`、`IS_SANDBOX=1`。
- lifecycle hook は `postCreateCommand → post-create.sh` **のみ**(`postStartCommand` / `initializeCommand` なし)。
- **`apt-get` は利用可・既に使用中**(post-create.sh step4 Stripe CLI / step6 Chrome、第三者 apt repo 追加込み)→ `postgresql` の apt 導入は既存パターンと機構上整合。
- 現在 DB service は皆無(compose service / feature / apt package なし)。app は `DATABASE_URL`(Supabase)接続のみ。forward port は 3000 / 4983(Drizzle Studio)、**5432 は未 forward**。
- 常駐化に触れる file: `post-create.sh`(apt install + cluster init/start step 追加)/ `devcontainer.json`(**restart 跨ぎ常駐には `postStartCommand` 新設が必要** — base image に init system 未配線。または compose 化 or postgres feature 追加、5432 forward 追加)/ compose 選択時は `docker-compose.yml` 新規。app 側は `DATABASE_URL` 差替のみでコード変更不要。

### 2.6 testcontainers docker socket 要件(採否は claude.ai/OT)
- testcontainers は **devcontainer 内から docker daemon(docker socket)到達が前提**。現 devcontainer は単一コンテナ・base Playwright image・docker feature 無・`IS_SANDBOX=1` で、**socket 到達性は未確認 = 採用の gating 条件**。`@testcontainers/postgresql` devDep 追加が要る。接続は `DATABASE_URL`(container 起動後の host:port)→ `getDb()` 無改変。

---

## 3. ストリーム / ページネーション [裏取り済 — grep 実証]
- **pull にサイズ page は存在しない**。`app/api/pull/route.ts` → `getDeltaRows`(`lib/db/pull-delta.ts:33-45`)は `WHERE eq(userId) [AND gte(cursorCol, since)]` の**単発 unbounded `SELECT`**。`.limit()` / `OFFSET` / `LIMIT` は pull コード全体で **0 hit**。
- 「cursor」は各 stream の watermark(`MAX(updated_at|created_at|deleted_at)`、`lib/db/max-iso.ts`)であり「次 page あり」信号ではない。response `cursors` は 6 stream の watermark 集合、`hasMore`/`nextCursor` は無い。
- 6 stream(cards/exams/tombstone/tag_categories/tag_options/card_tags)は独立 cursor・1 HTTP 往復。study_days は別 endpoint(`/api/study-days/pull`、cursor 無・固定 90 日窓)。review logs は pull 対象外。
- **課題文 §3「複数 chunk を強制する最小行数」= 実体なし**。何行 seed しても 2 chunk 目は発生しない。第 2 回 pull が追加行を返す唯一の道は「first pull 後に watermark ≥ の新規 write が起きた場合」= temporal delta であってサイズ page ではない。→ 2 テナント test の観点は「page 境界」ではなく「**A の watermark/`since` で pull した delta に B の行が 1 行も混ざらない**」に置くのが事実整合。

---

## 4. 既存資産 [裏取り済 — 主要点]

### 4.1 統合テスト現況
- `tests/integration/` = **4 本**(`ls` 確認): `clerk-webhook.test.ts`(DB 全 mock)/ `stripe-webhook.test.ts`(DB 全 mock + JS `Set` で冪等 simulate)/ `legal-pages.test.ts`(**DB/render 無** — `.tsx` source の静的 grep)/ `exam-card-edit-flow.test.tsx`(**実 Dexie over `fake-indexeddb`** — PostgreSQL でなく client mirror)。
- `tests/contract/` = **8 本**(`ls` 確認): route handler の snapshot/contract、共有 `tests/fixtures/*` の drizzle chain mock、単一 canonical user。
- **`lib/exams/list.owner-isolation.test.ts` = 現存で最もテナント隔離に近い**が、**[裏取り済]** 自 header に「chain mock は `where()` 引数を検証できない。`eq(userId)` を除去しても通過することを変異実測で確認済(`docs/audit/2026-07-17-test-quality-audit.md`)」と明記。eq-spy は「owner 列で `eq` が呼ばれた」を**構造 pin**するのみで「別 user の行が実際に除外される」は観測しない(MEMORY「eq-spy は構造 pin・隔離未検証」と一致)。
- **どの既存 test も実 PG を叩かない**(実 DB access は `scripts/**` の手動 stg 実行のみ)。→ 新 real-PG 2 テナント harness は上記 4+8 を **REPLACE せず COEXIST**(webhook 系は handler-logic mock、legal は静的、edit-flow は Dexie tier で別レイヤー)。owner-isolation test だけは新 harness が **behavioral 上位互換**(構造 pin → 実行動観測)になり得る。

### 4.2 seed / fixture 資産
- `scripts/seed-perf-exam.ts`: **実 PG seeder**(`getDb()`、手動 stg)。tag dict(4 category)+ exams(`[PERF-SEED]` prefix)+ cards(既定 300、chunk 50)+ card_tags。**`--user-id` 必須(既存 UUID)、user 行は作らない、単一テナント/回**。prod guard L1-L3、`--dry-run`、`--cleanup`。pure helper は unit-tested。
- `tests/fixtures/*`: **全て test-double**(実 DB 非対象)。`common.ts`(`FIXED_USER_ID`、`stubClock`/`stubUUID`、req builder)/ `_drizzle-mock.ts`(chain mock)/ `pull.ts`(`fakeCard`/`fakeExam`/`fakeTombstone`/`fakeCardTag`、client-mirror snake_case shape)/ `entity-mutations.ts`(stateful fake tx)/ `webhooks-*.ts`。**いずれも単一 user 既定、N テナント helper 無**(override で `user_id` 差替は可)。
- **auth-context faker は無い**: pattern は `vi.mock('@/lib/auth/ensure-user')` で `getCurrentUser` を per-test mock。実 Clerk-authed request context / test-token builder は存在しない。

### 4.3 新 harness が乗り物に依らず要る土台(gap)
(a) **user 行生成**(既存に user を作る資産ゼロ、seed は既存 UUID 前提)/ (b) **N≥2 テナントの 1-setup fixture** / (c) **test 用実 DB 接続 wiring**(dep + config 不在)/ (d) **auth-context faker**(現状 mock-the-seam のみ。`getCurrentUser`/`getAuthContext`)/ (e) **migration 適用**(25 本を test DB へ)/ (f) **behavioral 隔離 assertion**(現行は eq-spy 構造 pin のみ)。

---

## 5. 乗り物比較表(忠実度 / devcontainer 影響 / 速度)— **推奨なし・事実のみ**

| 観点 | pglite(WASM 埋込) | コンテナ内常駐 PG | testcontainers |
|---|---|---|---|
| エンジン忠実度 | 実 Postgres の WASM build(PG16 系・要 pin 確認)。§2.2 の全機能対応。単一接続・埋込ゆえ**同時接続/pooler 挙動は再現不可**(本 test は逐次・隔離は app 層 WHERE ゆえ正しさに無影響) | **native Postgres**。Supabase の major に合わせ選択可。同時接続/wire protocol も native | native Postgres(公式 postgres image、major 選択可)。忠実度は常駐と同等 + run 毎 fresh 隔離 |
| Supabase 差 | build/major 非一致(WASM PG16 vs native PG15/17)。PgBouncer transaction pooler(`prepare:false` 要件)は非再現 | major 一致可。pooler は非再現 | major 一致可。pooler は非再現 |
| 注入(getDb) | **env 不可**(TCP endpoint 無)→ `vi.mock('@/lib/db')` で `drizzle(pglite)` 返す or `getDb()` refactor。既存 mock パターンに乗る | **`DATABASE_URL`=localhost:5432 差替のみ・コード変更ゼロ** | **`DATABASE_URL`=container host:port 差替のみ・コード変更ゼロ** |
| devcontainer 影響 | `@electric-sql/pglite` devDep 追加のみ。**apt/service/compose 変更なし** | 最大: `post-create.sh` に apt install + cluster init、`devcontainer.json` に `postStartCommand` 新設(restart 跨ぎ常駐)、5432 forward。compose or feature 化も選択肢 | `@testcontainers/postgresql` devDep + **docker socket 到達が前提**(現 devcontainer で未確認 = gating)。socket 確保後は起動 code のみ |
| 速度 | in-process・network/container 起動なし。`.clone()` per-test。**最速** | native query 高速。ただし常駐 process + container build/start コスト | native query 高速。container pull(初回)+ run 毎 start(数秒級)。pglite より起動遅・「無し」より速 |
| migration 適用 | `.exec()` / `drizzle-orm/pglite/migrator` で 25 本 | drizzle migrate(実 PG) | 同左(fresh container へ) |
| 追加依存 | `@electric-sql/pglite` | apt postgresql(+ 場合により compose) | `@testcontainers/postgresql`(+ docker socket) |

---

## 付録: 調査メタ / 未確定事項
- 方法: 4 並列 general-purpose subagent(foreground、CLAUDE.md 規律)+ CC 本体裏取り。裏取り済 = §0 全項 / getDb 全 Read / migration 全 grep / OCR write 2 件 Read / owner-isolation header Read / pull ページング grep / 版情報(node_modules・package.json)。
- **未確定(spec/実装フェーズで要確認)**:
  1. **pglite 基盤 PG major/minor**(§2.4)— pin 時に `@electric-sql/pglite` 版と対応 PG を registry で確認(本 session は sandbox が registry deny)。
  2. **testcontainers の docker socket 到達性**(§2.6)— 現 devcontainer から docker daemon に届くか未検証。
  3. §1.2 の個別 file:line は subagent sweep(load-bearing 以外は未全数再検証)。
- 関連 doc: `docs/audit/2026-07-17-test-quality-audit.md`(eq-spy 限界の一次記録・本 sprint follow-up の起点)/ MEMORY `project_test_quality_audit_2026_07_17`(launch blocker 定義)。
