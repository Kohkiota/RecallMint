# DDD 準拠大リファクタリング 事前調査(repo 全体 fact-finding)

日付: 2026-07-05 / 調査: CC(read-only Explore agent 6 体並列 + 統合)/ 対象 commit: develop 6592323 時点(未 commit の S5 作業ファイルは記録のみ)

規模実測: TS/TSX 427 files / 約 90,000 行(app 61,692 / lib 26,081 / components 1,466)。最大サブシステムは `app/(app)/app/exams/`(84 files / 31,602 行)。

本書は**調査結果の記録のみ**。spec / plan は未着手(brainstorming → spec → plan の通常フローで別途)。

---

## 1. 結論サマリ

1. **「スパゲッティ」ではなく「層が半分だけ敷かれた状態」**。lib/ には純粋ドメイン資産(replay-card、buildNextTagSet、採番群、plan-catalog、seed-from-criteria 等)と良い seam(entity-mutation-registry、DbExecutor 抽象、runOptimistic* helper)が既に存在する。負債の主因は (a) ドメインロジックの UI/route への残留、(b) client/server の同一ルール二重実装、(c) 同型コードの機械的コピペ、の 3 系統。
2. **最大のレイヤ違反は 3 箇所**: `card-tags-section.tsx`(タグ集約の client CRUD 約 430 行が presentation に常駐し他 component から import される)、`upload/_actions/process.ts`(761 行に課金ガード+AI+DB+文言が融合)、webhooks 2 本(課金状態遷移・削除カスケードが route 直書き)+ `review-events/bulk/route.ts`(FSRS ドメイン約 330 行が route 内)。
3. **二重実装が構造化している**: computeStreak(server/client 完全コピー)、due card 選定(SQL 版 / Dexie 版 + dashboard 第 3 経路)、cascade 削除・UNIQUE pre-check(UI 版 / server apply 版)、card 検証 schema(3 箇所)、option schema(3 表現)、flush orchestrator(entity-mutation 系 / review 系がほぼ全複製)。casing(camel/snake)の 2 表現も横断。
4. **wire format(API payload / Dexie schema / entity_mutations 形式)を凍結したまま再編できる境界が大半**。例外は pull の per-entity 手配線(generic 化には wire 変更が必要)と 2 系統 outbox の統合(大改修)— どちらも後回しが安全。
5. **安全網は lib と API route では厚い(co-located test 78〜88%)が、UI component test はほぼ無く、E2E(Playwright 設定)は存在しない**。UI 再編を含む大リファクタは現状 typecheck + 手動 smoke 頼み。ここが最大の実行リスク。

---

## 2. 現状アーキテクチャ実態

### 2.1 書込 2 系統 + pull

- **系統 A(entity 編集 = mutation outbox)**: UI → `runOptimistic*`(Dexie mirror 書込 + `entity_mutations` enqueue、coalesce)→ webLock flush → `POST /api/entity-mutations/bulk` → `entity-mutation-registry`((entity_type,op)→apply の dispatch table)→ `lib/cards|tags/apply-*-mutation`。**層分離は比較的良好**(route は dispatch のみ)。
- **系統 B(演習回答 = event sourcing)**: SessionRunner → Dexie `answer_events` 直書き → `review-flush`(backoff timer)→ `POST /api/review-events/bulk` → route 内 6 phase(cards SELECT → answer_events INSERT → **FSRS replay fold** → reviews INSERT → cards UPDATE → study_days JST 集計)。**route.ts:122-455 の約 330 行がドメイン処理で HTTP と未分離**。`deriveRating`(rating 導出ルール)も route 内。
- **pull**: 6 stream(cards/exams/tombstones/tag_categories/tag_options/card_tags)を cursor 付き delta で `/api/pull` から取得し Dexie に LWW upsert。study_days のみ別エンドポイント(cursor なし 90 日 window)。
- **server action 系(非 local-first)**: upload(process.ts)、settings、upgrade(Stripe)、exams 一覧の create/delete。二系統の使い分け自体は一貫している。

### 2.2 shotgun surgery の実測

新 entity を系統 A + pull に追加すると**最低 9 ファイル横断**(mutation-schemas / apply-* 新規 / registry / client-db(Dexie version bump) / *-pull 新規 / api/pull/route / pull.ts 内 6 箇所 / sync-meta / UI handler)。pull 経路の per-entity 手配線が中心。tombstone の entity_type 列挙は 3 箇所(schema.ts:774 / tombstones-pull.ts:15 / pull.ts:46)。

