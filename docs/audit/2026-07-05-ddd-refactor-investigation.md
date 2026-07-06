# DDD 準拠大リファクタリング 事前調査(統合版・現状検証済)

- 初回調査: 2026-07-05、CC Explore agent 6 体並列(基準 commit `6592323`)
- 独立調査: 2026-07-06、Codex(gpt-5.5)`codex-plan-review.sh`(raw: `docs/codex/2026-07-06-plan-ddd-refactor-investigation.md`、detector PASS)
- **現状検証: 2026-07-06、検証 agent 4 体並列で両調査の全主張を現 HEAD(`5d3baef`)と照合済**。本書は 3 者を統合した単一の確定版。検証で判明した修正・追加は本文に反映済み(§9 に修正一覧)。

規模実測: TS/TSX 427 files / 約 90,000 行(app 61,692 / lib 26,081 / components 1,466)。最大サブシステムは `app/(app)/app/exams/`(基準時 84 files / 31,602 行。以降 S5 列固定 + side peek + B+C fix で +2,365 行)。

本書は**調査結果の記録のみ**。spec / plan は未着手(brainstorming → spec → plan の通常フローで別途)。file:line は特記なき限り**現 HEAD で検証済の現行番号**。

---

## 1. 結論サマリ

1. **「スパゲッティ」ではなく「層が半分だけ敷かれた状態」**。lib/ には純粋ドメイン資産(replay-card、buildNextTagSet、採番群、plan-catalog、seed-from-criteria 等 — 全て現存確認済)と良い seam(entity-mutation-registry、DbExecutor 抽象、runOptimistic* helper)が既にある。負債の主因は (a) ドメインロジックの UI/route への残留、(b) client/server の同一ルール二重実装、(c) 同型コードの機械的コピペ、の 3 系統。CC / Codex が独立に同じ結論に到達し、検証でも覆らなかった。
2. **主問題は「domain が無い」ことではなく「use-case が presentation/API に混在している」こと**(CC・Codex 一致)。4 大 hotspot: `card-tags-section.tsx`(タグ集約の client CRUD 約 430 行が presentation に常駐 — side peek 追加で被 import が **4 経路に拡大**)、`upload/_actions/process.ts`(761 行に課金ガード+AI+DB+文言が融合)、webhooks 2 本(課金状態遷移・削除カスケードが route 直書き)、`review-events/bulk/route.ts`(FSRS ドメイン 334 行が route 内)。
3. **二重実装が構造化している**: computeStreak(server/client 1:1 コピー・手動同期義務コメント付き)、due card 選定 3 経路、cascade 削除・UNIQUE pre-check(UI ⇄ server apply)、card 値制約 schema(scalar 部分が 3 経路・エラー文言一致要求)、outbox flush 層の同型複製、card 概念 11 表現、option の camel/snake 2 casing。**side peek 着地でカード編集 UI 一式の near-verbatim 複製が新たに加わった**(§4.4)。
4. **wire format 凍結のまま再編できる境界が大半**。ただし Codex 指摘を採用し、凍結対象は payload shape だけでなく error code・HTTP status・日本語文言・cache header・revalidatePath・op 名・ops イベント名まで「挙動同一の契約」として扱う(§6.1)。例外(pull の per-entity 手配線 generic 化、outbox 2 系統統合、競合ポリシー統一)は wire 変更を伴うため後回し。
5. **安全網は lib / API route では厚いが、UI component test はほぼ無く、Playwright/E2E は存在しない**(config・依存とも不在を検証済)。P0 では E2E より先に **contract/golden test**(/api/pull response・mutation envelope・review-events bulk result・upload result union・webhook 状態遷移の snapshot 固定)を標準とする(Codex 採用)。

---

## 2. 現状アーキテクチャ実態(検証済)

### 2.1 書込 2 系統 + pull

