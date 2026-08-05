# テナント隔離 behavioral test 経路 棚卸し(COVERAGE)

- 起点: `docs/audit/2026-07-18-tenant-isolation-integration-test-factfinding.md` §1.2 経路 inventory(`@/lib/db` import 75 file / `getDb()` call site 62)。
- 目的: 実 PG 2 テナント harness(H1/H2 土台)で **behavioral に叩く経路(IN)** と **叩かない経路(OUT)+ その理由** を監査可能な形で固定する。IN = owner-scoped な read / write / delta で、後続 task **R1(read 隔離)/ R2(delta 隔離)/ W1(write 隔離)/ W2(write→delta)/ O1(OCR write provenance)** で「B のクエリ・delta・書込に A の行が 1 行も混ざらない」を実行動観測する。
- 分類語彙: **IN**(tenant-facing・owner-scoped)/ **OUT:webhook**(署名検証済 event 由来)/ **OUT:operator**(CLI 起動・per-request 境界でない)/ **OUT:global**(user_id 無 table)/ **OUT:internal**(IN 経路が内部呼びする helper・IN 経由で transitive にカバー)。
- 既存 test 現況(factfinding §4.1): 現行の owner 系 test は全て **eq-spy = 構造 pin**(「owner 列で `eq` が呼ばれた」の pin のみで「別 user の行が実際に除外される」は未観測)。本 harness はこの gap を behavioral に埋める上位互換であり、webhook/contract/Dexie tier の既存 test とは **REPLACE でなく COEXIST**。

## OUT 理由(分類単位・1 行)

- **OUT:webhook** — tenant key が `auth()` 由来でなく **署名検証済 event 識別子**(Stripe `constructEvent` / Clerk svix)由来。client-request の穴でない。既存 `tests/integration/*webhook*` + `subscription-repository.test.ts` が handler ロジックを contract test 済。
- **OUT:operator** — `scripts/**` は CLI 起動(`--user-id` / `--user` 引数 or 全 user)で、per-request の auth 境界を通らない。owner 条件は引数 conditional。本 suite の scope 外(手動 stg 実行)。
- **OUT:global** — `ai_usage` / `stripe_events` / `clerk_events` は **user_id 列を持たない**(冪等・global counter)。テナント WHERE の対象外。
- **OUT:internal** — IN 経路の内部 helper(watermark 計算 / delta factory / card_count bump 等)。IN 経路の behavioral test で transitive にカバーされ、単独で 2 テナント叩く必要なし。

## 経路分類表

| # | 経路群(factfinding §1.2) | 代表関数 | 分類 | behavioral で叩く | 備考 / OUT 理由 |
|---|---|---|---|---|---|
| 1 | pull / sync reads(6 delta + study_days) | `getCardsDelta` 等 / `getDeltaRows` | IN | YES(R2) | `WHERE eq(userId)[AND gte(cursor)]` の owner-scoped delta。A の `since` pull に B 行が混ざらない |
| 2 | mutation ingest(outbox apply) | `processMutation` / registry dispatch | IN | YES(W1) | dedupe `eq(mutationId) AND eq(userId)`、apply は arg `user.id`。client は entity_id/patch のみ |
| 2i | card_count bump | `bumpExamCardCount` | OUT:internal | NO | W1(card create/delete)経由で呼ばれる副作用。単独叩き不要 |
| 3 | cards CRUD(outbox 外 read) | `getCardsForExam` / `getCardsForSourceDocument` | IN | YES(R1) | owner-scoped read。B の card が A の一覧に出ない |
| 3w | cards field write | `handleOptions` / `handleImages` | IN | YES(W1) | arg(auth)`user.id`、assets ready-check owner-scoped |
| 4 | tags CRUD | `apply-tag-mutation` / `handleTagOptionIds` / `applyOcrTags` | IN | YES(W1) | 全 SELECT/INSERT/DELETE が `eq(tagCategories/tagOptions.userId)`、card_tags も user_id 保持 |
| 5 | exams / MCQ read | `getActiveExamsForUser` / `getExamByIdForUser` / `getSourceDocumentForUser` | IN | YES(R1) | owner-scoped read(JOIN 含む)。B の exam/source_doc が A に漏れない |
| 5w | exams write | `createExam` / `deleteExam`(cascade) | IN | YES(W1) | auth `user.id`。delete は owner-scope cascade |
| 5o | **OCR completion / failure** | `completeUploadTx` / `markFailed` | IN | YES(O1) | **`WHERE source_documents.id` のみ(user_id 述語なし)**の逸脱 2 write。provenance 依存(sourceDocumentId は owner guard tx 由来・client 非受領)を仕様として pin し、A の sourceDoc を B が完了/失敗させられないことを確認 |
| 5g | upload guard / OCR persist / stale reconcile / status poll | `runUploadGuardTx` / `saveExtractedCards` / `reconcileStaleProcessing` | IN | YES(W1/R1) | owner-scoped(advisory lock `hashtext(user.id)` / arg `user.id` / owner WHERE) |
| 6 | review events / FSRS | `processSession` / `upsertSessionGuarded` | IN | YES(W1/W2) | 全 repo call が `user.id`、session upsert が `and(eq(userId),…)` で client session_id の cross-tenant を封鎖 |
| 7 | dashboard / study reads | `getReviewStatsForUser` / `getSessionCards` / `canRunOcr` / `incrementAiUsage` | IN | YES(R1) | raw `WHERE user_id = ${userId}::uuid` 含む owner-scoped read/count |
| 8 | settings writes | `saveSessionLimit` / `saveCustomSessionLimit` / `saveFsrsMode` | IN | YES(W1) | user_settings UPSERT `userId:user.id`(PK=user_id) |
| 9 | assets(image saga) | `reserveAsset` / `finalizeAsset` / `resolveAssetUrls` | IN | YES(W1/R1) | 全 `eq(assets.userId)`、objectKey `users/{user.id}/…` |
| 10 | GDPR account delete | `handleUserDeleted`(Clerk webhook 駆動) | OUT:webhook | NO | 専用 export endpoint 無。tenant は svix 検証済 event 由来。`webhooks/clerk/route.test.ts` が delete-set + scrub invariant を pin |
| 11 | Stripe webhook writes | `whereFor` / `handle-stripe-event` | OUT:webhook | NO | tenant は署名 event 識別子(`constructEvent`)由来。`subscription-repository.test.ts` が contract 済。user 起点 Stripe write(`changePlan` 等)は auth `user.id` だが Stripe API 実走のため本 suite scope 外 |
| S | operator / seed scripts | `seed-perf-exam` / `gc-image-assets` / `backfill-*` | OUT:operator | NO | CLI 起動・`--user`/`--user-id` or 全 user。per-request 境界でない |
| G | global 冪等 table | `ai_usage` / `stripe_events` / `clerk_events` | OUT:global | NO | user_id 列を持たない。テナント WHERE 対象外 |

