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
| cards | OCR write | `completeUploadTx`/`session applyCardFinalStates` | **`eq(id)` のみ(user_id 述語なし)** | cards_tenant(tenant scope は RLS 側が担保) | withTenantTx / 内部(provenance 依存・5o) |
| **tombstones** | read | pull delta | `eq(userId)[+gte(cursor)]` | tombstones_tenant | withTenantTx |
| tombstones | write | `apply-*-mutation`(insert)/`deleteExam` tx | `userId` 値 / `eq(userId)` | tombstones_tenant | withTenantTx |
| tombstones | delete(退会) | `handleUserDeleted` tx | `eq(userId)` | tombstones_tenant | 内部 setTenantContext |
| **study_days** | read | dashboard stats(raw SQL)/ study-days pull | `user_id = ${userId}::uuid` / `eq(userId)` | study_days_tenant | withTenantTx |
| study_days | write(UPSERT) | review ingest tx | `userId` PK + `eq(userId)` guard | study_days_tenant | withTenantTx |
| study_days | delete(退会) | `handleUserDeleted` tx | `eq(userId)` | study_days_tenant | 内部 setTenantContext |

- **監査上の含意**: OCR write(cards / source_documents)は app-WHERE に user_id 述語を持たない唯一の逸脱(FF §5o)。RLS-on 後は cards_tenant policy が tenant scope を補完するため id-only でも越境不能(`rls-partial-chain.test.ts` / `ocr-owner-scope.test.ts` が behavioral pin)。users の hard delete は policy 不在で構造 deny、退会は definer scrub(soft delete)経由。この 2 点が「app 層 WHERE を信頼せず RLS が最終境界」を最も強く示す配線。