- **系統 A(entity 編集 = mutation outbox)**: UI → `runOptimistic*`(Dexie mirror 書込 + `entity_mutations` enqueue、coalesce)→ webLock flush → `POST /api/entity-mutations/bulk` → `entity-mutation-registry`((entity_type,op)→apply dispatch)→ `lib/cards|tags/apply-*-mutation`。ドメイン apply は registry 委譲で route に業務ロジックなし。ただし route 自体は 352 行あり、group 並列化配管(`groupMutationsByEntityKey` + `Promise.allSettled`、route 235-327)が嵩む。
- **系統 B(演習回答 = event sourcing)**: SessionRunner → Dexie `answer_events` 直書き → `review-flush`(retry controller + backoff + pullBack hook)→ `POST /api/review-events/bulk`(594 行)→ route 内 `processSession`(122-455 = 334 行): cards SELECT → answer_events INSERT → **FSRS replay fold**(264-284)→ reviews INSERT → cards UPDATE → study_days JST 集計。`deriveRating`(rating 導出ルール)も route 内 104-106。**HTTP とドメインが未分離**。
- **冪等・lock も完全別系統**: lock 名(`recallmint:entity-mutations:flush` ⇄ `recallmint:review-events:flush`)、冪等キー(mutation_id ⇄ event_id)、API、flush 実装が並存。
- **pull**: 6 stream(cards/exams/tombstones/tag_categories/tag_options/card_tags)を cursor 付き delta で `/api/pull` から取得し Dexie に LWW upsert。study_days のみ別エンドポイント(cursor なし 90 日 window)。
- **server action 系(非 local-first)**: upload(process.ts)、settings、upgrade(Stripe)、exams 一覧 create/delete。二系統の使い分け自体は一貫。

### 2.2 shotgun surgery の実測

新 entity を系統 A + pull に追加すると**最低 9 ファイル横断**(mutation-schemas / apply-* 新規 / registry / client-db(Dexie version bump)/ *-pull 新規 / api/pull/route / pull.ts 内 6 箇所 / sync-meta / UI handler)。pull 経路の per-entity 手配線が中心(pull.ts: cursor read 6 連 120-134 / params 6 連 137-145 / tombstone filter 4 連 231-242 / cursor write 6 連 264-287)。tombstone entity_type 列挙は 3 箇所(schema.ts:774 / tombstones-pull.ts:15 / pull.ts:46 — 行番号まで検証一致)。

### 2.3 データモデル(server 21 テーブル / Dexie 11 store)

- server 21 テーブル(schema.ts 冒頭コメント「13 tables」は stale — 検証でも未修正確認)。Dexie は mirror 10 + sync_meta。tombstones は store を持たず purge 駆動にのみ使用。
- 乖離の例(全て現存確認済): `ClientUserSettings` は pull writer 不在で未使用 + `custom_session_limit` 欠落(client-db.ts:105-108)。`ClientAnswerEvent.rating` は server 列に存在しない(payload 専用)。
- **「card」概念が 11 表現**(Card / ClientCard / CardOption / ClientCardOption / CardImage / ClientCardImage / ExtractedCard / ExamDetailCard / ProcessedCard / EmptyCard / cardCreatePatchSchema)。tombstone 3 重定義。option は camelCase(zod)⇄ snake_case(型)を registry が手動変換(entity-mutation-registry.ts:156-162)。
- mapper 方針が entity ごとに不統一: cards のみ双方向 pure mapper、他は pull ファイルにインライン。
- **cards の列所有が 3 context に跨る**(Codex 採用): 同一 row に Content(本文・選択肢)+ Learning(FSRS 列)+ Sync(content_version 等)が同居。「Card aggregate 1 個」では不足で、**どの use-case がどの列を更新できるか**の所有ルール定義が spec の設計判断になる。
- card_tags は updated_at を持たず created_at cursor + cards.updated_at bump に依存。purge ロジックが pull.ts:213-261 に集中(最も脆い結合点。generic 化時にこの例外意味論を落としやすい — Codex 指摘も検証で実在確認)。

### 2.4 競合解決ポリシーの 3 方式混在

outbox=LWW(coalesce + server 無条件 UPDATE、edited_at は保存のみで競合判定に不使用)/ mirror=server-wins(pull bulkPut)/ FSRS=event replay。delete op のみ skipLog により mutation_id 冪等でない(apply の自然冪等頼み)。統一は apply 意味論の変更を伴うため今回スコープ外推奨。

---

## 3. レイヤ違反(ドメインロジックの所在ズレ)— 全件現 HEAD 検証済

### 3.1 presentation 内のドメイン(exams UI)