## trust-boundary 上の注意(factfinding §1.3)

- **request body / outbox / query param 由来の userId を `WHERE user_id` に使う経路は無い**(client 供給は row ID のみ・userId は常に auth 由来)。
- 例外的性質 3 件: ① RSC 4 page が JWT claim `dbUserId`(server 署名・body 非由来)を tenant key に使用(理論上のみ)/ ② 上表 5o の OCR 2 write が id-only(= O1 で明示扱い)/ ③ webhook は別 trust anchor(署名)。①③ は本 behavioral suite の対象外(OUT)、② のみ IN で明示 pin する。

---

# RLS-P2 Task 10 追記: null 契約 7 分類の担保 + 5 表配線 matrix

起点: `docs/audit/2026-07-20-rls-p2-lifecycle-null-affected-rows-factfinding.md` §2.2(null を受けた呼出側の全分類)。Task 10 (A) の新規 test `lifecycle-null-contract.test.ts` は 7 分類すべての **分岐元(SOURCE)= getCurrentUser が null/throw/User を返す条件**を実 PG(RLS on)で pin する(claim+行→User / claim+ghost→null / claim なし+未同期→null / claim なし+同期→User / no-session→throw)。下表 1 は **downstream 消費**(各 call site が SOURCE の null をどう扱うか)の担保 test を棚卸す。

## 表 1: null 契約 7 分類 × 担保 test

| # | 分類(FF §2.2) | 代表 call site | null 時挙動 | 担保 test(file:関心行) | 状態 |
|---|---|---|---|---|---|
| SOURCE | getCurrentUser の null/throw/User 契約 | `lib/auth/ensure-user.ts` | claim+行→User / ghost→null / 未同期→null / no-session→throw | **`tests/integration/pg/lifecycle-null-contract.test.ts`(新規・実 PG RLS on)** + `lib/auth/ensure-user.test.ts`(unit・DB mock で claim 呼分け) | 担保 |
| 1 | provisioning 表示(SyncingPage) | `app/(app)/app/layout.tsx:34-39`(route-group layout。root `app/layout.tsx` ではない) | `<SyncingPage/>` render・children 非 render | — | **未担保**(layout 単体 test 無。FF §2.2 が SSR gate の defensive path と明記) |
| 2 | 200 + 空 body | withReadOnlyAuth 4 route | 空 stats/statuses/delta/配列 + DB 未着手 | `app/api/dashboard/stats/route.test.ts:48` / `app/api/exams/status/route.test.ts:80` / `app/api/pull/route.test.ts` / `app/api/study-days/pull/route.test.ts:60`(+ contract 群) | 担保 |
| 3 | 401 + `user_not_synced` | review-events/bulk・entity-mutations/bulk | `{ error: 'user_not_synced' }` 401・DB 未着手 | `app/api/review-events/bulk/route.test.ts:579` / `app/api/entity-mutations/bulk/route.test.ts:396`(+ `tests/contract/*bulk*.contract.test.ts`) | 担保 |
| 4 | ActionResult エラー | settings 3 `_action` / create-exam / delete-exam / asset-actions / upload process | `{ ok:false, error:'認証が必要です' }`(upload は code:'AUTH') | `save-fsrs-mode.test.ts` / `save-session-limit.test.ts` / `save-custom-session-limit.test.ts` / `create-exam.test.ts` / `delete-exam.test.ts` / `asset-actions.test.ts` / `upload/_actions/process.test.ts` | 担保 |
| 5 | throw(error boundary) | settings/actions / upgrade/actions | `Error('USER_NOT_SYNCED')` throw | `app/(app)/app/settings/actions.test.ts:41` / `app/(app)/app/upgrade/actions.test.ts` | 担保 |
| 6 | null render | RSC 9 page(`page.tsx`) | `return null`(空 render) | `page.test.tsx` 群(app/settings/exams[id]/study)は正常系のみ・null-render 分岐は未 assert | **未担保**(FF §2.2「layout が先に SyncingPage → 通常不達の防御」= defensive dead-ish path) |
| 7 | 匿名継続 | `app/(marketing)/page.tsx` / `app/(marketing)/pricing/page.tsx` | landing/pricing を未認証扱いで render | `components/pricing/pricing-table.test.tsx` は component のみ(page の getCurrentUser-null→匿名 render は未 assert) | **未担保** |