### 2.3 データモデル(server 21 テーブル / Dexie 11 store)

- server: users, reviews, ai_usage, ai_usage_users, stripe_events, clerk_events, deletion_failures, exams, cards, source_documents, upload_records, study_days, user_settings, contact_messages, study_sessions, answer_events, entity_mutations, tag_categories, tag_options, card_tags, tombstones(schema.ts 冒頭コメント「13 tables」は stale)。
- Dexie mirror は 10 テーブル + sync_meta。tombstones は store を持たず purge 駆動にのみ使用。
- 乖離の例: `ClientUserSettings` は pull writer 不在で未使用 + `custom_session_limit` 欠落(client-db.ts:106-107)。`ClientAnswerEvent.rating` は server 列に存在しない(payload 専用)。
- **「card」概念が 11 表現**(Card / ClientCard / CardOption / ClientCardOption / CardImage / ClientCardImage / ExtractedCard / ExamDetailCard / ProcessedCard / EmptyCard / cardCreatePatchSchema)。tombstone は 3 重定義。option は camelCase(zod)と snake_case(型)の 2 casing を registry が手動変換(entity-mutation-registry.ts:157-161)。
- mapper 方針が entity ごとに不統一: cards のみ双方向 pure mapper(cards-mapper.ts)、他は pull ファイルにインライン。

### 2.4 競合解決ポリシーの 3 方式混在

outbox=LWW(coalesce + server 無条件 UPDATE、edited_at は競合判定に不使用)/ mirror=server-wins(pull bulkPut)/ FSRS=event replay。delete op のみ mutation_id 冪等でない(apply の自然冪等頼み)。統一は apply 意味論の変更を伴うため回帰リスク大(§6 参照)。

---

## 3. レイヤ違反(ドメインロジックの所在ズレ)

### 3.1 presentation 内のドメイン(exams UI)

| # | 内容 | 場所 |
|---|---|---|
| V1 | タグ集約の client CRUD ユースケース一式(rename/color/delete/create category・option、impact 集計、create+assign)が component の module スコープに常駐、**他 presentation から import される** | `card-tags-section.tsx:80-508`(importer: exam-card-table.tsx:83-95、exam-card-table-tag-cell.tsx:28-31 他) |
| V2 | UI 直の Dexie アクセス(4-store live query 構築、tx 直張り) | exam-card-table.tsx:271-287 / inline-card-list.tsx:92-118 / inline-text-field.tsx:172 / use-card-tag-toggle.ts:93-125 |
| V3 | mutation patch・「空文字→null」正規化ルールの UI 埋め込み | inline-card-list.tsx:218-236 / inline-text-field.tsx:67-71,199-208 / use-card-options.ts:159-225 |
| V4 | タグ並び comparator(category→option 2 軸)の 3 重コピー | card-tags-section.tsx:558-570 / exam-card-table-tag-cell.tsx:79-87 / _lib/tag-sort-key.ts:20-28 |
| V5 | tag filter 値の集合演算(toggle+prune)の 2 重埋め込み | exam-card-table-filter-editors.tsx:173-182 / exam-card-table-condition-bar.tsx:144-153 |

### 3.2 その他 app 領域

- **upload/_actions/process.ts(761 行)**: 入力 parse / ページ・サイズ上限 / advisory lock + in-flight / 月次 OCR quota + Gemini 日次上限 / exam・sourceDoc INSERT / AI 呼出 / cards bulk INSERT + applyOcrTags + cardCount / 台帳 / 失敗補償 / env ポリシー / 日本語文言、が単一関数に直列(process.ts:135-686)。
- **session-runner.tsx(627 行)**: 正誤判定(集合一致 :203-211)、rating 自動決定(correct→3/incorrect→1 :334)、tally 重複防止、flush 閾値(=5)、rate-then-confirm 制御が UI 内。
- **study-session-host.tsx:59-64**: 「Dexie≥1 件なら mirror、0/throw なら server props」の card 選定ポリシーが useEffect 内。
- **upload-form.tsx:225-241**: quota/上限判定が client にも実装(server と同一ポリシーの二重実装)。
- **upgrade-plans.tsx:375-380**: `rankPlan` の inline copy(コメントで自認)。
- **tags/category-list.tsx:134-198**: cascade 削除 + 影響集計が UI ハンドラ内(server apply-tag-mutation と等価処理の二重持ち)。option-row.tsx:61-222 の UNIQUE 事前判定も同様。

### 3.3 route 内のドメイン(API 層)