| # | 内容 | 場所(現行) |
|---|---|---|
| V1 | タグ集約の client CRUD ユースケース一式(rename/color/delete/create、impact 集計、create+assign)が component の module スコープに常駐、**他 presentation 4 経路から import される**(side peek で拡大) | `card-tags-section.tsx:80-508`(importer: exam-card-table.tsx:86-98 / exam-card-table-tag-cell.tsx:28-31 / card-tag-add-popover 系 / **exam-card-side-peek.tsx:23**) |
| V2 | UI 直の Dexie アクセス(4-store live query、tx 直張り)。side peek 経由でも同経路に到達可能に | exam-card-table.tsx:313-329 / inline-card-list.tsx:92-118 / inline-text-field.tsx:172 / use-card-tag-toggle.ts:93-125 |
| V3 | mutation patch・「空文字→null」正規化ルールの UI 埋め込み | inline-card-list.tsx:218-236 / inline-text-field.tsx:67-71,198-209 / use-card-options.ts:159-225 |
| V4 | タグ並び comparator(category→option 2 軸合成)の 3 重コピー(primitive は lib 共有済だが合成が verbatim 複製) | card-tags-section.tsx:558-570 / exam-card-table-tag-cell.tsx:79-87 / _lib/tag-sort-key.ts:20-28 |
| V5 | tag filter 値の集合演算(toggle+prune)の 2 重埋め込み | exam-card-table-filter-editors.tsx:176-181 / exam-card-table-condition-bar.tsx:143-153 |
| V6 | **(新規・side peek 由来)** commit セマンティクス知識の container 漏れ: Dialog の onOpenChange が `activeElement.blur()` を命令的に呼び、InlineOptionCell が commit-on-unmount を持たない事実に依存して close 時 commit を担保 | exam-card-side-peek.tsx:56-64 |

補足: `_lib/column-pinning.ts:6` が `../_components/exam-card-table-columns` を import(_lib→_components の逆向き。列順 SSoT を component から導出する意図的設計だが、lib 昇格時の循環要因)。

### 3.2 その他 app 領域(全て現存確認済)

- **upload/_actions/process.ts(761 行)**: `_processUpload`(135-686)に入力 parse / ページ・サイズ上限 / advisory lock + in-flight / 月次 OCR quota + Gemini 日次上限 / exam・sourceDoc INSERT / AI 呼出 / cards bulk INSERT + applyOcrTags + cardCount / 台帳 / 失敗補償 / env ポリシー / 日本語文言が直列混在。
- **session-runner.tsx(627 行)**: 正誤判定(集合一致 203-211)、rating 自動決定(correct→3/incorrect→1 :334)、tally 重複防止、FLUSH_THRESHOLD=5、rate-then-confirm 制御が UI 内。
- **study-session-host.tsx:57-64**: 「Dexie≥1 件なら mirror、0/throw なら server props」の card 選定ポリシーが useEffect 内。
- **upload-form.tsx:225-241**: quota/上限判定が client にも実装(server 198,218,291 と同一ポリシーの二重)。
- **upgrade-plans.tsx:375-380**: `rankPlan` の inline copy(コメント自認)。
- **tags/category-list.tsx:134-198**: cascade 削除 + 影響集計が UI ハンドラ内(server apply-tag-mutation と等価処理の二重)。option-row.tsx:61-222 の UNIQUE 事前判定も同様。

### 3.3 route 内のドメイン(API 層)

- **webhooks/stripe/route.ts(441 行)**: normalizeSubStatus(86-104)、resolvePlanFromSub(117-156)、6 event switch + DB update 直書き(178-364)、release gate(372-441)。lib 委譲は 2 関数のみ。**課金ドメインの core が route に存在**。
- **webhooks/clerk/route.ts(416 行)**: 削除カスケード(10 テーブル明示 DELETE 280-289)、Stripe cancel ループ(204-236)、DB retry・transient 判定(360-416、インフラ)まで route 同居。
- **review-events/bulk/route.ts(594 行)**: §2.1 のとおり。
- 対照的に polling/pull 4 route(dashboard/stats 57 行 / exams/status 96 行 / pull 113 行 / study-days/pull 44 行)は薄く lib 委譲済みで健全。

### 3.4 依存方向違反(件数・箇所とも検証一致)

- **lib → app**: `lib/cards/get-custom-session-cards.ts:23` → exams UI の card-filter-predicates(唯一の逆依存。study/custom UI も同 predicates + card-tag-add-popover に依存)。
- **components → app**: `components/marketing/contact-form.tsx:4` → contact route の server action。
- `../../../` 深い相対 import 2 件(AppContainer)。
- import 境界を守らせる lint(no-restricted-imports 等)は**未設定**(eslint.config.mjs 検証済)。