**未担保の明示(brief 要件)**: 分類 **1(layout SyncingPage)/ 6(RSC page の `return null`)/ 7(marketing/pricing 匿名 render)** は自動 test 無。3 者とも「layout が先行して SyncingPage を出す / 未認証は proxy と landing が先に処理する」ため FF §2.2 が defensive・通常不達と位置づける SSR-render 経路であり、Task 10 の scope(getCurrentUser SOURCE 契約の実 PG pin + lifecycle behavioral)外。SOURCE 契約自体は (A) が実 PG で担保するため、これら 3 分類の未担保は「分岐元が壊れて全 call site が誤動作する」class ではなく「特定 SSR consumer の描画 assert 欠落」に留まる。

## 表 2: 5 表 × 操作 × 経路 × context 供給元 × eq 述語(Task 3-8 配線の監査証跡)

- **context 供給元** 語彙: `withTenantTx`(helper が tx 冒頭で `set_config('app.user_id')`)/ `内部 setTenantContext`(handler が自前で tx 内に張る=user.deleted tx)/ `definer`(SECURITY DEFINER 関数が RLS を迂回・context 非依存、users 特殊経路のみ)。
- **RLS policy**(`db/policies/rls-p2-enable.sql`): 4 表は `*_tenant`(FOR ALL・USING=WITH CHECK=`user_id=app_current_user_id()`)/ users は SELECT/INSERT/UPDATE 3 policy 別建て・**DELETE policy 無**(app-role hard delete を構造 deny)。

| 表 | 操作 | 代表経路 | app WHERE の eq | RLS policy | context 供給元 |
|---|---|---|---|---|---|
| **users** | read | `getCurrentUser`(claim-present) | `eq(id) AND isNull(deletedAt)` | users_select(`id=ctx AND deleted_at IS NULL`) | withTenantTx |
| users | resolve(id 射影) | `app_bootstrap_user_from_clerk` / `app_resolve_user_for_stripe` | 関数内 `clerk_id`/`stripe_customer_id`/… | (bypass) | **definer**(context 不要・scrub 済/退会済も引ける) |
| users | write(created) | `handleEvent(user.created)` | INSERT `id=newUuid` | users_insert(`id=ctx`) | withTenantTx(事前採番 uuid) |
| users | write(scrub) | `app_scrub_deleted_user` | 関数内 `id=p_user_id` | (bypass・context 自衛検査 `app.user_id=arg`) | **definer** ∈ 内部 setTenantContext tx |
| users | write(stripe 射影) | `projectStripeSubscription` / `applyDeletedReset` | `eq(clerkId)`/`eq(stripeCustomerId)` | users_update(`id=ctx AND deleted_at IS NULL`) | withTenantTx(resolved.id) |
| users | delete | — | — | **policy 無 = deny** | (app-role 不可) |
| **exams** | read | `getActiveExamsForUser`/`getExamByIdForUser` | `eq(userId)` | exams_tenant | withTenantTx |
| exams | write | `createExam`/`deleteExam` | `eq(userId)` | exams_tenant | withTenantTx(user.id) |
| exams | delete(退会) | `handleUserDeleted` tx | `eq(userId)` | exams_tenant | 内部 setTenantContext(internalUserId) |
| **cards** | read | `getCardsForExam`/`getCardsDelta` | `eq(userId)[+gte(cursor)]` | cards_tenant | withTenantTx / asTenant |
| cards | write | `applyCard*`/`updateCardField` | `eq(userId)`(一部 `eq(id)`+field) | cards_tenant | withTenantTx |
| cards | OCR/session write | `session applyCardFinalStates`(cards UPDATE) | **`and(eq(userId), cards.id=v.id)`**(Iso-0 で user_id 述語追加済) | cards_tenant | withTenantTx / 内部 setTenantContext(dual-enforced) |
| **tombstones** | read | pull delta | `eq(userId)[+gte(cursor)]` | tombstones_tenant | withTenantTx |
| tombstones | write | `apply-*-mutation`(insert)/`deleteExam` tx | `userId` 値 / `eq(userId)` | tombstones_tenant | withTenantTx |
| tombstones | delete(退会) | `handleUserDeleted` tx | `eq(userId)` | tombstones_tenant | 内部 setTenantContext |
| **study_days** | read | dashboard stats(raw SQL)/ study-days pull | `user_id = ${userId}::uuid` / `eq(userId)` | study_days_tenant | withTenantTx |
| study_days | write(UPSERT) | review ingest tx | `userId` PK + `eq(userId)` guard | study_days_tenant | withTenantTx |
| study_days | delete(退会) | `handleUserDeleted` tx | `eq(userId)` | study_days_tenant | 内部 setTenantContext |

