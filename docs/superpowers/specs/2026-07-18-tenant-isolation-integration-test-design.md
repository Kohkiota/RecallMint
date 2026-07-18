# 実 PostgreSQL 2 テナント統合テスト — design (Iso-1 spec)

- 日付: 2026-07-18 / branch: `develop`
- 前提 doc: `docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md`(Iso-0)
- scope: **spec のみ**(実装は次 prompt)。本 spec が writing-plans の入力。
- 存在理由: mock が現実を隠す eq-spy 群では「B の query に A の行が混ざらない」を**一度も観測していない**(Iso-0 §0.2)。実 PG に 2 テナントを置き、隔離を**挙動として**検証する suite を作る。

## 0. 確定事項(OT/claude.ai 決定済・spec で再議論しない)

1. **乗り物 = devcontainer 内 常駐 PostgreSQL 17**(Supabase prod = 17.6)。`DATABASE_URL` 差替のみでアプリコード変更ゼロ、`getDb()` → postgres-js(`prepare:false`)→ TCP → native PG の本番同一スタックを test が通る。
2. **OCR 2 write の owner 述語 fix を scope に含める**(`completeUploadTx` / `markFailed`)。pin でなく fix。Gemini prompt / `ocr-extract.ts` / response schema は不可触(DB 層のみ)。
3. **既存 test は COEXIST**。eq-spy 群は構造回帰ガードとして残置、セキュリティ主張のみ新 suite が引き取る。`list.owner-isolation.test.ts` header 文言は新 suite 参照に更新可。
4. **RLS 導入は scope 外**(独立 sprint)。
5. 検証観点 = Iso-0 §3 訂正: pull はサイズ page でなく「A の `since` で引いた delta に B の行が混ざらない」(6 delta stream + study_days)。

## 1. spec 段の現物再確認(Iso-0 を鵜呑みにしない)

| 事実 | 再確認結果 | 出所 |
|---|---|---|
| user_id 保持 table 数 | **19**(下記)。非保持 5 = `users`(tenant 本体・key は `id`)/ `ai_usage` / `stripe_events` / `clerk_events` | `lib/db/schema.ts` 全 pgTable parse |
| 隔離機構 | migration 25 本(0000–0024)に RLS/policy/trigger 皆無 → 隔離は 100% app 層 `WHERE user_id`(`eq`) | 全 grep 0 hit |
| getDb 注入 | `DATABASE_URL` 遅延 singleton・`postgres(url,{prepare:false})`・`closeDb()` で null clear | `lib/db/index.ts:15-48` |
| migration 適用手段 | `drizzle-orm/postgres-js/migrator`(disk 存在)で programmatic 適用可。CLI は `drizzle-kit migrate` | node_modules 確認 / `drizzle.config.ts` |
| vitest 既定 include | `tests/**/*.test.ts` を sweep = **PG suite は default から明示 exclude が必要** | `vitest.config.ts` |
| DATABASE_URL 既定 | `vitest.setup.ts:21` が `??= 'postgresql://fake:...'`(PG suite は依存せず hard-set) | 現物 |
| OCR 2 write | `completeUploadTx`(`:69`)/ `markFailed`(`:103`)ともに `WHERE eq(sourceDocuments.id)` のみ(user_id 述語なし) | 現物 |

**user_id 保持 19 table**(fixture 完全性の対象母集団): `reviews` / `ai_usage_users` / `integration_failures` / `exams` / `cards` / `source_documents` / `upload_records` / `study_days` / `user_settings` / `contact_messages` / `study_sessions` / `answer_events` / `entity_mutations` / `tag_categories` / `tag_options` / `card_tags` / `tombstones` / `assets` / `card_asset_refs`。

## 2. アーキテクチャ(harness 構成要素)

すべて新規、実装は `tests/integration/pg/` 配下 + 専用 vitest config。既存 mock suite とは物理分離。