---

## 4. 重複・冗長・dead code — 全件現 HEAD 検証済

### 4.1 client/server 二重実装(drift 即バグ。手動同期義務コメント付きの群)

| 対象 | 場所 |
|---|---|
| computeStreak(1:1 コピー) | lib/db/streak.ts:13-46 ⇄ lib/client/streak.ts:21-49 |
| due card 選定 3 経路 | lib/cards/get-session-cards.ts / get-dexie-session-cards.ts / dashboard-actions.tsx:45-58 |
| FSRS row↔ts-fsrs 変換(「完全一致」要求) | replay-card.ts:70,92 ⇄ review-events/bulk route 内変換 ※コメントの参照名 `submit-review-tx.ts` は**現存しないファイルへの dangling 参照**(実対向は route) |
| cascade 削除・UNIQUE pre-check | tags UI ⇄ apply-tag-mutation.ts |
| upload quota/上限しきい値 | upload-form.tsx:225-241 ⇄ process.ts:198,218,291 |
| card 値制約 schema(scalar 部分・エラー文言一致要求。option 部分のみ validation/card.ts に単一化済) | mutation-schemas.ts:49-73 ⇄ card-field-handlers.ts:54-91 |
| correct_answer_ids 再生成 | apply-card-mutation.ts:83 ⇄ card-field-handlers.ts:169-174 |
| sort 順(SQL ORDER BY ⇄ JS comparator) | exams/list.ts ⇄ lib/cards/sort-like-server.ts |
| plan rank | plan-catalog.ts ⇄ upgrade-plans.tsx:375(inline copy) |

**仕分け方針(Codex 採用)**: これらを一律「単一 source 化」せず、shared pure module に寄せる対象(computeStreak、comparator、schema)と、**意図的な二段構え**(client pre-check = UX / server = authoritative: UNIQUE・cascade・quota)を区別する。client を authoritative にしない。

### 4.2 インフラ同型コピペ

- **outbox flush 層の同型複製**(entity-mutations.ts ⇄ review-events.ts: in-flight set / markAttempted / dropStale / defaultClient / FlushResult 流用で sessionSynced 常時 false)。**注: guard wrapper 層は既に helper 共有済み**(entity-mutation-flush は classifyFlushResults / withWebLock を review-flush 側から re-use)で「全複製」ではない。さらに review-flush のみ retry controller・backoff・pullBack hook・session grouping を持ち**完全同型ではない**(検証で実在確認)→ 統合は Web Lock guard / result 分類程度に限定するのが安全(Codex 採用)。
- **pull 6 module の同型パターン**(table + cursor 列 + mapper だけ違う generic factory 候補)+ pull.ts 内の 6 連手展開(§2.2)。ただし card_tags の例外 cursor 意味論(§2.3)を落とさないこと。
- **retry/backoff 3 実装**(ai/ocr.ts callWithRetry / clerk route runTransactionWithRetry / review-flush backoff — lib/retry に共通関数があるのに各自再実装)。transient error 分類 3 実装 + `lib/retry/` と `lib/transient/` の並列ディレクトリ。
- **route 認証 boilerplate 6 route 重複**(getCurrentUser → 401/空/500 + no-store)。
- **env/timestamp インライン 8 ファイル**(VERCEL_ENV ?? NODE_ENV + toISOString — 件数検証一致)。
- **inline 編集 primitive 二重実装**: InlineTextField ⇄ InlineOptionCell(`sharedBoxChrome` 文字列 verbatim 重複: inline-text-field.tsx:275 ⇄ inline-option-row.tsx:312、dirty-guard・auto-resize・commit も並行実装)。
- Error 展開 replacer(logger.ts:46 ⇄ ops.ts:121)、env prefix 検証の同型(clerk.ts ⇄ stripe.ts)。

### 4.3 dead code / stale(全件検証済・確度高)