- **監査上の含意**: FF §5o が「OCR write は user_id 述語なし」と記した経路は Iso-0 で owner 述語追加済で**現在は dual-enforced**(`completeUploadTx`/`markFailed` = source_documents を `and(eq(id), eq(userId))` / `applyCardFinalStates` = cards を `and(eq(userId), id=v.id)`)。よって RLS-on 後は app-WHERE(user_id)と cards_tenant policy の**二重防御**(`rls-partial-chain.test.ts` / `ocr-owner-scope.test.ts` が behavioral pin)。users の hard delete は policy 不在で構造 deny、退会は definer scrub(soft delete)経由。RLS が「app 層 WHERE を信頼しない最終境界」であることは `rls-single-defense.test.ts`(eq(userId) を意図的に外して RLS 単独で隔離)が最も強く示す。

---

# RLS-P3 Wave 1 追記: 配線ゼロ 8 表 RLS matrix + test 配線

起点: `docs/audit/2026-07-21-rls-phase3-step0-tx-boundary-factfinding.md` §5.3 Wave 1(全 write/read path が既に setTenantContext 済の 7 表)+ 追補(ai_usage_users を Wave 1 相当へ格上げ)。P2 と同一形の共通 policy(`*_tenant`・FOR ALL・USING=WITH CHECK=`user_id=(SELECT app_current_user_id())`)を `db/policies/rls-p3-wave1-enable.sql` で追加。test:iso は global-setup が p2-enable の直後に適用(毎 run Wave 1 も RLS on)。rollback は `rls-p3-wave1-disable.sql`(P2 と対称・re-enable 冪等)。

## 表 3: Wave 1 8 表 × 主経路 × context 供給元 × RLS 単独防御 test(IN)

8 表すべて **IN**(tenant RLS 対象・owner-scoped)。RLS 単独防御(app 層 eq を外して policy 単独で隔離)+ context 未設定 P0RLS(loud)は `rls-wave1.test.ts` が read/write per 表で pin。

| 表 | 主 write 経路(closure) | 主 read 経路 | app WHERE | context 供給元 | behavioral test |
|---|---|---|---|---|---|
| **reviews** | review ingest tx(C10・insertReviews) | upsertStudyDays distinct SELECT / streak | `userId` 値 / `eq(userId)` | withTenantTx(内部 setTenantContext) | rls-wave1(read/write/loud) |
| **answer_events** | review ingest tx(C10・ON CONFLICT DO NOTHING) | — | `userId` 値 | 内部 setTenantContext | rls-wave1 + event_id ON CONFLICT 不変 pin |
| **tag_categories** | upload persist(C4)/ entity-mut(C9)/ 退会(C12) | pull delta(getCategoriesDelta) | `eq(userId)` | withTenantTx / per-mutation | rls-wave1 + rls-partial-chain(pull) |
| **tag_options** | C4 / C9 / 退会 | pull delta / applyTagOptionUpdate | `eq(userId)` | withTenantTx / per-mutation | rls-wave1 + write-isolation(applyTagOptionUpdate)+ rls-partial-chain |
| **card_tags** | C4 / C9(whole-set replace)/ 退会 | pull delta(getCardTagsDelta) | `eq(userId)` / `userId` 値 | withTenantTx / per-mutation | rls-wave1 + rls-partial-chain |
| **entity_mutations** | entity-mut per-mutation tx(C9・log INSERT + dedupe SELECT) | C9 dedupe pre-check | `eq(mutationId) AND eq(userId)` / `userId` 値 | per-mutation setTenantContext | rls-wave1 + dual-table pin |
| **card_asset_refs** | entity-mut images field(C9・DELETE+INSERT) | handleImages 内 | `userId` 値 | per-mutation setTenantContext | rls-wave1 + dual-table pin |
| **ai_usage_users** | incrementAiUsage(C8・UPSERT)/ 退会(C12) | **無**(上限判定は global `ai_usage`) | `userId` PK 値 | withTenantTx(内部 setTenantContext) | rls-wave1(read/write/loud) |

## review-ingest 特有 + 既存 test adaptation(§3.3 / §4.3)

