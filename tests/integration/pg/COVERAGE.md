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