1. **専用 vitest config**(`vitest.integration-pg.config.ts`): `include: ['tests/integration/pg/**/*.test.ts']`、`globalSetup` + `setupFiles`(下記)。既存 `vitest.config.ts` に `exclude: ['tests/integration/pg/**']` を追加し `pnpm test`(既存 ~3765)から除外。
2. **globalSetup**(suite プロセス 1 回): 常駐 PG17 の maintenance DB へ接続 → `recallmint_test` を drop→create(clean slate)→ `migrate()` で 25 migration 適用。= schema 構築 + 「25 migration が PG17 で clean に通る」の副次検証。teardown で接続 close。
3. **safety setup**(単一 URL 定数 + guard を 1 module に集約): `process.env.DATABASE_URL` を localhost test DB に **hard-set(代入。`??=` 非依存)** → **allow-list guard**(URL 全体を parse し、protocol=postgres(ql) / **host = `127.0.0.1` 固定**(`localhost` は名前解決依存ゆえ不許可)/ **port 固定** / **DB 名 = 固定 `recallmint_test`**(suffix 一致でなく完全一致)を満たさなければ throw。parse 失敗・空 host・IPv6・想定外 port も throw)。**検査した URL そのものを接続に使う**(TOCTOU 防止)。Supabase に構造的に届かない不変条件。この guard は **setupFiles だけでなく globalSetup 自身も接続前に呼ぶ**(§3課題3)。**`@/lib/db` は mock しない**(real getDb)。
4. **2 テナント fixture**(`makeTenantFixture`): tenant A / B を `users` に作成し、**全 19 user_id table**(`integration_failures` 含む)に **A・B 双方の行**を seed。返り値で A/B の row id 群を露出(越境 assertion が B の id を使う)。**seed 集合(全 19)⊋ isolation-assertion 集合**(owner-scoped read/write path を持つ table のみ assert 対象。§3課題1)。
5. **fixture 完全性 assertion**(anti-vacuous-green backbone): **三者一致**を assert — (a) Drizzle schema を introspect した `user_id` 列 table 集合、(b) migration 適用後の**実 PG catalog**(`information_schema.columns`)の `user_id` 列 table 集合、(c) **expected-19 の明示 list**。三者が一致し、かつ全 19 に A・B 双方 ≥1 行を確認。Drizzle だけの introspect は「検出器と fixture が同じ漏れ方をする」盲点を残すため実 catalog + 明示 list と突合。新 user_id table を追加したら三者不一致で **fail**。**exclusion allow-list は isolation-assertion 集合からのみ**(seed からは除外しない)。初期 exclusion = `integration_failures`(owner-scoped read 経路が無い append-only 監査。seed はする)。
6. **auth seam helper**(`withTenant(user, fn)`): route handler / server action 経由の経路のみ `getCurrentUser`/`getAuthContext` を該当 tenant で mock(DB は real)。repo/apply 層は userId を引数で直接受けるため mock 不要。= **「auth だけ mock・DB は本物」**が新 suite の既存 test との決定的差。

### per-test 隔離 + 直列実行
`beforeEach` で全 seed 対象 table を `TRUNCATE ... RESTART IDENTITY CASCADE` → fixture 再 seed。real `getDb()`/postgres-js 経路を保ったまま(tx 注入で本番スタックを歪めない)、単純・正確。
- **直列実行が前提**: 単一 test DB を共有するため、Vitest の file/worker 並列実行では相互破壊する。PG suite config で **`fileParallelism: false` + 単一 fork(`pool: 'forks'`, `singleFork: true`)** を設定し全 test を直列化。TRUNCATE+reseed の安全性はこの直列化に依存する不変条件。
- **getDb lifecycle**: suite teardown / env 切替時に必ず `closeDb()`(接続残存で `DROP DATABASE` 失敗・プロセス hang を防ぐ)。DROP 前に対象 DB への残存 backend を `pg_terminate_backend` で切断。
- 却下(tx-per-test rollback): app が内部で `db.transaction()`(savepoint)を張り、独自 postgres-js 接続を取るため外側 tx に参加できない。getDb singleton とも衝突し本番スタックと乖離。本 suite の目的(実スタック検証)と正面衝突。

## 3. 中心課題の解決(kickoff §「中心課題」対応)

