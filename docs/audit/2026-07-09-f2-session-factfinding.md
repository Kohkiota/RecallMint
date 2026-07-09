# 完全 DDD F2(Session aggregate = StudySession + AnswerEvents)fact-finding

- 日付: 2026-07-09 / branch `develop` / HEAD `6cd468a`(F1 + Group A prod 反映済)
- 役割: F2 着手前の read-only 調査。**impl / spec / schema 変更なし**。判断は claude.ai + OT に返す。
- 位置づけ: 意図 doc `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` §5 の F2。型は F1(Subscription)で確立済 — aggregate + VO + 意図別 repository + golden 先張り → 純粋 refactor(golden 更新ゼロ)→ 挙動変更隔離 commit(spec `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md`)。
- 方法: 中核 file(ingest / route / schema / P0 baseline)を controller が first-hand 精読 + Explore 2 体(client mirror 面 / test 網)。file:line は HEAD `6cd468a` 時点。

---

## ⚠ kickoff の事実誤り 1 件(訂正)

kickoff は「A-2(selected_answer_ids 存在検証・**c5075e0**)」と記すが、**commit 取り違え**。実際は:

- `82f17fc` `fix(reviews): validate selected_answer_ids against card options [reviewed]` = **selected_answer_ids 存在検証(= Group A task2 = A-2)**。ingest に +34 行 / contract test に +157 行。
- `c5075e0` `fix(billing): notify ops when db write fails after stripe success` = **Group A task3 = A-3 = 課金 observability**(selected_answer_ids と無関係。F1 spec:177 / F1 factfinding:87 も「A-3 = c5075e0 = 検知のみ」と一致)。

以降、本 doc の「A-2」は `82f17fc` を指す。挙動理解に影響なし(調査対象の実体は正しく特定済)。

---

## Step 0: 骨子 doc(§3-4)の F2 記述を現 HEAD 検証 — **ほぼ正確・A-2 分のみ更新要**

骨子は HEAD `7c90246`(F1 / Group A 前)時点。現 HEAD `6cd468a` との diff を git で確定した:

- **ingest-review-events.ts を触った commit は `82f17fc`(A-2)ただ 1 本**(`git log 7c90246..HEAD -- lib/reviews/ingest-review-events.ts`)。
- **route.ts(bulk)は `7c90246` 以降 無変更**。

よって骨子の構造記述は現役だが、以下 2 点を更新:

1. **行番号**: 骨子「ingest-review-events.ts:86-402」→ 現 `88-436`(A-2 が +34 行)。骨子「1 file に集約済」= **維持**(processSession は現も単一 file)。
2. **不変条件の数**: 骨子「6(冪等・orphan 排除・replay 順序・count mismatch 防御・JST 集計)」は列挙 5 + owner-scope で 6。**A-2 で selected_answer_ids 存在検証が 7 本目**として追加済(骨子後)。
3. **§4 発見#2(status ガード未実装)= 現 HEAD でも確定**(Step 3 で裏取り)。
4. **§4 発見#3(selected_answer_ids ⇄ options)= 半分は A-2 で解決済**(存在検証は closed / is_correct 再計算は未 = Step 4)。

**結論**: 骨子は spec 起草の入力として十分な深さ。追加調査は本 doc(Step 1-5)で完了。spec は「A-2 で③の存在検証が既に closed」を前提に③の残余(is_correct 再計算)の帰属だけを判断すればよい。

---

## Step 1: Session state の実態

### schema(3 点セット・物理確認は 2026-07-08 audit の実 DB information_schema を継承)

migration `0012` / `0013` が両 table を作成、**以降 alter なし**(`grep -l study_sessions drizzle/migrations/*.sql` = 0012/0013 のみ)。よって 2026-07-08 audit(`docs/audit/2026-07-08-server-invariant-verification.md`:133-137)の実 DB 確認が現 HEAD でも valid。