- `plan-catalog.ts:85 isUpgrade`、`fsrs.ts:21 newCard`(参照は自 test のみ)。`jstMonthBoundsUtc` の export(内部利用のみ)。
- `buildNewOption` export(外部 consumer なし)、`CardTagBadge.onOpenEdit`(全呼出 no-op)、`createOptionAndAssignPlaceholder`(常に override される dead path)。
- `components/ui/dropdown-menu.tsx`: **import 文ゼロの完全 dead**(検証で「ほぼ未使用」から格上げ)。
- upload-form の payload-too-large 分岐(コメント自認 dead 寄り)。
- stale: schema.ts:1「13 tables」(実 21)。replay-card.ts の `submit-review-tx.ts` 参照(dangling)。
- 削除手順(Codex 採用): public import grep + 段階 re-export。実施時 HEAD で再スキャン。

### 4.4 新規負債(S5・side peek 着地分 — 2026-07-06 検証で発見)

1. **カード編集 UI 一式の near-verbatim 複製**: `exam-card-side-peek.tsx:107-185`(InlineTextField 5 種 + CardTagsSection + InlineOptionList のブロック)⇄ `inline-card-list.tsx:284-369`。「1 枚のカードを編集する UI」が card view と peek の 2 レイアウトに分岐。
2. V1 の被 import 面拡大(4 経路)・V6(commit 知識の container 漏れ)— §3.1。
3. `exam-card-table.tsx` の責務増(side peek state 289-358 追加。ドメインではないが再編対象が拡大)。
4. column-pinning は **clean に配線済**(exam-detail-view が state 単一所有 + V3 永続 — 初回調査の「未 wire WIP」記述は解消)。

---

## 5. bounded context 候補と目標像(素案 — spec で確定)

### 5.1 context 分割案(CC・Codex 一致)

1. **Content**: Exam(root, card_count 非正規化)/ Card(options を VO 集合として不変条件内包)/ TagCategory(root)+ TagOption + CardTag。
2. **Learning(FSRS)**: reviews / answer_events / study_sessions / study_days + cards の FSRS 列群。中核 = replayCard + rating 導出 + streak。
3. **Ingestion(取込・OCR)**: source_documents / upload_records / ai_usage(_users)。quota ポリシー + OCR パイプライン。
4. **Identity & Billing**: users / stripe_events / clerk_events / deletion_failures / user_settings。不変条件が schema コメント依存で中央 enforce が薄い。
5. **Sync Infrastructure(支援サブドメイン)**: entity_mutations / tombstones / sync_meta / content_version。**業務ドメインではないが挙動維持上最重要の application/infrastructure 境界**(Codex)。repository に押し込めすぎると coalesce / rollback / pull-back の意味が不可視化する。
6. Support: contact_messages(stub)。

**cards の split ownership**(§2.3)が context 間の最重要設計判断。Clerk / Stripe / Gemini / ts-fsrs は adapter/port 境界(失敗分類・idempotency 境界含む)を spec で明確化(Codex 採用)。

### 5.2 既にドメイン層へ昇格可能な純粋資産(全て現存検証済)

replay-card / fsrs(RatingInt) / next-card-sort-key / next-card-title / next-option-id / empty-card / build-next-tag-set / reindex-sort-keys / next-sort-key / sort-comparator / sort-like-server / join-card-tags / seed-from-criteria / plan-catalog(rankPlan)/ **classifyChange(所在は lib/stripe/subscription.ts:17)** / computeStreak(統合後)/ deriveExamStatuses / jst 等。

### 5.3 目標依存方向と深さ(pragmatic DDD — CC・Codex 一致)

page/_components(presentation)→ hooks(orchestration)→ use-case(application)→ domain(純粋)→ port/adapter。**フル DDD(全 aggregate に entity クラス+repository)は 9 万行 local-first では過剰**。client 側は新 repository 層を機械的に作らず、**既存 `runOptimistic*` を application service として明示昇格**する方向を主案とする(mirror 書込 + outbox enqueue + flush kick は単なる persistence でなく application transaction のため)。tenant isolation(userId スコープ — 現状は徹底されている)は抽象化時に「呼び出し側が忘れられない」構造にする。

use-case 候補: ProcessUploadedDocument、StartSmartStudySession / StartCustomStudySession、SubmitReview(RatingPolicy)、CreateTagCategory / RenameTagOption / DeleteTagCategory(cascade)/ ApplyTagToCard、ChangePlan / ScheduleDowngrade、IngestReviewEvents(server)、HandleStripeEvent / DeleteUserCascade(server)。

---

## 6. 再編境界とリスク