### 課題1: vacuous green の構造排除
- **decoy 原則 + decoy 適格性**: owner-scoped read/delta assertion では、B に「WHERE user_id が消えたら A の結果に混入するはずの行」を必ず置く。ただし **B の decoy 行は対象 query の *非 owner 条件* を全て満たす**必要がある(active/archivedAt/status/`since` 範囲/JOIN 先/timestamp 精度等)。満たさないと owner 述語を外しても B は候補にならず、RED が空振りする。適格性は assertion 個別に設計。
- **positive control(必須)**: 「A の結果集合に B の既知 id が 0 件」だけでは、query が常に空でも green になる(vacuous)。**同 assertion で「A 自身の期待行が返る/A 自身への write・delete が成功する」を必ず verify**。B 不在(negative)+ A 成功(positive)の対で初めて「効いている」を担保。
- **完全性の機構化**(§2.5): 手作業網羅でなく schema introspection で user_id table を列挙し fixture を assert。exclusion は理由付き allow-list のみ。
- **mutation 実証(RED)を plan task 化**: 各 assertion **パターン**につき最低 1 回、本番コードの owner `eq` を一時除去 → suite RED を実測 → 復元、を plan の task に組込み commit message に「red 検証」記録(CLAUDE.md test-quality 增分岐に準拠)。

**assertion パターンと代表選定(根拠付き)**:
| パターン | 代表経路 | 代表の根拠 |
|---|---|---|
| read 混入 | `getActiveExamsForUser` + `getCardsForExam` | list 系 owner-scope の典型。JOIN 有(cards×exams)無(exams)両方を 1 代表で |
| delta 混入 | `getDeltaRows`(cards stream 経由)+ `getAllStudyDaysForUser` | **6 delta stream は単一 factory `getDeltaRows` に集約**(Iso-0 §3)= factory を代表 1 本で家族全体の WHERE 構築を覆う。study_days は別関数ゆえ追加 1 本 |
| write 越境 | `updateCardField`(card update_field)| apply 系 write の `and(eq(id),eq(userId))` idiom 代表 |
| delete 越境 | `deleteExam`(cascade 付)| owner SELECT→child→DELETE の三段 owner-scope の最厚経路 |
| (OCR fix) | `completeUploadTx` / `markFailed` | §4。fix ゆえ RED→fix→GREEN を独立 commit |

> 代表主義の正当化: pull 6 stream は WHERE 構築が単一 factory に集約、apply 系 write は同一 owner idiom の反復。**構造が共有される family は代表 1 本 + fixture 完全性で母集団の未 seed を検出**する二段構えで、全経路個別 RED の N 倍コストを避けつつ vacuous green を塞ぐ。family を跨ぐ(read/delta/write/delete/OCR)境界だけ個別 RED を要求。

### 課題2: 経路網羅の基準(behavioral test の IN/OUT)
**監査可能な成果物**: Iso-0 §1.2 inventory(62 getDb call site)を出発点に、各経路を tenant-facing / tenant 非依存 / webhook / operator / internal-only に棚卸しし、IN/OUT と理由を**表として suite の README に固定**(Self-Review だけでは監査不能。分類単位で理由を残す)。
**IN**(real PG で叩く): owner-scoped read(exams/cards/source-doc/dashboard stats/session-cards/settings/assets)、pull delta(6 stream + study_days)、owner-scoped write/delete(card/tag/exam/review/asset apply)、OCR 2 write(fix 後)。
**OUT**(理由明記):
- **webhook(Stripe/Clerk)**: tenant を署名検証済 event 識別子から解決(`auth()` でない)。別 trust anchor・既存 contract test 済・client 面のテナント境界でない。
- **operator script(seed/gc/backfill)**: CLI 起動・一部は意図的に全 user。per-request 境界でない。
- **RSC `dbUserId`(JWT claim)経路**: WHERE userId の *provenance*(JWT vs DB lookup)差であり、どちらも server-trusted 値。本 suite が検証する **DB 層の隔離は渡す userId 値が同じなら同一挙動**。JWT vs lookup は auth 層の関心事で DB-isolation scope 外(page と同じく suite は `user.id` を直接渡す)。