| table | 列 | 型 | 制約 |
|---|---|---|---|
| `study_sessions`(schema.ts:542-580) | session_id | uuid | **PK**(client uuidv4 採番) |
| | user_id | uuid | NOT NULL・FK users cascade |
| | exam_id | uuid | FK exams **set null** |
| | mode | text `'smart'\|'custom'` | NOT NULL |
| | card_ids | jsonb string[] | NOT NULL default `[]` |
| | started_at / completed_at | timestamptz | started NOT NULL / completed nullable |
| | **status** | text `'active'\|'completed'\|'abandoned'` | NOT NULL default `'active'`・**CHECK なし**(実 DB 確認済) |
| | created_at / updated_at | timestamptz | updated は `$onUpdate` |
| `answer_events`(schema.ts:588-627) | id | uuid | PK defaultRandom |
| | **event_id** | uuid | NOT NULL・**UNIQUE**(冪等の要) |
| | session_id | uuid | FK study_sessions **set null**(session 消えても event 残す) |
| | card_id / user_id | uuid | NOT NULL・FK cascade |
| | selected_answer_ids | jsonb string[] | NOT NULL default `[]` |
| | is_correct | boolean | NOT NULL |
| | answered_at | timestamptz | NOT NULL |
| | sync_status | text `'synced'` | NOT NULL(client の 4 値 SyncStatus を型で遮断) |

**public schema に trigger ゼロ**(実 DB 確認済)。status 遷移を DB で守る手段は存在しない。

### ingest-review-events.ts の現構造(processSession = 88-436)

**session status を書くのは processSession でなく route.ts の Phase 0**(構造の要点)。processSession は `session.status` を **一切読まない**(session_id を answer_events.sessionId に使うのみ)。骨子の 6+A-2=7 不変条件の現在地:

| # | 不変条件 | 現コード位置 |
|---|---|---|
| 1 | 冪等(event_id) | Phase 2a: `onConflictDoNothing({target: eventId})` + returning で実 insert のみ replay(204-236) |
| 2 | orphan 排除(所有 card SELECT) | Phase 1: owner-scoped SELECT + `!cardStateMap.has` → orphanFailed(110-186) |
| 3 | replay 順序 | Phase 2b/2c: payload 順 group 化 + `consumedSet` intra-payload dedup(225-274) |
| 4 | count mismatch 防御 | Phase 2e: RETURNING 件数 ≠ finalStates.size → throw → rollback(311-350) |
| 5 | JST 集計 | Phase 2f: `todayInJst` day group + `AT TIME ZONE 'Asia/Tokyo'` distinct(354-416) |
| 6 | owner-scope | 全 query に `eq(cards.userId, user.id)`(131, 334) |
| 7 | **selected_answer_ids 存在検証(A-2)** | Phase 1: `validOptionIds` Set 照合 → unknown → orphanFailed 同列(179-196) |

`deriveRating`(70-72)= `ev.rating ?? (ev.is_correct ? 3 : 1)` = FSRS rating を server が決める唯一箇所。**is_correct は payload 直用(server 再計算なし)** — Step 4。

**route.ts Phase 0(92-125)**: `studySessions` upsert。`setWhere: eq(userId)` で tenant 分離(C-1)/ conflict set = `completedAt` + `status` のみ(**card_ids は初回 insert のみ = I-1**)/ status は payload 値を**無条件上書き**(completed→active 巻き戻しも素通り)。Phase 0 失敗 = 503 + Retry-After(client retry と整合)。

---

## Step 2: client mirror(Dexie)の広さ ★F1 との最大の差分

**結論: session は client mirror を持つ(Subscription は mirror ゼロ)が、mirror は write-only の staging buffer で session ルールの二重実装はゼロ**。骨子「二重実装 低」を「二重実装ゼロ(rule)/ mirror は buffer plumbing のみ」に精緻化。

### 事実(file:line)

- **Dexie store 2 つ**: `study_sessions`(client-db.ts:116-127,224,248)/ `answer_events`(:132-144,225,249)。演習中の進捗(idx / tally / selectedIds / phase)は **React useState のみ**(session-runner.tsx:140-159)= 非永続。due card は既存 `cards` mirror の `[user_id+due]` index から読む(get-dexie-session-cards.ts:40-45)= 専用 store なし。
- **client→server 経路 = 専用 review-events path**(entity_mutations outbox とは**別系統**): buffer store → threshold/completion flush → `POST /api/review-events/bulk`。関数 = `recordAnswerEvent`(review-events.ts:122-138)/ `createStudySession`(:50-68)/ `completeStudySession`(:70-78)/ `abandonStudySession`(:80-87)/ `flushPendingEvents`(:249-361, 閾値 5)/ `flushAllPendingEvents`(:231-247)/ recovery flush = `createReviewFlushController`(review-flush-trigger.tsx + review-flush.ts, Web Locks + backoff, **429 即停止** review-flush.ts:209-211)。
- **pull-back 不在(= client が真実 source)**: `pullDelta`(pull.ts:116-300)の 6 stream = cards/exams/tombstones/tag_categories/tag_options/card_tags のみ。study_sessions / answer_events を Dexie へ書き戻す writer は**存在しない**(pull-back.ts も cards / study_days のみ)。schema コメント(schema.ts:539)「client が真実 source」と整合。
- **ルール二重実装ゼロ**: FSRS replay(`replayCard` は server ingest だけが import)/ 冪等 / orphan / A-2 存在検証 / JST 集計 いずれも client 側実装なし。client の status 遷移は**リテラル値の直書き**(completeStudySession が `status:'completed'` を put するだけ・遷移ガードなし)。client が唯一 *計算* するのは per-card 正誤(`equalSet` → is_correct)と normal mode の rating shortcut(正→3/誤→1)= **生 event field であって session ルールではない**(server が deriveRating で独立に権威を持つ)。
- **client repository なし**(N-5 と整合): `lib/sync/review-events.ts` の free function 群 + Dexie 直操作(mirror+outbox+flush = application transaction)。`runOptimistic*` も不使用(optimistic は runner の React state で inline)。