### 6.1 wire 凍結のまま再編できる(低〜中リスク・優先)

**凍結対象の定義(Codex 採用)**: API payload shape / Dexie schema / entity_mutations 形式に加え、error code・HTTP status・user-facing 日本語文言・cache header・revalidatePath 対象・tombstone entity_type・op 名・ops/log イベント名。特に upload / webhook 抽出で回帰しやすい。

1. review-events route の domain service 抽出(payload/response 凍結、単一 tx 境界・count mismatch 防御を維持)。
2. webhooks 2 本の lib 抽出(課金状態遷移 / 削除カスケード / DB retry を分離。test が厚く回帰検知が効く)。
3. outbox flush 層の共通化(**Web Lock guard / result 分類に限定** — retry controller・pullBack は review 系固有)。
4. タグ client CRUD の lib/tags 移設(V1)+ card write use-case 集約(V3)+ side peek 複製の解消(§4.4-1)。
5. 純粋資産の domain 層移設(§5.2)+ 二重実装の仕分け・単一 source 化(§4.1 の方針)。
6. card-filter-predicates の lib 昇格(逆依存 2 系統の解消)。
7. pull 6 module の server 内 factory 化(wire に出ない範囲・card_tags 例外注記)。

### 6.2 wire 変更を伴う(今回スコープ外推奨)

pull per-entity 手配線の registry-driven 化(PullResponse 型 = wire そのもの)/ outbox 2 系統統一 / 競合解決 3 方式統一 / Dexie store・index 変更全般(過去の store drop は「stg truncate・active user 0」前提の実績で、本番データありでは pending outbox 喪失リスク)。

### 6.3 挙動維持が特に難しい箇所(地雷リスト — 全件現存検証済)

- exam 詳細の**単一 subscription 不変条件**(2 つの useLiveQuery を view 分岐の conditional unmount で排他。side peek は新規 subscription を作らず liveData から派生しており不変条件は維持されている)/ inline-text-field の commit-on-unmount + dirty-guard / use-card-options の ghost merge / TagCell placeholder override / selection prune HS-2(現 490-516)/ scroll collapse + virtualizer の memo 凍結 / **side peek の blur 依存 close commit(V6)**。
- session-runner の fire-and-forget + tally(二重登録・欠落に直結)/ process.ts の advisory lock 保持前提 tx 境界 / upload-form の React 19 batching 依存 / tags optimistic rollback の Dexie auto-rollback 依存 / applyOcrTags の同一 tx 前提採番。
- **import 経路が load-bearing**: lib に 'use client' ゼロ(検証済 — grep ヒットは全てコメント内文字列)、server-only は **13 ファイル**、境界は「getClientDb が server で throw」+ コメント慣習のみ。移動で client bundle への server-only 混入が起きやすい。module-load 時 throw(clerk.ts / stripe.ts / price-mapping)の発火位置も import 順依存。
- UI 抽出は正しさの前に**既存 interaction の characterization**(現挙動の test 固定)が先(Codex)。

### 6.4 安全網の実態と P0 方針

- lib: co-located test ~88% / app: ~78%(API route 全 8 本 test 付き、webhooks 特に厚い)→ ここは安心して動かせる。
- components: ~13%。**Playwright/E2E は不在**(config・依存・spec ファイルとも無しを検証済)。integration 3 本のみ、legal-pages は source-grep smoke(ファイル移動で偽陽性破綻)。
- **P0 標準 = contract/golden test**(/api/pull response・mutation envelope・review-events bulk result・upload result union・webhook 状態遷移の snapshot 固定)+ 主要フロー smoke checklist。E2E 導入(新規依存 = 事前相談)は任意の別判断。
- **import 境界 lint は allowlist 付き段階導入**(現状違反を allowlist 化 → 移設ごとに削る。一括強制は大量移動と絡みレビュー不能化)。

---

## 7. フェーズ分割の骨子(提案 — plan ではない)