### 課題3: harness 安全境界
§2.3 の hardened guard(127.0.0.1 固定 host + port + DB 名完全一致、URL 全体 parse)。**順序の要注意点**: Vitest では `globalSetup` が `setupFiles` **より前**に走り、globalSetup 自身が DROP/CREATE/migrate で接続する。ゆえに setupFiles の hard-set は globalSetup の接続先を保護しない。→ **URL 定数 + guard を 1 module に集約し、globalSetup が接続前に guard を直接呼ぶ**。globalSetup は外部 `DATABASE_URL` を参照せず定数を使う(誤って Supabase URL を継ぐ事故を排除)。getDb の memoize より前に env 確定(globalSetup→setupFiles→test)+ 切替時 `closeDb()`。

### 課題4: devcontainer 変更
- `post-create.sh`: PostgreSQL 17 導入 step 追加。base image は Ubuntu 系(Playwright image)で default apt は PG16 のため **PGDG apt repo(apt.postgresql.org)追加 → `postgresql-17` install**(既存 step が Stripe/Chrome で第三者 apt repo を追加する pattern に倣う)。cluster init + role(`postgres`)+ `recallmint_test` DB 用意。**postcondition(`fail()`)**: `pg_isready` / `psql -c 'SELECT 1'` 成功を検証、失敗で非 0。
- **`postStartCommand` 新設**(devcontainer.json): 現状 hook は postCreate のみ・base image に init system 未配線ゆえ、restart 後に cluster が停止する。idempotent な cluster start(`pg_ctlcluster 17 main start` 等、既起動なら no-op)を postStart に追加。
- **5432 forward 不要**(コンテナ内 localhost のみ)。
- `.devcontainer/README.md`: pin 一覧に PG17 追記 + 更新手順 + 責務表更新。
- `.env.example`: app の `DATABASE_URL` は Supabase のまま不変。test DB URL は suite setup 内 localhost 定数(allow-list 付)で app env でない → **`.env.example` 変更なし**。

### 課題5: suite 実行境界
- 新 script: `test:iso` = `vitest run --config vitest.integration-pg.config.ts`。
- `pnpm test`(既存 ~3765)からは **exclude で分離**(live PG 非依存を維持)。
- **sprint 完了 gate**: 本 sprint 完了時 = 既存 whole-repo `pnpm lint`(exit 0)+ `pnpm test`(既存不変)+ **`pnpm test:iso`(新・devcontainer cluster 必須)**。README/CLAUDE.md 相当箇所に「PG suite は cluster 前提・専用 script」明記。dep(pglite 不採用ゆえ `@electric-sql/pglite` 追加なし。追加 devDep は無し想定 — migrator/postgres-js は既存)。

## 4. OCR 2 write owner 述語 fix

- 対象: `app/(app)/app/upload/_actions/upload-persistence.ts` の `completeUploadTx`(`:60-69`)/ `markFailed`(`:100-103`)。
- 変更: `.where(eq(sourceDocuments.id, id))` → `.where(and(eq(sourceDocuments.id, id), eq(sourceDocuments.userId, userId)))`。**両関数とも userId を既に受領**(`args.userId` / `audit.userId`)= signature 変更なし。
- **affected-rows 確認**(取得法は postgres-js/drizzle の実戻り値を**実 DB で確認**して確定):
  - `completeUploadTx`: 更新 0 行 = 所有権違反 or doc 消失 → **throw**。正常単一テナント経路は id/userId 一致で**厳密に 1 行**(複数行不可)を確認。
  - `markFailed`: **best-effort no-throw 契約を維持**ゆえ 0 行時は `logger.warn` のみ。**warn に PII / 機密 id を載せない**。
- **呼出契約リスク(要調査)**: `completeUploadTx` の 0 行 throw が既存 tx / retry / エラー分類 / ユーザー応答に与える影響を呼出元まで確認。retry や「既完了」状態を許す設計と衝突しないか(§8 論点)。
- **観測は関数契約に合わせる**: 呼出側は「affected rows」を直接観測できない(complete は throw、fail は warn)。GREEN の観測対象は **complete=throw が起きる / fail=warn かつ B の doc 不変 / 両者とも B の doc が変わらない**、で関数ごとに分ける。
- 順序(独立 commit): (a) RED 実証 = **`completeUploadTx`/`markFailed` を userId=A・sourceDocumentId=B で直接呼び**、現行 fix 前に B の doc が更新されてしまうことを実測(= DB 層述語欠落の実証。上位 auth 経路の検証ではない)→ (b) fix → (c) GREEN。fix は `fix()` + canonical review + Codex(security 相当・§6)。