### N-5 の維持判断材料

session の client 面は「buffer plumbing のみ・ルール不在」ゆえ **N-5(client repository 新設しない)は F2 でも維持が正**。F1 の推奨(client = 純粋関数 + 既存 outbox)がそのまま当てはまる。**F2 の client 伝搬面 = wire payload shape(review-events.ts:294-315)と 2 Dexie store shape を変えない限りゼロ**。

---

## Step 3: ②completed 後 append 許否 = **唯一の挙動変更候補・設計判断が先**

### ガード不在 = 現 HEAD で確定

- DB: status に CHECK なし・trigger ゼロ(Step 1)。
- route Phase 0: `set.status = session.status` を**無条件上書き**(route.ts:123)= completed→active 巻き戻しも通す。
- processSession: session.status を読まない = completed session への answer_event append を拒む分岐なし。

### 正当な遅延 flush と不正 append の区別 = 設計論点の核

**正当ケースが同経路を通る**(A-2 の「正当操作を弾かない」と同型の設計制約):

- local-first ゆえ「オフライン完了 → online 復帰で pending event を flush」は設計上正当。recovery flush(review-flush-trigger.tsx の mount/visibility/online 契機)が completed session に event を POST する = 「completed への append」そのもの。
- 正常 client では不発(session-runner.tsx:315-328: `phase='finished'` 後は event 生成経路なし・completeStudySession → flush の順序固定)。実害は破損 client / 複タブ race(同 origin IDB 共有)のみ。不整合の質 = 過去日付 study_days 積み増し / completed 後 cards FSRS 上書き / streak 歪み = **全て自分のデータ内**(他者・課金 波及ゼロ)。

### 設計選択肢(spec で OT 確定)

audit ②(:47)の 3 案を現状で再掲:
- (a) `completed_at` + 猶予窓(例 24h)超の event を failed 分離 — 遅延 flush と破損を**時間で区別**。
- (b) status 巻き戻し(completed→active)のみ拒否 — event append 自体は許し、状態後退だけ止める。
- (c) server guard を置かず検知 log + 監視のみ。

**controller 所感**: (b) が最小侵襲かつ「正当な遅延 flush(status は completed のまま event を積む)を壊さず、状態後退という明確な不正だけを止める」= A-2 の設計思想と一貫。(a) は猶予窓という magic number を仕様に持ち込む(YAGNI 抵触の懸念)。ただし (b) は「completed session に *新規* event を無限に積める」問題は残す — そこは event_id 冪等 + orphan/A-2 で既に大半吸収され、実害は上記の狭い race のみ。**F2 spec の主判断点 #1**。

---

## Step 4: ③is_correct / selected_answer_ids = **F2/F3 の線引き**

③は 2 分割される。**存在検証(③a)は A-2 で既に closed / is_correct 再計算(③b)が残余**:

- **③a 存在検証(closed・A-2 `82f17fc`)**: selected_answer_ids の全 id が対象 card の options に実在するか照合(ingest:179-196)。unknown → orphanFailed。malformed options は element 単位で握り潰し(fail-closed・159-175)。**F2 で追加不要**。
- **③b is_correct server 再計算(未・F3 候補)**: `deriveRating`(:70-72)は `ev.is_correct` を直用。**is_correct を server で再計算(selected_answer_ids ⇄ card.correctAnswerIds 照合)する**と `deriveRating` の入力が変わり、`reviews.rating` / `study_days.correct_count` の導出が変化 = **契約変更**。

### deriveRating 契約(P0 で凍結・再計算は F3 帰属の根拠)