- **webhooks/stripe/route.ts(441 行)**: normalizeSubStatus(:86-104)、resolvePlanFromSub(:117-156)、6 event switch + DB update 直書き(:176-365)、release gate(:372-441)。lib 委譲は 2 関数のみ。**課金ドメインの core が route に存在**。
- **webhooks/clerk/route.ts(416 行)**: 削除カスケード(10 テーブルの明示 DELETE :280-289)、Stripe cancel ループ、DB retry・transient 判定(インフラ)まで route 同居。
- **review-events/bulk/route.ts(593 行)**: §2.1 のとおり。
- 対照的に polling/pull 4 route(dashboard/stats, exams/status, pull, study-days/pull)は薄く lib 委譲済みで健全。

### 3.4 依存方向違反

- **lib → app**: `lib/cards/get-custom-session-cards.ts:23` → `app/.../exams/[id]/_lib/card-filter-predicates`(唯一の逆依存。study/custom UI も同 predicates に依存)。
- **components → app**: `components/marketing/contact-form.tsx:4` → contact route の server action。
- import 境界を守らせる lint(no-restricted-imports 等)は**未設定**。

---

## 4. 重複・冗長・dead code

### 4.1 client/server 二重実装(drift すると即バグ、コメントで手動同期義務を明記している群)

| 対象 | 場所 |
|---|---|
| computeStreak(完全 1:1 コピー) | lib/db/streak.ts:13-46 / lib/client/streak.ts:21-49 |
| due card 選定(SQL / Dexie + dashboard 第 3 経路) | lib/cards/get-session-cards.ts / get-dexie-session-cards.ts / dashboard-actions.tsx:45-58 |
| FSRS row↔ts-fsrs 変換(「完全一致」要求コメント) | replay-card.ts:69,92 ⇄ review-events/bulk route 内変換 |
| cascade 削除・UNIQUE pre-check | tags UI(category-list/option-row) ⇄ apply-tag-mutation.ts |
| upload quota/上限しきい値 | upload-form.tsx:225-241 ⇄ process.ts:198,218,291 |
| card 値制約 schema(エラー文言まで一致要求) | mutation-schemas.ts:49-73 / card-field-handlers.ts:54-91(+validation/card.ts) |
| correct_answer_ids 再生成 | apply-card-mutation.ts:83 / card-field-handlers.ts:169-174 |
| sort 順(SQL ORDER BY ⇄ sortLikeServer) | exams/list.ts:110,181 ⇄ lib/cards/sort-like-server.ts |
| plan rank | plan-catalog.ts ⇄ upgrade-plans.tsx:375(inline copy) |

### 4.2 インフラ同型コピペ

- **flush orchestrator 2 系統ほぼ全複製**: entity-mutation-flush ⇄ review-flush(guard/lock)、flushAllPendingEntityMutations ⇄ flushPendingEvents、in-flight set・markAttempted・dropStale・defaultClient が全て同型。FlushResult 型の流用負債(sessionSynced 常時 false)もコメントで自認。
- **pull 6 本の同型 module**(cards/exams/tag-categories/tag-options/card-tags/tombstones-pull): table + cursor 列 + mapper だけ違う generic factory 候補。pull.ts 内も cursor 6 連・params 6 連・tombstone filter 4 連・cursor write 6 連の手展開。
- **retry/backoff 3+ 実装**(ai/ocr.ts:117、clerk route:385、review-flush:137 — lib/retry に共通関数があるのに各自再実装)。transient error 分類も 3 実装 + `lib/retry/` と `lib/transient/` の並列ディレクトリ。
- **route 認証 boilerplate 6 route 重複**(getCurrentUser → 401/空/500 + no-store)。
- **env/timestamp インライン 8 ファイル**(VERCEL_ENV ?? NODE_ENV + toISOString)。
- **inline 編集 primitive 二重実装**: InlineTextField ⇄ InlineOptionCell(sharedBoxChrome 文字列・dirty-guard・auto-resize・keydown が verbatim 重複)。tags 側 option-row も「inline-text-field の UX をコピー」と自認。
- **Error 展開 replacer**: logger.ts:46 ⇄ ops.ts:121。

### 4.3 dead code / stale(確度付き)