## 5. phase 分割(G→R→W→O)

- **Phase G(土台)**: devcontainer PG17 + vitest PG config + globalSetup(provision+migrate)+ safety setup(hard-set+allow-list)+ 2 テナント fixture + 完全性 assertion + `withTenant` helper。**harness 自己検証**として read 混入代表 1 本 + その RED を含め、harness が実際に leak を捕まえることを実証。
- **Phase R(read/delta)**: owner-scoped read assertion 群 + pull delta(factory 代表 + study_days)cross-tenant。decoy + パターン代表 RED(read 混入 / delta 混入)。
- **Phase W(write/delete)**: cross-tenant write/delete assertion(card update / exam delete 代表 + tag/review/asset を behavioral に)。パターン代表 RED(write 越境 / delete 越境)。
- **Phase O(OCR fix)**: RED→fix→GREEN(§4)。source 変更ゆえ独立 commit・review 必須。順序は最後(OT ordering)。

各 phase の test は新規 assertion(增)= red 検証必須 + 簡易 review → `[reviewed]`。Phase O の fix は重要 fix 経路(§6)。

## 6. review / gate 方針(実装 prompt への申し送り)

- feat/fix 系 = canonical `superpowers:requesting-code-review` + Codex(`scripts/ai/codex-review.sh`)。test 增分は red 検証 + 簡易 review。
- **OCR fix は security 相当**(テナント越境 write 封鎖)→ canonical + Codex pass 後、stg smoke 要否を実装時判断(正常完了経路が 1-row 維持で回帰しないことの確認)。push→smoke 構造なら session doc を [reviewed] 正記録に。
- sprint 完了報告に「whole-repo lint exit 0」+「`pnpm test` 既存不変」+「`pnpm test:iso` green」を明記。

## 7. 非目標(YAGNI)

RLS 導入 / migration 網羅テスト化 / webhook・operator の behavioral 化 / testcontainers 化 / pglite 併存 / connection pool 挙動の再現。いずれも本 sprint 外。

## 8. 未解決論点

### A. plan/実装で潰す(CC 判断)
1. PGDG apt repo の post-create 時 network 到達性・実 apt 手順・cluster init command(§3課題4)。要実機。
2. seed 前提行順(users→exams/tag_categories→cards/tag_options→…→reviews/answer_events)。plan で。
3. auth seam mock の範囲: repo 直呼び(userId 引数)で代替可能な経路は直呼びが安価。route/action 経由は最小限 + **tenant 切替の実証 test**(Vitest module cache で mock 反映されない罠を潰す)。
4. `completeUploadTx` 0 行 throw の呼出契約影響(retry/既完了状態との衝突有無)。実装時に呼出元を調査。

### B. OT 判断(claude.ai/OT 決定要・plan 確定前に確認したい)
1. **test DB 命名 = 固定 `recallmint_test` vs run 固有名**。CC 案 = 固定(直列実行 + 単一 devcontainer で race は非問題化、cleanup 単純)+ DROP 前 `pg_terminate_backend`。run 固有は並列/多 worktree に強いが cleanup 増。→ 固定を推奨。
2. **allow-list 強度 = `127.0.0.1` 固定 host + 固定 port + 固定 DB 名**(CC 案・launch blocker 安全境界ゆえ最強を採用)vs `localhost` 許容(環境互換優先)。→ 127.0.0.1 固定を推奨。
3. **test:iso の silent regression 防止**(no-GHA/PR なし運用ゆえ CI が無い)。CC 案 = sprint 完了 gate + review checklist に恒久組込み(既存規律の拡張)+ 任意で lefthook pre-push。CI 再導入は「外部設定変更」ゆえ OT 専権。この決定なしだと将来のテナント境界 regression が gate をすり抜ける。
4. **OCR `completeUploadTx` 0 行 = throw vs 冪等成功**。throw は所有権違反を明確検知(CC 案)。retry / 既完了許容の設計と衝突するなら冪等成功へ。呼出元契約(A-4)調査結果次第で OT 確認。