P0 baseline `docs/audit/2026-07-06-p0-contract-baseline.md` §A #7 + §A 注記 2:
- `deriveRating` = **FSRS rating(想起できた = rating>=2)と MCQ is_correct は別概念**という**意図的乖離**を体現。`correct_count = rating>=2`(is_correct でない)。明示 rating 提供時のみ is_correct と乖離、fallback 時は一致。
- **P0 golden が凍結対象**(rating=3 + is_correct=false → correct_count=1 を必須 golden 化)。

よって **is_correct の server 再計算は deriveRating 契約 = D-2 凍結契約に触れる可能性** → 骨子 §5 の分類どおり **F3(挙動変更・凍結契約との関係を spec で整理)に残すのが正**。F2 は純粋 refactor + ②status ガードに集中し、③b は踏まない。

（注: selectedAnswerIdsSchema は今も `z.array(z.string().min(1)).max(50)`(review-session-bounds.ts:11)= uuid 化未 = Phase 4 帰属の既知残債。A-2 は schema を締めずに ingest runtime で存在照合する形で③a を解決した。)

---

## Step 5: 既存 test 網 + golden

**専用 ingest test なし** — processSession は HTTP route 経由でのみ検証。2 file が 7 不変条件を pin:
- `app/api/review-events/bulk/route.test.ts`(30 `it`・挙動 hard assert 本体)
- `tests/contract/review-events-bulk.contract.test.ts`(12 `it`・wire snapshot + 一部 hard assert)。共有 fixture = `tests/fixtures/review-events.ts`。

### 不変条件 × test マトリクス

| # | 不変条件 | pin(file:line) | 強度 |
|---|---|---|---|
| 1 | 冪等 | route:699(cross-payload dup→FSRS skip), route:912(intra-payload consumedSet reps=1), contract:326 | 強(二重) |
| 2 | orphan 排除 | route:794, contract:351 | 強。ただし `WHERE user_id` 自体は mock が where 無視で **未 assert**(other-user card は構成上のみ) |
| 3 | replay 順序 | route:848, route:993, **route:1057(array 順 ≠ answered_at sort の明示 guard)**; 単体 replay-card.test:45/83 | 強(二重) |
| 4 | count mismatch | route:1102(RETURNING 不足→throw→failed), route:835, contract:545 | 強 |
| 5 | JST 集計 | route:944/1147/1183/1230/1286, contract:235/276 | 強 |
| 6 | selected_answer_ids(A-2) | contract:388-541(5 test: a/b/c/d/e) | 強・**contract のみ単一 cover**(route には it 追加なし) |
| 7 | **session status upsert(Phase 0)** | route:576/758/786, contract:235(cardIdsPresent:false / setWhereDefined:true / conflictSet.status) | **shape は凍結・挙動は未** |

### A-2(82f17fc)が足した test と重複

5 test 全て contract file(388-541): (a)全 id 実在→applied /(b)混在 unknown→当該のみ failed(per-event 分離)/(c)別 card の id→failed(cross-card)/(d)multi-select 両実在→applied /(e)malformed options→当該のみ failed・健全 card 巻き添えなし(fail-closed guard、ingest:159-175 を pin)。route.test には `options:[a,b]` default 追加のみ(it 追加なし)。**orphan test と語彙は並行だが trigger が別(valid card + invalid option)ゆえ非重複**。(e)は他に analog なし。

### F2 golden 先張りで足すべきもの(★核心 gap)

- **session status 遷移 = 全く pin されていない(確定)**。「completed→active 巻き戻し」「completed 後の新規 append」の現挙動(= 許容)を intentional として固定する golden も、将来ガードの golden も**ゼロ**。Phase 0 が status を無条件上書きする現挙動は誰も観測していない。→ **F2 の golden 先張りはここを最初に特性化**(現挙動固定 or ②選択肢の期待値)。
- I-1(card_ids 保持)/ C-1(tenant setWhere no-op)/ orphan の `user_id` where は **shape のみ**で挙動未特性化(mock が ON CONFLICT merge / setWhere / where を模さない)。F2 が Phase 0 を aggregate 化するなら behavioral golden が要る。
- Phase 0 `permanent-4xx`→400 分岐(route.ts:140)は無 test(minor)。

**不変条件 1/3/4/5/6 は強く二重に pin 済 = refactor 背後で安全**。**7 の *挙動*(status 遷移含む)だけが未特性化** = F2 golden 先張りの主対象。

---

## 所感(claude.ai + OT へ)