- **answer_events.event_id global UNIQUE**: RLS 越しでも ON CONFLICT を従来どおり判定(同 tenant dup → 0 / cross-tenant dup → 0 + B 不変)。`rls-wave1.test.ts`「event_id ON CONFLICT is unchanged by RLS」2 ケースで pin(idempotency は RLS 導入で不変の回帰ガード)。
- **card_asset_refs + entity_mutations 同 tx write**: entity-mutations/bulk 経路が 1 tx で両表を RLS 下でも書ける + cross-tenant user_id は WITH CHECK 42501。`rls-wave1.test.ts` dual-table 2 ケースで pin。
- **既存 test adaptation**(Wave 1 で tag 3 表 RLS 化に伴う必須変更・assertion 不変):
  - `write-isolation.test.ts`(applyTagOptionUpdate block): raw getDb → **asTenant + owner 検証**(tag_options RLS on で context 無し raw は P0RLS)。隔離 assertion('failed' + B 不変)保存 = RLS(USING)+ app 層 eq(userId)の二重防御。
  - `rls-partial-chain.test.ts`: 2 block(pull 6-stream / tag mutation)が全表 RLS 化 → **改称 + comment 更新**(mixed → full-RLS)。assertion 不変。partial-RLS 安全性の intentional 証明は本 file から外れ、**Wave 2 で新設**(follow-up・factfinding 追補2)。

## OUT(Wave 1 対象外・factfinding §2.3 / §5.3)

- **RLS 非対象 5 表**: `ai_usage`/`stripe_events`/`clerk_events`(global・user_id 無)+ `contact_messages`(匿名 user_id null・app read 無)+ `integration_failures`(audit・nullable・FK 無・app read 無)。tenant RLS を張らず role grant で処理(最終 hardening wave)。
- **Wave 2(5 表)**: `study_sessions`/`user_settings`/`assets`/`source_documents`/`upload_records`。各々 standalone raw write/read の context 配線後に RLS 化。本 Wave では touch しない。

---

# RLS-P3 Wave 2 追記: 軽配線 5 表 RLS matrix + partial-RLS 証明 + 保証層

起点: `docs/audit/2026-07-21-rls-phase3-step0-tx-boundary-factfinding.md` §5.3 Wave 2(主要 path は context 済だが素の getDb 直呼びが数点残る 5 表)。各表の残存 raw getDb を `withTenantTx` で context 下に入れた後、P2/Wave 1 同型 policy(`*_tenant`・FOR ALL・USING=WITH CHECK=`user_id=(SELECT app_current_user_id())`)を `db/policies/rls-p3-wave2-enable.sql` で追加。test:iso は global-setup が p2/wave1-enable の直後に適用(毎 run Wave 2 も RLS on)。rollback は `rls-p3-wave2-disable.sql`(P2/Wave 1 と対称・re-enable 冪等)。

## 表 4: Wave 2 5 表 × 配線した raw site × context 供給元 × behavioral test(IN)

5 表すべて **IN**(tenant RLS 対象・owner-scoped)。単独防御(app 層 eq を外し policy 単独で隔離)+ WITH CHECK(42501)+ context 未設定 P0RLS(loud)+ 配線経路(DB 層)は `rls-wave2.test.ts` が pin。

| 表 | 配線した raw site(withTenantTx 化) | context 供給元 | behavioral test |
|---|---|---|---|
| **study_sessions** | review-events/bulk Phase 0 `upsertSessionGuarded`(route:91) | withTenantTx(Phase 0 単純 wrap・processSession 合流せず) | rls-wave2(read/write/WITH CHECK/loud + upsertSessionGuarded 配線) |
| **user_settings** | save-session-limit/custom/fsrs(write 3)+ settings/page・study/custom・study/smart(read 3) | withTenantTx(PK=user_id・述語 user_id のみ) | rls-wave2(read/write[whole-table→A のみ]/WITH CHECK/loud) |
| **assets** | asset-actions: reserve insert / finalize(read tx→headObject→write tx の 2 分割)/ resolve select | withTenantTx(finalize は R2 I/O を tx 外に出す 2 tx。TOCTOU 防御=`status='reserved'` WHERE) | rls-wave2(read/write/WITH CHECK[A→B move 含む]/loud)+ `asset-actions.test.ts`(TOCTOU guard :503/:515/:542) |
| **source_documents** | getExamStatusMap:150 / exams/status route:80,133(read 2。reconcileStale:236 は既 context 済) | withTenantTx | rls-wave2(read/write/WITH CHECK/loud)+ `ocr-owner-scope.test.ts`(O1・completeUploadTx/markFailed) |
| **upload_records** | upload/page:110 `getCurrentMonthOcrPages` caller 差替(canRunOcr は既 guard tx) | withTenantTx(getCurrentMonthOcrPages は dbc: TenantDb 引数化済) | rls-wave2(read/write/WITH CHECK/loud + getCurrentMonthOcrPages 配線) |

### 追随記録: ②-4a S-5(2026-08-05)で source_documents の read 経路が 1 本減った

`hasActiveProcessingUpload`(`/app/upload` の form 表示 gate・`source_documents` を
`status='processing' AND created_at >= now - 15min` で読んでいた)は **`hasLiveUploadOperation` へ
置換**され、読む表が `source_documents` → **`upload_operations`** に変わった(S-5b 追加項目 A:
submit を弾く live-op gate と同じ述語 `isLiveUploadOperationCondition()` を共有するため)。