- **P0 準備**: contract/golden tests + smoke checklist / import 境界 lint(allowlist 方式)/ dead code・stale コメント掃討(§4.3、低リスク・即効)/(E2E は別判断)。
- **P1 domain 抽出(純粋層)**: §5.2 の移設 + 二重実装の仕分け・単一 source 化(computeStreak、comparator 3 コピー、filter 代数。option schema 統一は casing 変換面があるため慎重に)。
- **P2 server 側 use-case 化**: review-events route 抽出 → webhooks 2 本抽出 → process.ts 分解(tx 境界・advisory lock 維持)。test が厚い領域なので先行。
- **P3 client 側 use-case 化**: タグ CRUD の lib 移設(V1)→ card write 集約(V3)→ side peek 複製解消(§4.4-1)→ `runOptimistic*` の application service 昇格(新 repository 層は作らない方向)→ inline primitive 統合。地雷密集地帯のため characterization 先行で最も慎重に。
- **P4 インフラ DRY**: outbox flush 層の限定共通化 / pull server 側 factory 化 / retry・transient 統合 / route 認証 wrapper / lib ディレクトリ再編(基準統一)。
- **P5(任意・別判断)**: wire 変更系(§6.2)。今回スコープ外推奨。

各フェーズは sprint フロー(brainstorming → spec → plan → subagent-driven 実装 + canonical/Codex review)に載せる。複数 sprint 想定。実施時は着手時 HEAD で対象箇所を再スキャン(stale 化防止)。

---

## 8. OT への論点(判断が要るもの)

1. **DDD の深さ**: pragmatic DDD(domain 純粋層 + use-case 関数 + 既存 seam 昇格 — CC・Codex 一致の推奨)で確定してよいか。下位論点: client 側は `runOptimistic*` 昇格で留め、新 repository 層は作らない方針の可否。
2. **スコープ境界**: wire 変更系(§6.2)を除外(推奨)してよいか。
3. **安全網**: P0 = contract/golden tests + smoke checklist を標準、Playwright E2E は任意 — この形で確定してよいか。
4. **フェーズ順**: §7 の P0→P4 骨子で spec/plan 起草に進んでよいか。どのフェーズから sprint 化するか。
5. **進行中機能との順序**: S5・side peek は着地済み(調査に反映済)。以降も exams UI に機能が積まれるほど P3 の対象が広がるため、リファクタ着手時期の判断が必要。

---

## 9. 検証記録(2026-07-06、検証 agent 4 体 / 現 HEAD 5d3baef)

初回調査(6592323)以降の実コード変更は S5 列固定・side peek T1-T3・exam B+C fix・sync-meta V3 のみ(全て exams UI / sync-meta 領域)。webhooks・lib 大半・study/upload/tags・eslint・テスト設定は無変更。両調査の主張は **9 割超が CONFIRMED**(行番号ズレは軽微で本文に現行番号を反映済)。修正・追加は以下:

| # | 種別 | 内容 |
|---|---|---|
| 1 | STALE | 「column-pinning.ts は未 wire の WIP」→ S5 で配線済(exam-detail-view 単一所有 + V3 永続、clean) |
| 2 | 追加 | side peek による新規負債 4 件(§4.4): カード編集 UI near-verbatim 複製 / V1 被 import 4 経路化 / V6 blur 依存 commit / table 責務増 |
| 3 | 修正 | 「flush orchestrator ほぼ全複製」→ 複製は outbox flush 層限定。guard wrapper は helper 共有済み、review 系のみ retry controller・pullBack 保持(Codex の統合限定論を裏付け) |
| 4 | 修正 | server-only ファイル数 19 → **13**(定性主張「境界は慣習依存」は維持) |
| 5 | 修正 | replay-card.ts コメントの参照先 `submit-review-tx.ts` は現存しない(dangling。実対向は review-events route 内変換) |
| 6 | 修正 | classifyChange の所在は plan-catalog でなく lib/stripe/subscription.ts:17 |
| 7 | 格上げ | dropdown-menu.tsx は「ほぼ未使用」→ import ゼロの完全 dead |
| 8 | 注記 | entity-mutations route は「ドメインは registry 委譲で薄い」が正確(route 自体は並列化配管で 352 行) |

## 10. 出典

- CC 初回調査: Explore agent 6 体(exams UI / データ層 / sync 基盤 / その他 app 領域 / lib サービス群 / API・横断)— 本書に統合済。
- Codex 独立調査 raw: `docs/codex/2026-07-06-plan-ddd-refactor-investigation.md`(採用論点は本文に統合済)。
- 現状検証: 検証 agent 4 体(exams UI / その他 app 領域 / sync・データ層 / lib・API 横断)— verdict と現行 file:line を本文に反映済。