### 1. F1 との blast radius 差分(client mirror 面)

| 観点 | F1 Subscription | F2 Session |
|---|---|---|
| client mirror | **ゼロ**(server-only) | **あり**(2 Dexie store)だが write-only buffer・ルール二重実装ゼロ |
| server rule 集約 | handle-stripe-event 等 | **2 file**(ingest = 全不変条件 / route Phase 0 = session 行 upsert) |
| refactor 波及 | server のみ | **server 2 file で完結**(client は wire/store shape 不変なら無変更) |

→ **F2 の client 面は F1 より広く見えるが「触らなくてよい」広さ**。ルールが server-only なので F1 と同じく「純粋 refactor は server 2 file に閉じる」。ただし **aggregate 境界が 2 file に跨る**(F1 は projection use-case 1 本に集約できた)点が構造上の差。Session aggregate が status 遷移を持つなら route Phase 0 と processSession の両書込点を aggregate 経由に配線する設計判断が要る。

### 2. ②status ガードの設計論点(F2 の唯一の挙動変更候補)

ガード不在は確定。単純「completed なら拒否」は正当な遅延 flush を壊す。案 (a)時間窓 /(b)状態後退のみ拒否 /(c)検知のみ。controller 推奨 = **(b)**(最小侵襲・A-2 の設計思想と一貫・magic number 不要)。ただし F1 の W(挙動変更隔離 commit)と同様、**別 commit + 専用 test + OT 実機**扱いになる。**主判断点 #1**。

### 3. ③の F2/F3 線引き所感

③a(存在検証)は A-2 で closed。③b(is_correct 再計算)は deriveRating = P0 凍結契約に触れるため **F3 に残すのが正**(骨子 §5 分類を支持)。F2 は「純粋 refactor(golden 更新ゼロ)+ ②status ガード(隔離 commit)」に scope を絞れる。**主判断点 #2**。

### 4. F2 が F1 型を踏襲できるか

できる。golden 先張り(status 遷移特性化が主対象)→ 純粋 refactor(不変条件 1/3/4/5/6 は既存 test が回帰の正)→ ②を隔離 commit。VO 候補は F1 より薄い(SessionStatus enum / SelectedAnswerIds くらい・rule of three 未達なら VO 化しない)。repository は server-only 単一〜2 table で薄い。

---

## F2 spec の主判断点(先取り・OT / claude.ai へ)

1. **②status ガードの方式**: (a)時間窓 /(b)状態後退のみ拒否(controller 推奨)/(c)検知のみ。→ F2 の隔離 commit で埋めるか、F2 は純粋 refactor のみとし②を別 fix に切るか。
2. **③b(is_correct 再計算)の帰属**: F3 に残す(controller 推奨・P0 契約根拠)で確定してよいか。
3. **aggregate 境界**: Session aggregate は route Phase 0(session 行)+ processSession(event/replay/read model)の 2 書込点を跨ぐ。両方を aggregate 経由に寄せるか、processSession のみ aggregate 化し Phase 0 は薄い upsert のまま残すか。
4. **VO / repository の深さ**: F1 の「型の基準回」を踏襲しつつ、Session は VO 候補が薄い。YAGNI で最小に留める線を spec で確定。
5. **golden 先張りの範囲**: status 遷移特性化(現挙動固定 or ②期待値)を先張りの筆頭に。I-1/C-1/orphan-where の behavioral golden をどこまで足すか。

---

## 参照

- 意図 doc: `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`(§3-4 F2 骨子 / §5 フェーズ骨子)
- 裏取り: `docs/audit/2026-07-08-server-invariant-verification.md`(②③の初出判定・実 DB 物理確認)
- F1 型: `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md`(aggregate/VO/repository/phase G-R-W 型)/ `docs/audit/2026-07-08-f1-subscription-factfinding.md`(本 doc の構造 template)
- 契約: `docs/audit/2026-07-06-p0-contract-baseline.md` §A #7 + 注記 2(deriveRating = intentional・③b の F3 根拠)
- 既知残債: `docs/audit/2026-06-12-repo-wide-audit.md §8`(selected_answer_ids uuid 化)/ `lib/validation/review-session-bounds.ts:8-10`
- 中核コード: `lib/reviews/ingest-review-events.ts`(88-436)/ `app/api/review-events/bulk/route.ts`(Phase 0: 92-125)/ `lib/db/schema.ts:542-627` / client: `lib/sync/review-events.ts` / `lib/client-db.ts:116-144` / `lib/sync/pull.ts`(session 非 pull)