- 上表の `source_documents` 行は **read 3 → read 2**(getExamStatusMap / exams/status route)。
- 後継の `hasLiveUploadOperation`(`lib/exams/source-doc-status.ts:403-427`)は
  `withTenantTx(userId, …)` + `eq(uploadOperations.userId, userId)` の owner-scoped read。
  `upload_operations` は **Wave 2 の 5 表ではなく ②-4a Phase A の RLS 対象表**
  (`db/policies/ocr-2-4a-enable.sql`)なので上表には足さない。behavioral な隔離検証は
  `rls-drift.test.ts`(policy/RLS 有効性)+ `tests/integration/pg/submit-upload.test.ts` の
  「form 表示 gate と live-op gate の一致」describe(別テナントの live op が
  `hasLiveUploadOperation` に漏れないことを実 PG で pin)が担う。

## 既 context 済サイト(Task 6 flip 前 re-grep で検証・本 Wave で変更なし)

5 表を触る production 経路のうち、P2/Wave 1 の共有 tx で既に context 済のため配線不要と確認したサイト(RLS-on 化で P0RLS しないことの完全性証跡):
- `lib/cards/card-field-handlers.ts:181`(assets read)= `handleImages(tx,…)` が processMutation の per-mutation tx(setTenantContext 済)で受ける tx。
- `lib/exams/list.ts:154`(source_documents read)= `getActiveExamsForUser(dbc: TenantDb)` 引数化・呼び元が withTenantTx で wrap。
- `lib/clerk/handle-clerk-event.ts:219-233`(study_sessions/user_settings/upload_records/assets の lifecycle DELETE/UPDATE)= tx 冒頭 setTenantContext(:211・C12)。
- `app/(app)/app/upload/_actions/upload-persistence.ts`(source_documents/upload_records write・completeUploadTx/markFailed/saveExtractedCards)= 各 tx 冒頭 setTenantContext。
- `app/(app)/app/upload/_actions/upload-guard.ts:57`(source_documents read/insert・runUploadGuardTx)= tx 冒頭 setTenantContext。
- `lib/exams/source-doc-status.ts:236`(source_documents UPDATE + upload_operations UPDATE + upload_records insert・reconcileStaleProcessing)= `withTenantTx`(RLS-P2。②-4a S-4 で op の terminal 化を同一 tx に追加)。

## partial-RLS(混在 tx)の intentional 証明

`rls-partial-mixed.test.ts` が「**global-off 表 × tenant-on 表** が 1 tx に同居しても on 隔離・off 非スコープ・on 違反時 tx 原子的 rollback」を pin。実経路 = `incrementAiUsage`(`ai_usage`[off・global] + `ai_usage_users`[on] を 1 tenant tx で UPSERT)。

- **主張範囲(限定)**: 「global-off × tenant-on の transaction 互換性」に限る。移行期に tenant 表が一時的に off である安全性、および off 側の tenant 隔離は**証明しない**(off=global ゆえ隔離対象外)。
- **実経路置換の理由**: Step 0 追補2 の想定「study_sessions off × on」は Wave 2 が study_sessions を on 化するため無効化。Wave 2 後も残る stable な mixed tx は恒久 off の global 表 × on 表ゆえ `incrementAiUsage` に置換(clean な実在経路・人工 fixture 不要)。

## 保証層の分離(Codex cross-check 指摘)

配線の保証は層で担う(同一 test を複数層の証明とみなさない):
- **① caller 配線**(route/action/page が実際に withTenantTx で包む)= canonical review + Task 6 の機械 re-grep + `pnpm build`/`typecheck`。iso は Next auth/cache/R2 境界を叩かないため caller 配線自体は pin しない。全 site の context userId が auth 由来(`user.id`/`userId`)である点も review 観点。
- **② policy 単独防御**(app 層 eq を外して policy 単独で隔離)= `rls-wave2.test.ts`。
- **③ DB 層実経路**(wire 済関数/query が context 下で動く)= `rls-wave2.test.ts`(upsertSessionGuarded/getCurrentMonthOcrPages)+ `ocr-owner-scope.test.ts`。
- **④ stg smoke** = RLS-on 下の operational(隔離証明でなく「配線経路が RLS-on で従来どおり動く」)。

## 既存 test adaptation(Wave 2 で必須・assertion 不変)

- `ocr-owner-scope.test.ts`: ground-truth 観測 helper(`statusOf`/`uploadRecordsWithFilename` + inline read 3)が source_documents/upload_records を raw getDb で読む → RLS-on 化で P0RLS。**owner 接続(getFixtureOwnerDb・RLS bypass)へ切替**(as-tenant.ts 規約: 観測/seed は owner)。刺激(completeUploadTx/markFailed)は自前 setTenantContext ゆえ getDb() のまま。
- unit(save-*/settings・study page/exams-status route/review-events bulk route+contract/asset-actions): withTenantTx 化に伴い **pass-through stub**(`(db,_u,fn)=>fn(db)`)を追加(GUC 挙動は iso で担保)。

---

# RLS-P3 hardening 追記: 非 RLS 5 表の grant 縮小 pin(`grant-narrowing.test.ts`)