- 確度高: `plan-catalog.ts isUpgrade`、`fsrs.ts newCard`(参照は自 test のみ)。`buildNewOption` export(card-tags-section.tsx:360、外部 consumer なし)。`CardTagBadge.onOpenEdit`(全呼出 no-op)。`createOptionAndAssignPlaceholder`(常に override される dead path)。
- 確度中: `jstMonthBoundsUtc` の export(内部利用のみ)。`components/ui/dropdown-menu.tsx`(「将来再利用のため残す」と自認、実 UI は自前 menu)。upload-form の payload-too-large 分岐(自認 dead branch 寄り)。
- stale: schema.ts:1「13 tables」(実 21)。`ClientUserSettings`(pull writer 不在)。
- ファイル単位の dead file は検出なし。

---

## 5. bounded context 候補と目標像(調査時点の素案 — spec で確定させる)

### 5.1 context 分割案

1. **Content(コンテンツ管理)**: Exam(root, card_count 非正規化)/ Card(options を VO 集合として不変条件内包)/ TagCategory(root)+ TagOption + CardTag。
2. **Learning(学習・復習 = FSRS)**: reviews / answer_events / study_sessions / study_days + cards の FSRS 列群。中核ドメインサービス = replayCard + rating 導出 + streak。
3. **Ingestion(取込・OCR)**: source_documents / upload_records / ai_usage(_users)。quota ポリシー + OCR パイプライン。
4. **Identity & Billing**: users / stripe_events / clerk_events / deletion_failures / user_settings。不変条件が schema コメント依存で中央 enforce が薄い。
5. **Sync Infrastructure(支援サブドメイン)**: entity_mutations / tombstones / sync_meta / content_version。generic 部分と entity 適用ルール(registry+apply)を分界。
6. Support: contact_messages(stub)。

### 5.2 既にドメイン層へ昇格可能な純粋資産(移設のみで済む群)

replay-card / fsrs(RatingInt) / next-card-sort-key / next-card-title / next-option-id / empty-card / build-next-tag-set / reindex-sort-keys / next-sort-key / sort-comparator / sort-like-server / join-card-tags / seed-from-criteria / plan-catalog(rankPlan, classifyChange) / computeStreak(統合後) / deriveExamStatuses / jst 等。

### 5.3 目標依存方向(素案)

page/_components(presentation)→ hooks(orchestration)→ use-case(application)→ domain(純粋)→ repository/port(CardRepository・TagRepository = Dexie mirror + outbox を隠蔽 / server は DbExecutor 系)。use-case 候補: ProcessUploadedDocument、StartSmartStudySession / StartCustomStudySession、SubmitReview(RatingPolicy)、CreateTagCategory / RenameTagOption / DeleteTagCategory(cascade) / ApplyTagToCard、ChangePlan / ScheduleDowngrade、IngestReviewEvents(server)、HandleStripeEvent / DeleteUserCascade(server)。

注: 簡潔性規律(YAGNI・rule of three)に照らし、**フル DDD(hexagonal + 全 entity repository)ではなく「domain 純粋層 + use-case 関数 + 既存 seam の昇格」の pragmatic DDD** を推奨。既存の registry / DbExecutor / runOptimistic* はそのまま port として機能する。

---

## 6. 再編境界とリスク

### 6.1 wire 凍結のまま再編できる(低〜中リスク・優先)

1. review-events route の domain service 抽出(ReviewIngestionService — payload/response 凍結、単一 tx 境界維持が条件)。
2. webhooks 2 本の lib 抽出(課金状態遷移 / 削除カスケード / DB retry を分離。test が厚く回帰検知が効く)。
3. flush orchestrator の generic 統合(lock 名・endpoint・payload builder 注入)。
4. タグ client CRUD の lib/tags 移設(V1)+ card write use-case 集約(V3)。
5. 純粋資産の domain 層移設(§5.2)+ 二重実装の単一 source 化(computeStreak 等)。
6. card-filter-predicates の lib 昇格(逆依存 2 系統の解消)。
7. pull 6 module の generic factory 化(**server 内部のみ** — wire に出ない範囲)。

### 6.2 wire 変更を伴う(後回し推奨)

- pull の per-entity 手配線の registry-driven 化(PullResponse 型 = wire そのもの。client/server 同時 deploy か versioning 要)。
- 2 系統 outbox(entity_mutations ⇄ answer_events)の統一(大改修。現状分離維持が安全)。
- 競合解決 3 方式の統一(edited_at を server 競合判定に昇格 = apply 意味論変更)。
- Dexie store/index 変更全般(過去の card_mutations→entity_mutations は「stg truncate・active user 0」前提で drop した実績。本番データありでは pending outbox 喪失リスク)。

### 6.3 挙動維持が特に難しい箇所(移動時の地雷リスト)

