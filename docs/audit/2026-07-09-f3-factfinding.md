# 完全 DDD F3(Card / Tag / Exam aggregate)方針決め fact-finding

- 日付: 2026-07-09 / branch `develop` / HEAD `aafcae7`(F1 + F2 + Group A prod 反映済)
- 役割: F3 着手前の read-only 調査。**impl / spec / schema 変更なし**。F3 は spec でなく「**測ってから方針を決める**」ための調査(repository 深さ・sprint 分割・cross-aggregate 境界が未確定)。判断は claude.ai + OT に返す。
- 位置づけ: 意図 doc `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §5 の F4(= 本 doc の「F3」。意図 doc の phase 番号では Card/Tag は F4)。型は F1(Subscription)/ F2(Session)で確立済 — aggregate + VO + 意図別 repository + golden 先張り(G)→ 純粋 refactor(R・golden 更新ゼロ)→ 挙動変更隔離(W)+ domain 純度 lint。
- 方法: 中核 server / client file を controller が first-hand 精読 + Explore 3 体(test/golden 網 / Card twin blast radius / Exam 境界 + card_count 全 write site + registry + schema)。file:line は HEAD `aafcae7` 時点。
- v37 保留事項への回答が本調査の主目的: 「単純 CRUD aggregate(Card/Tag/Exam)に repository をフルで敷くか。学習/一貫性目的なら儀式層でも可」。→ **§所感 1** で結論。

---

## Step 0: 意図 doc §3-4 の Card/Tag/Exam 記述を現 HEAD 検証 — **記述は概ね正確・framing 1 点を要更新**

`git diff --stat 7c90246..HEAD` で確定: 意図 doc の baseline(HEAD `7c90246`)以降、**Card/Tag/Exam の source file で変わったのは `lib/cards/card-field-handlers.ts`(+41 行)ただ 1 本**(commit `9c530e9` = A-1)。他の crux(apply-card-mutation.ts / card-write.ts / tag-crud.ts / apply-tag-mutation.ts / build-next-tag-set.ts / create-exam.ts / delete-exam.ts / derive-exam-statuses.ts)は**全て無変更**。DDD P3 の card-write / tag-crud 移設は `7c90246` **より前**に完了しており baseline に織り込み済。

| 意図 doc §3-4 の記述 | 現 HEAD 検証結果 |
|---|---|
| §4 発見 #1「single 制約 server 検証欠落(疑い)」 | **CLOSED**。A-1(`9c530e9`)が `card-field-handlers.ts:226-253`(`handleTagOptionIds`)に server enforce を追加済。**enforce の所在 = Tag の apply でなく Card の `tag_option_ids` field handler**(= 重要な cross-aggregate 配置事実、§3)。 |
| §4 発見 #3「selected_answer_ids ⇄ options」 | Session ingest(A-2 `82f17fc`)で closed。**Card write path は無関係**(review ingest 側の話)。 |
| §3 Card「二重実装 構造的に残る / 中難度」 | **framing 更新要**。実測 = client 側は既に shared pure module に単一化済(§2)。「二重実装」の実体は **server が pure 関数を import せず inline 再実装している dedup 課題**であって、client 書き換えを要する cross-boundary divergence ではない。blast radius は LOW(§所感 3)。 |
| §3 Tag「single 制約は Card との cross-aggregate」 | 確定。加えて **test gap が実問題**(§5)。 |
| §3 Exam「status が source_document 外部参照・境界曖昧 / card_count が apply に埋没」 | **確定・強化**。exams table に status 列は**存在しない**(§4)。card_count write は **3 site**(apply-card-mutation ×2 + OCR bulk 1)。 |

**結論**: 意図 doc は入力として十分。Card の「二重実装が client 書き換えを強いる」という含意だけ実測で下方修正(§2/§所感 3)。

---

## Step 1: 各 aggregate の不変条件密度 + 分類(repository 深さ判断の主材料)

各不変条件を「**状態遷移・整合性ルール**(F1/F2 が濃かった側)」か「**単純 CRUD バリデーション**(bounds / 正規化 / 導出)」に分類。フル repository の実益は前者の密度で決まる。

### Card(own 不変条件 ~6 + cross-aggregate 2・**state machine なし**)

| # | 不変条件 | 分類 | 現在地(file:line) |
|---|---|---|---|
| 1 | correct_answer_ids 導出(options.is_correct → id 配列) | **CRUD/導出**(デノーマ) | client: card-write.ts:101(`deriveCorrectAnswerIds`)/ use-card-options.ts:180 / session-runner.tsx:206。server: apply-card-mutation.ts:83 / card-field-handlers.ts:177-179。OCR: upload-persistence.ts は Gemini 出力を信任(再導出なし) |
| 2 | null 正規化(空文字→null: sort_key/explanation/memo) | **CRUD** | client: card-write.ts:33-37(`normalizeNullableTextField`)+ inline-text-field.tsx:184。server: card-field-handlers.ts:140/153/160(×3 inline) |
| 3 | 長さ/件数 bounds(title 200 / question 10000 / options 1-50 / option.text 1000 等) | **CRUD** | server-only zod、**3 file に分散**: mutation-schemas.ts:49-73 / card-field-handlers.ts:60-92 / validation/card.ts:14-27(計 ~9 copy) |
| 4 | option id 重複排除 | **CRUD** | card-field-handlers.ts:90-92 |
| 5 | option id 採番 | client-only(server passive) | next-option-id.ts:14(`nextOptionId`)← use-card-options.ts:251。server は受動 |
| 6 | **card_count ±1** | **cross-aggregate**(Card×Exam) | apply-card-mutation.ts:113(+1)/:176(-1 GREATEST)+ OCR: upload-persistence.ts:39(+N)。§3 |
| 7 | tombstone on delete | sync 整合 | apply-card-mutation.ts:156-164 |
| 8 | **single カテゴリ制約** | **cross-aggregate**(Card×Tag) | card-field-handlers.ts:226-253(A-1)。§3 |

**判定所感**: Card は **state machine を持たない**。own 不変条件は bounds / 正規化 / 導出 = **CRUD 系**。domain 的に面白いのは cross-aggregate 2 件と「twin の dedup(rule of three 実在)」であって、F1(Subscription 9 status 遷移)/ F2(冪等・replay・JST)のような**状態遷移の濃さは無い**。フル aggregate を敷く実益 = 中(dedup は実益、state machine 化は該当なし)。

### Tag(own 不変条件 ~5 + cross-aggregate 1・**write が 2 module に split**)

| # | 不変条件 | 分類 | 現在地 |
|---|---|---|---|
| 1 | UNIQUE(category_id, name) | **CRUD/一意性** | server 事前 SELECT: apply-tag-mutation.ts:189-202 / 258-275 / 289-304。client throw: tag-crud.ts:51,112。**DB UNIQUE 実在**(schema tag_options) |
| 2 | **single/multi select_type 制約** | **cross-aggregate**(card_tags write で発火) | §3。select_type は immutable(apply-tag-mutation.ts:66) |
| 3 | cascade delete(FK CASCADE + mirror 用 tombstone) | sync 整合 | server: apply-tag-mutation.ts:111-161/325-354。client: tag-crud.ts:171-233 |
| 4 | sort_key 採番(nextSortKey = max+1) | client-only 生成 | tag-crud.ts:300/345。server は受動的に格納 |
| 5 | owner-scope / orphan fail-closed / category 間移動検証 | CRUD/所有権 | apply-tag-mutation.ts 各所 |

**Tag write の split(構造要点)**: category/option の CRUD = `apply-tag-mutation.ts`(server)+ `tag-crud.ts`(client)。**card_tags junction(タグの付与/解除)= `card-field-handlers.ts` の `tag_option_ids` handler = Card aggregate の update_field op**。single 制約はこの junction write で発火するため、**Card 側に配置されている**(A-1)。

**判定所感**: Tag も state machine なし・CRUD 系(一意性 / cascade / sort_key 生成)。多くが **DB 制約(UNIQUE / FK CASCADE)で担保可能**。フル aggregate の実益 = 低。実価値は **test gap 閉じ + cross-aggregate 配置の決着**(§5 / §3)。

### Exam(own 不変条件 ~2・**ほぼ空 aggregate**)

| # | 不変条件 | 分類 | 現在地 |
|---|---|---|---|
| 1 | name 必須(max 200) | 些末 CRUD | create-exam.ts:20-24 |
| 2 | **card_count 整合** | **cross-aggregate**(Card write が所有) | §3。exam 側では書かない |
| 3 | **status 導出** | **SourceDocument に帰属**(exams に status 列なし) | derive-exam-statuses.ts(source_documents 行から導出・15 分 stale timeout)。§4 |
| 4 | cascade delete | sync 整合 | delete-exam.ts:48-90(FK CASCADE: source_documents/cards/reviews + tombstone) |

**判定所感**: Exam は **own 不変条件がほぼ無い**。create = name INSERT のみ。status は SourceDocument のライフサイクル、card_count は Card write の所有。**フル aggregate 化 = 儀式**。実価値は Exam↔SourceDocument の**境界再設計**(§4)。

---

## Step 2: Card の二重実装の実態 ★F1/F2 との最大の差分 — **client 既に単一化・blast radius LOW**

意図 doc は Card を「二重実装 構造的に残る」と framing したが、**実測は逆**: client 側のルールは既に shared pure module に単一化されており、二重実装の実体は **server が pure 関数を import せず inline 再実装している**点(= DRY 課題)。

### 実測(Explore 実測 + first-hand 確認)

| ルール | client site | server site | 単一化コスト |
|---|---|---|---|
| A. correct_answer_ids 導出 | card-write.ts:101(shared 関数)/ use-card-options.ts:180(shared を call)/ session-runner.tsx:206(inline) | apply-card-mutation.ts:83(inline)/ card-field-handlers.ts:177-179(inline) | server が card-write.ts の pure 関数を import + session-runner を shared 化。**client 機能変更ゼロ** |
| B. option id 採番 | next-option-id.ts:14(shared)← use-card-options.ts:251 | 無(server passive) | **既に単一。変更不要** |
| C. null 正規化 | card-write.ts:33-37(shared)← inline-text-field.tsx:184 | card-field-handlers.ts:140/153/160(×3 inline) | server が shared を import。**client 変更ゼロ** |
| D. bounds | 無(UI は maxLength なし) | zod ×3 file(mutation-schemas / card-field-handlers / validation/card) | server 内 zod を 1 source に集約。**client 変更ゼロ** |
| E. client write plumbing | inline-card-list.tsx(create)/ use-card-options.ts(options)/ inline-text-field.tsx(text) 3 site | 無(generic helper) | **既に runOptimistic* に単一化。変更不要** |

### 重要事実

- **`card-write.ts` は PURE**(`use client` / Dexie / React なし、header 明記)= **server から import 可能**。よって Card の「共有 pure module 化」= server が既存 client pure module(または新設 lib/cards/domain の純関数)を import する **server 側 dedup**。client は書き換わらない。
- **client 機能 blast radius ≈ 0**: 唯一 session-runner.tsx:206 の inline 導出を shared 化する任意 import 1 件(一貫性目的、機能必須でない)。
- **local-first ゆえ「検証は 2 回実行」は不可避**(client 楽観 + server 権威)。ただし F2 で確立した「**定義 1 つ・実行 2 回**」がそのまま当てはまる。Card は既に定義がほぼ単一。
- **第 4 の correct_answer_ids locus = OCR path**: upload-persistence.ts:24-27 は Gemini 出力(ocr-extract.ts:232 が correct_answer_ids を生成)を**そのまま INSERT・server 再導出なし**。「correct_answer_ids == filter(is_correct)」不変条件は OCR path では enforce されていない(AI 信任境界)。共有 module で universal に enforce したいなら OCR path も対象になる = **scope 判断点**(通常は AI 信任として別枠が妥当)。

**結論**: 意図 doc の「Card は client 書き換えが要る(中難度)」は **overstated**。実測 Card = server 側 dedup 中心・client ほぼ無変更 = **F1/F2 と同じく server-focused・blast radius LOW**。

---

## Step 3: cross-aggregate invariant の境界(bounded context 判断)

### single 制約(Card × Tag)— **card_tags junction で発火・現状 Card 側配置**

- **性質**: select_type は **TagCategory の属性**、制約が発火するのは **card_tags(card↔option 割当)の write**。「1 card の single カテゴリに option ≤ 1」= card_tags 集合の不変条件を TagCategory.select_type で parameterize したもの。
- **現在の enforce**: server = card-field-handlers.ts:226-253(A-1・**Card の tag_option_ids op**)。client = buildNextTagSet(use-card-tag-toggle.ts:85 / use-bulk-card-tags.ts:109)+ handleCreateOptionAndAssign inline(tag-crud.ts:445-455)= client 3 site。
- **配置の選択肢**:
  - **(a) Card(または薄い CardTags)aggregate が所有**〔現 A-1 配置〕: card_tags = card の tag 集合。TagCategory.select_type は read-only 参照 data。**controller 推奨** — 制約の主語が「この card の割当集合」であり、書込点も Card op。
  - (b) CardTagging domain service(両 aggregate を跨ぐ明示 service)に分離。
  - (c) TagCategory が「選択可能数」を、Card が「割当集合」を持ち、service が突合。
  - → (a) が現配置と整合・最小。VO 候補 = `SelectType`('single'|'multi')。

### card_count ±1(Card × Exam)— **派生キャッシュ・write 3 site・DB 保証なし**

- **write site 全数**: apply-card-mutation.ts:113(+1)/:176(-1 GREATEST)/ upload-persistence.ts:39(+N bulk)。**DB trigger / CHECK は無**(schema `integer('card_count').default(0)`・migration に trigger なし)。全て card write と同一 tx 内。
- **性質**: comment 明記の通り「**派生キャッシュ**」(exams.updatedAt を動かさない = 一覧並び順を乱さない perf 最適化。Y-2 T-B4 の [user_id+exam_id] index も card_count perf 由来)。不変条件 = `card_count == COUNT(cards WHERE exam_id)`。
- **配置の選択肢**:
  - **(a) Card write path が維持する cross-aggregate ルール**〔現状〕。ただし ±N logic が 3 site に散在 → **1 helper に集約**(card apply + OCR persistence が共有)が最小改善。**controller 推奨(低リスク)**。
  - (b) read-model/projection 化(COUNT or 射影で都度算出、write-time 結合を除去)= DDD 的に clean だが **perf 退行リスク**(現に perf cache として導入された経緯)+ 高コスト。
  - → (a) 維持 + ±N helper 集約を推奨。(b) は perf 検証込みの別 sprint 案件。

---

## Step 4: Exam の境界曖昧性 — **status 列は存在せず・SourceDocument に全面帰属**

- **裏取り確定**: exams table に **status 列は無い**(schema exams 定義)。exam の「status」は `derive-exam-statuses.ts` が **source_documents 行から read-time 導出**(exam ごと createdAt 最新行: processing/completed/failed、processing かつ 15 分超 → failed の stale fallback)。DB accessor = source-doc-status.ts(getExamStatusMap / reconcileStaleProcessing / hasActiveProcessingUpload)。
- **exam の own state** = name + card_count(cache)+ contentVersion(楽観 lock)+ archivedAt のみ。**保護すべき状態遷移が無い**。
- **判定**: Exam を今フル aggregate 化する価値 = **低(儀式)**。本丸は **Exam↔SourceDocument の bounded context 再設計**(upload/OCR ライフサイクル = Content/Ingestion context)。これは Card/Tag より大きい独立設計で、status の帰属(SourceDocument aggregate 側に status 遷移を持たせる)を含む。**Exam は現状の薄い server action のまま据え置き、境界再設計とセットで後回しが妥当**。

---

## Step 5: 既存 test 網 + golden(F3 golden 先張りの対象特定)

| aggregate | 現状カバレッジ | golden 先張り必要度 |
|---|---|---|
| **Card** | **強**: card-write.test(8)/ card-field-handlers.test(57・A-1 +4)/ apply-card-mutation.test(18・card_count ±1 + integrity + 冪等) | **低**。不変条件 1-4/6-7 は hard-assert 済 = refactor 背後で安全。**ほぼ ready** |
| **Tag** | **gap 有**: apply-tag-mutation.test(13)/ build-next-tag-set.test(8・client toggle のみ) | **高**。① **UNIQUE(category,name) の behavioral test 無**(schema-only)② **cascade tag_category→tag_options 未 pin** ③ **card→card_tags cascade 未 pin** ④ sort_key 採番 未確認。→ **Tag が golden 先張りの主対象** |
| **Exam** | derive-exam-statuses.test(10・強)/ create-exam owner-scope は mock-level | **中**。card_count の **exam 側 inverse integrity 未 pin** / delete owner-scope WHERE spy 無 |
| **contract** | pull(6 stream)/ entity-mutations-bulk(9 op・**handler mock = apply 副作用は contract で未検証**)/ webhook-clerk(10-delete cascade に tag_categories 含む) | entity-mutations-bulk は wire shape のみ凍結、**apply 実挙動は unit test 側が pin**。F3 で apply を aggregate 経由に配線するなら unit golden が回帰の正 |

**P0 凍結契約(F3 で触れる境界)**: option `isCorrect→is_correct` 変換(entity-mutation-registry.ts:156-162)/ card_tags cursor=maxCreatedAt + whole-set 縮小補完の非対称(§A #3/#4)/ tombstone entity_type union(exam/card/tag_category/tag_option・§A #5)/ card・tag delete の skipLog(§A #10)。**refactor はこれらの wire を一字も変えない前提**(F1/F2 の R 制約と同じ)。

---

## 所感(claude.ai + OT へ・**本調査の主目的**)

### 1. repository 深さ = 3 aggregate それぞれフル / 薄い / 後回し

| aggregate | 推奨 | 根拠 |
|---|---|---|
| **Card** | **薄い repository + 共有 pure module(dedup)** | own 不変条件は CRUD 系で state machine 無し。ただし twin dedup は **rule of three 実在**(correct_answer_ids ×3 / null-norm ×3 / bounds ×3 file)= 共有 pure module 化は儀式でなく**実益**。フル aggregate + VO の重装は Subscription 級の state 遷移が無いため過剰(YAGNI)。apply-card-mutation は既に DbExecutor で repository 前段化済 = 薄い interface 化で足りる |
| **Tag** | **薄い(VO = SelectType のみ)+ test gap 閉じ** | CRUD/一意性/cascade は大半 DB 制約で担保。フル aggregate の増分価値 低。実価値は §5 の test gap と §3 の single 配置決着 |
| **Exam** | **後回し(境界再設計とセット)** | own 不変条件ほぼ無し・status は SourceDocument 帰属。今やると純儀式 |

**v37 保留への回答**: Card/Tag に F1 型のフル aggregate+VO+repository を敷くのは、**不変条件が CRUD ゆえ大半が「型を揃える儀式(学習目的)」**。非儀式の実益は (i) Card twin の共有 pure module dedup(rule of three)、(ii) Tag test gap 閉じ、(iii) cross-aggregate 配置決着、の 3 点に集約される。**「教科書に書いてあるから」でなく「不変条件が実在するから」導入する**(意図 doc §5 リスク原則)に忠実であれば、Card/Tag は**薄く**、Exam は**後回し**が妥当。

### 2. sprint 分割 = F3 を 1 回か F3a/b/c か

**分割推奨**(3 aggregate は独立でない: single 制約が Card×Tag を、card_count が Card×Exam を結合。card_tags junction は Card op として書かれる):
- **F3a = Card**: 共有 pure module dedup(correct_answer_ids / null-norm / bounds を単一定義・server import)+ card_count ±N helper 集約。blast radius LOW・DRY 実益。
- **F3b = Tag**: golden 先張り(UNIQUE / cascade)→ 薄い aggregate + VO(SelectType)+ single 制約配置決着。**card_tags を触るため Card(card-field-handlers)と接触** → F3a と**同 sprint 化 or 直列**が合理的(card-field-handlers を二度触らない)。
- **F3c = Exam**: **単独 sprint にせず**、SourceDocument/Ingestion 境界再設計に**合流させて後回し**。
- 最小案: **F3 = Card+Tag(card_tags 共有面で結合)を 1 sprint、Exam defer**。

### 3. Card 二重実装単一化が要求する client blast radius(F1/F2 の client diff ゼロ比)

**LOW ≒ F1/F2 と同等**。client のルールは既に shared pure module(card-write / next-option-id)+ runOptimistic* に単一化済。単一化は **server 側 dedup**(inline 導出 ~5 site を pure import に置換 + bounds zod 集約)。client 機能変更は **0**(session-runner の任意 consistency import 1 件のみ)。意図 doc の「client 書き換えが広い」懸念は**実測で否定**。唯一の注意 = OCR path(Gemini 信任・server 再導出なし)は別 write path、共有 module の対象に含めるかは scope 判断(通常は AI 信任として除外)。

### 4. cross-aggregate invariant の置き場

- **single 制約**: **(a) Card(card_tags 集合)が所有・TagCategory.select_type は参照** を推奨(現 A-1 配置と整合)。VO = SelectType。
- **card_count**: **(a) Card write path 維持 + ±N logic を 1 helper に集約**(現状 3 site)を推奨(低リスク)。(b) projection 化は DDD clean だが perf 退行リスク(派生 cache として導入された経緯)で別 sprint 案件。

### 5. Exam を今やるか後回しか

**後回し**。Exam は own 不変条件がほぼ無く、status = SourceDocument 帰属・card_count = Card 帰属。今やると純儀式。実価値の Exam↔SourceDocument 境界再設計(status 遷移を SourceDocument aggregate に持たせる Content/Ingestion context)は Card/Tag より大きい独立設計 → 別途 spec 起票。

---

## F3 spec の主判断点(先取り・OT / claude.ai へ)

1. **scope**: F3 = Card + Tag のみ(Exam defer)で確定してよいか。1 sprint(card_tags 結合面)か F3a/F3b 直列か。
2. **repository 深さ**: Card/Tag を「薄い(共有 pure module + VO + 薄い repository interface)」に留める方針でよいか(フル aggregate 儀式を避ける YAGNI 判断)。
3. **single 制約の帰属**: Card(card_tags 集合)所有 + SelectType VO で確定してよいか。
4. **card_count**: (a) 維持 + ±N helper 集約(推奨)か (b) projection 化(perf 検証込み別 sprint)か。
5. **OCR path の扱い**: correct_answer_ids 共有 module を OCR ingestion(Gemini 信任)にも及ぼすか、AI 信任境界として除外か。
6. **golden 先張り範囲**: Tag の UNIQUE / cascade behavioral golden を先張りの筆頭に。Exam の card_count inverse integrity をどこまで足すか。

---

## 参照

- 意図 doc: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`(§3-4 F3 骨子 / §5 フェーズ骨子 = 本 doc は §5 F4 に相当)
- F1/F2 型: `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md` / `docs/superpowers/specs/2026-07-09-f2-session-aggregate-design.md`(G/R/W 型)/ `docs/audit/2026-07-09-f2-session-factfinding.md`(本 doc の構造 template)
- 契約: `docs/audit/2026-07-06-p0-contract-baseline.md`(§A #3/#4/#5/#6/#10 = F3 で触れる wire 境界)
- Group A: `docs/superpowers/specs/2026-07-08-group-a-invariant-fixes-design.md`(A-1 single 制約 server enforce = `9c530e9`)
- 中核 server: `lib/cards/apply-card-mutation.ts`(create/delete + card_count)/ `lib/cards/card-field-handlers.ts`(update_field 7 handler + A-1 single 制約)/ `lib/tags/apply-tag-mutation.ts`(tag CRUD + UNIQUE)/ `app/(app)/app/exams/_actions/{create,delete}-exam.ts` / `lib/exams/derive-exam-statuses.ts`(status 導出)/ `app/(app)/app/upload/_actions/upload-persistence.ts`(OCR bulk + card_count +N)
- 中核 client(既に単一化): `lib/cards/card-write.ts`(PURE・deriveCorrectAnswerIds / normalizeNullableTextField)/ `lib/cards/next-option-id.ts` / `lib/tags/build-next-tag-set.ts`(single toggle)/ `lib/tags/tag-crud.ts`(CRUD use-case)
- registry: `lib/sync/server/entity-mutation-registry.ts`(9 op dispatch: card/tag_category/tag_option × create/update_field/delete)
- schema: `lib/db/schema.ts`(exams = status 列なし / source_documents = status 保持 / tag_categories = selectType immutable / tag_options = UNIQUE(category_id,name) / card_tags = composite PK junction)