起点: `docs/superpowers/plans/2026-07-21-rls-phase3-hardening.md` Task 5。RLS **非対象** 5 表(`ai_usage`/`stripe_events`/`clerk_events`/`contact_messages`/`integration_failures`)は tenant RLS を張らないため **command-level GRANT が唯一の防壁**。base blanket grant(`ON ALL TABLES`)の後段で `db/roles/recallmint_app-grants-phase3.sql` を REVOKE 適用し、app-role の権限を「実コードが使うコマンドだけ」へ縮小する。global-setup は base grants の直後に phase3 REVOKE を適用するため test:iso は毎 run 縮小後の grant で走る。

## 表 5: 5 表 × コマンド × 縮小後 grant(KEEP/REVOKE)+ pin

app-role(`getDb()`)は非 RLS 表ゆえ setTenantContext 不要。seed/観測/truncate は owner(`getFixtureOwnerDb`・grant bypass)。

| 表 | SELECT | INSERT | UPDATE | DELETE | 縮小根拠(実経路) |
|---|---|---|---|---|---|
| **ai_usage** | KEEP | KEEP | KEEP | ~~REVOKE~~ | 日次 UPSERT(`ON CONFLICT DO UPDATE SET count=count+N`)+ 上限判定 `select(count)`。DELETE は無 |
| **stripe_events** | KEEP | KEEP | ~~REVOKE~~ | ~~REVOKE~~ | webhook idempotency `INSERT ON CONFLICT DO NOTHING RETURNING event_id`(RETURNING→SELECT 要)。追記のみ |
| **clerk_events** | KEEP | KEEP | ~~REVOKE~~ | ~~REVOKE~~ | stripe_events と同型(INSERT+RETURNING event_id) |
| **contact_messages** | **KEEP** | KEEP | ~~REVOKE~~ | KEEP | INSERT(contact form)+ 退会 DELETE `WHERE user_id=`。**SELECT は DELETE の WHERE が user_id を読むため保持必須**(下記 ⚠️) |
| **integration_failures** | ~~REVOKE~~ | KEEP | ~~REVOKE~~ | ~~REVOKE~~ | audit 追記 INSERT のみ(RETURNING 無・回収列は dormant) |

## pin 内訳(`grant-narrowing.test.ts`・14 test)

- **42501 完全 matrix(9 test)**: 縮小で失った全コマンドが app-role で permission-denied(SQLSTATE 42501・`.cause` walk)になることを表 5 の REVOKE セル全数で pin — contact_messages:UPDATE / integration_failures:SELECT+UPDATE+DELETE / stripe_events:UPDATE+DELETE / clerk_events:UPDATE+DELETE / ai_usage:DELETE。
- **positive control(5 test・実 query 形)**: 残したコマンドが実コードと同じ形で動く — stripe/clerk `INSERT ON CONFLICT DO NOTHING RETURNING`(RETURNING が SELECT grant で通る = SELECT 十分の実証)/ ai_usage `INSERT ON CONFLICT DO UPDATE`(count 読取+書込 = SELECT+UPDATE)/ contact_messages `INSERT` + `DELETE WHERE user_id=` / integration_failures audit `INSERT`。**sequence 権限所見**: 5 表とも PK は uuid `defaultRandom()`(gen_random_uuid)or 自然キー(event_id/date)で **SERIAL/sequence を使わない** → sequence USAGE 権限依存は無い。positive control は INSERT が default(gen_random_uuid/defaultNow)込みで通ることを併せて確認。
- **RED 検証**: global-setup の phase3 REVOKE 適用を無効化(blanket grant のまま)すると 42501 matrix 9 test が全 fail(blanket = 全コマンド成功で `expected the operation to reject` に落ちる)、positive control 5 は pass のまま。= matrix が grant 縮小に実際に gated されている実証。

## ⚠️ contact_messages:SELECT を残す理由(brief からの逸脱・要 OT 批准)

brief 当初は contact_messages を「REVOKE SELECT+UPDATE」と指定していたが、**PostgreSQL は DELETE/UPDATE が WHERE 句で列値を読む場合その列への SELECT 権限も要求する**(PG17 で実測: `DELETE FROM t WHERE user_id=$1` は SELECT 剥奪下で 42501、SELECT 付与で成功)。退会 lifecycle の `DELETE FROM contact_messages WHERE user_id=…`(`handle-clerk-event.ts:219`)は user_id を読むため、SELECT を剥奪すると **GDPR 削除経路が 42501 で壊れる**。列単位 GRANT(`SELECT(user_id)` のみ)は本 wave 対象外ゆえ table-level SELECT を残す。positive control「contact_messages: INSERT + DELETE WHERE user_id=」が pin するのは **SELECT 保持下で DELETE が成功する = 十分性**であり、SELECT を残す必然性(剥奪すると 42501)は上記 PG 規則 + 手動 PG17 実験由来(test:iso は単一 grant 状態ゆえ counterfactual は pin しない)。他 4 表の REVOKE 対象コマンドは列を読まない(bare DELETE / INSERT-only 等)ため影響なし。

## 残余リスク(本 wave では受容・記録のみ・plan 準拠)

- **command GRANT は行隔離を与えない**: DELETE を残す contact_messages は app-role が全 tenant の contact 行を削除でき、UPDATE を残す ai_usage は全 date 行を更新できる(blast radius 残存)。行スコープが要るなら RLS 化が必要だが本 5 表は非対象と確定。
- **ALTER DEFAULT PRIVILEGES を維持**: base grants の default privileges はそのままゆえ、将来 owner が新規の非 RLS 表を作ると再び blanket CRUD が付与される(新表ごとに grants-phase3.sql へ REVOKE を追記する運用が必要)。