- exam 詳細の**単一 subscription 不変条件**(spec §9、conditional unmount 構造)/ inline-text-field の commit-on-unmount + dirty-guard / use-card-options の ghost merge / TagCell placeholder override / selection prune(HS-2)/ scroll collapse + virtualizer の memo 凍結条件。
- session-runner の fire-and-forget + tally(二重登録・欠落に直結)/ process.ts の advisory lock 保持前提の tx 境界 / upload-form の React 19 batching 依存(setPhase urgent 発火)/ tags optimistic rollback の Dexie auto-rollback 依存 / applyOcrTags の同一 tx 前提の採番。
- **import 経路が load-bearing**: lib に 'use client' ゼロ、境界は server-only(19 files)+「getClientDb が server で throw」+ コメント慣習のみ。移動で client bundle に server-only が混入し得る。module-load 時 throw(clerk.ts / stripe.ts / price-mapping)の発火位置も import 順依存。

### 6.4 安全網の実態

- lib: co-located test ~88%、app: ~78%(API route 全 8 本 test 付き、webhooks 特に厚い)→ ここは安心して動かせる。
- components: ~13%、**E2E / Playwright 設定は存在しない**。integration は 3 本のみで legal-pages は source-grep smoke(ファイル移動で偽陽性破綻)。
- → **UI 再編フェーズの回帰検知は typecheck + DevTools MCP 手動 smoke 頼み**。リファクタ着手前に (a) 主要フロー(upload→OCR→カード編集→study→sync)の smoke checklist 整備、または (b) Playwright E2E 最小セット導入(新規依存 = OT 事前相談)を検討すべき。
- lint に import 境界ルールがないため、層を定義しても機械的強制がない(eslint no-restricted-imports 追加は再編と同時に導入すべき)。

---

## 7. フェーズ分割の骨子(提案 — plan ではない)

依存関係上の自然な順序。各フェーズが独立に「挙動同一」を検証できる粒度で切る前提。

- **P0 準備**: smoke checklist / (E2E 判断) / eslint import 境界ルール / dead code・stale コメント掃討(低リスク・即効)。
- **P1 domain 抽出(純粋層)**: §5.2 の移設 + 二重実装の単一 source 化(computeStreak、tag comparator 3 コピー、filter 代数、option schema 統一は casing 変換面があるため慎重に)。
- **P2 server 側 use-case 化**: review-events route 抽出 → webhooks 2 本抽出 → process.ts 分解(tx 境界・advisory lock 維持)。route は「受付+委譲」に痩せる。test が厚い領域なので先行。
- **P3 client 側 use-case/repository 化**: タグ CRUD の lib 移設(V1)→ card write 集約(V3)→ Dexie 直アクセスの repository 閉じ込め(V2)→ inline primitive 統合。単一 subscription 等の地雷が多く、最も慎重に。
- **P4 インフラ DRY**: flush orchestrator 統合 / pull server 側 factory 化 / retry・transient 統合 / route 認証 wrapper / lib ディレクトリ再編(fsrs.ts→lib/learning 等の基準統一)。
- **P5(任意・別判断)**: wire 変更系(§6.2)。今回スコープ外推奨。

各フェーズは sprint フロー(brainstorming → spec → plan → subagent-driven 実装 + canonical/Codex review)に載せる。全体を 1 sprint でやる規模ではない(実装は複数 sprint 想定)。

---

## 8. OT への論点(判断が要るもの)

1. **DDD の深さ**: フル DDD(hexagonal、全 aggregate に repository/entity クラス)か、本書推奨の pragmatic DDD(domain 純粋層 + use-case 関数 + 既存 seam 昇格。簡潔性規律と整合)か。
2. **スコープ境界**: wire 変更系(§6.2 pull generic 化・outbox 統一・競合ポリシー統一)を今回に含めるか除外するか(推奨: 除外)。
3. **安全網先行投資**: P0 で Playwright E2E 最小セットを導入するか(新規依存 = 事前相談事項)、smoke checklist + DevTools MCP 手動で進めるか。
4. **フェーズ順**: §7 の P0→P4 骨子で spec/plan 起草に進んでよいか。進める場合、どのフェーズから sprint 化するか。
5. **進行中 S5(列固定)との順序**: S5 完了後に着手が自然(exams UI は S5 の変更対象と重なる)。

---

## 9. 出典

Explore agent 6 体の生レポートは本書に統合済み(exams UI / データ層 / sync 基盤 / その他 app 領域 / lib サービス群 / API・横断)。個別の file:line 証拠は各節に転記済み。転記時に要約した箇所はあるが、file:line は agent 報告の実測値をそのまま採用。