---

# RLS-P3 hardening 追記: policy drift-detection(`rls-drift.test.ts`)

起点: `docs/superpowers/plans/2026-07-21-rls-phase3-hardening.md` Task 6(選択肢 B)。policy は drizzle migration に昇格せず versioned SQL(`db/policies/{rls-p2,rls-p3-wave1,rls-p3-wave2}-enable.sql`)のまま置く(spec §2.9 = enablement を deploy から分離・operator 手動適用)。その代償の「SQL と実 DB がズレていないか」を実 PG catalog で検出するのが drift test。global-setup が migrate + grants + 3 enable SQL を適用した結果を、hardcoded な期待カタログ(独立 oracle)と突き合わせる。

## 何を pin するか(policy **全定義**・name+cmd では不十分)

`pg_policies` の (roles, cmd, permissive, qual, with_check) 全 tuple + `pg_class` の relrowsecurity / relforcerowsecurity を期待カタログと完全一致で照合する(6 test):

| # | test | pin する不変条件 |
|---|---|---|
| 1 | expected catalog is internally consistent | oracle 自体の内部整合(RLS 18 表 / 非 RLS 5 表 / policy 20 件)= file 編集ミスで oracle が壊れるのを防ぐ |
| 2 | relrowsecurity split; forcerowsecurity off | 18 対象 true / 5 非対象 false / **意図しない表が true でない**(全 public 表 diff)/ FORCE は全 public 表 false(owner bypass 不変条件) |
| 3 | every policy tuple matches exactly | 各 policy の (roles, cmd, permissive, **qual, with_check**) が期待正規化テキストと完全一致。**誤 predicate(USING (true) 等)を green にしない中核** |
| 4 | full set of (table, policy) equals catalog | (tablename, policyname) の全集合が期待 20 件と一致 = 余計/不正 policy がどこにも無い(非対象 5 表に policy ゼロも同時保証) |
| 5 | recallmint_app is the only role | 全 policy の roles が `{recallmint_app}` のみ(別 role・PUBLIC 混入検出) |
| 6 | users has no DELETE policy | users は FOR ALL も FOR DELETE も不在(hard delete 構造的 deny)+ 3 per-command(select/insert/update)ちょうど |

**qual/with_check の正規化テキスト扱い**: PostgreSQL は policy 式を正規化して pg_policies に格納する(`user_id = (SELECT public.app_current_user_id())` → `(user_id = ( SELECT app_current_user_id() AS app_current_user_id))`)。期待値は DB が返す正規化形をそのまま定数(`TENANT_PRED` / `USERS_ID_PRED` / `USERS_LIVE_PRED`)に pin する(PG17 実測)。共通形 17 表は同一 `TENANT_PRED` を共有、users 3 policy は `deleted_at IS NULL` 連言込みで個別 pin。

**期待カタログを db/policies から生成せず hardcode する意図**(Codex#4.3): SQL と test が同一 SSoT を読むと「両方同時にズレる」盲点が生じる。fixture-completeness の三者一致と同思想で、独立した第二の記述(test file の期待カタログ)を照合軸にする。二重管理の drift は review 規約で守る。

## RED 検証(保証増・代表 mutation 3 種)

owner(`getFixtureOwnerDb`)で policy を改変 → drift test が fail することを実証 → enable SQL 再適用で復元。

| mutation | 改変 | 落ちる test | 検出内容(quote) |
|---|---|---|---|
| ① policy drop | `DROP POLICY cards_tenant ON cards` | #3, #4 | `expected policy cards\|cards_tenant to exist: expected undefined to be defined` + set `[…(19)]` vs `[…(20)]` |
| ② qual 改変(**load-bearing**) | `cards_tenant` を `USING (true) WITH CHECK (true)` で再作成 | #3 | `cards\|cards_tenant qual: expected 'true' to be '(user_id = ( SELECT app_current_user_…'` — name/cmd 不変で qual だけ変えても検出 = name+cmd 突合では素通りする誤 predicate を捕まえる実証 |
| ③ role 変更 | `cards_tenant` を `TO PUBLIC` で再作成 | #3, #5 | `cards\|cards_tenant roles: expected [ 'public' ] to deeply equal [ 'recallmint_app' ]` |

## 範囲の限界(runbook §12 が補完)

**test:iso は「repo の enable SQL ↔ test DB」の整合のみ検出**。global-setup が毎 run enable SQL を適用した結果を照合するため、SQL 自体の変更ミス・適用漏れは捕まえるが、**stg/prod で operator 手動適用後に誰かが直接 policy をいじる「手動適用 drift」は検出できない**。それは `docs/ops/rls-p2-stg-runbook.md` §12 の operator 用 read-only 監査 SQL(同じ pg_policies / relrowsecurity 照合を実 DB へ)が担う。`app_current_user_id()` 関数本体の drift は `rls-functions.test.ts` が behavioral に担保(Codex#4.5)。
