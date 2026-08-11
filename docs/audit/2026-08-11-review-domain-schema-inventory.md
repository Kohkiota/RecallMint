# 復習ドメイン schema 全量棚卸し — fact-finding 第 2 弾(2026-08-11)

- 目的: 復習ドメインの表構造再設計の材料。現物の全量と歪みの網羅。
- 方法: repo 現物のみ(schema.ts / 適用済み migration snapshot / 全書き手・読み手 grep)。実装なし。
- 前提: `docs/audit/2026-08-11-fsrs-consistency-factfinding.md`(第 1 弾)は既知。重複は最小限にし、参照で示す。
- 実 DB(stg/prod)の行数・実データは**未確認**(migration は `_journal.json` 34 本・最終 `0033_asset_gc_user_ids` まで生成済み。stg/prod への適用状態そのものは repo からは読めない — 未確認)。

> **訂正(2026-08-11・Sprint A T2 実装中に発覚)**: 本 doc の **§2.8 と §6-12 が主張する「streak 計算の二重実装」は偽**。実際には `lib/streak-core.ts` が既に存在し(commit `c79b1af`「computeStreak+addDays を lib/streak-core.ts へ hoist(P1 Task2)」)、server(`lib/db/streak.ts:3`)・client(`lib/client/streak.ts:16`)の**両方がそこから import している = 既に 1 定義**だった。
> 誤りの原因: `dashboard-stats.tsx:12-14` の「server 版と同仕様で port した」という**コメントだけを根拠に判定し、実際の import 文を確認しなかった**(コメントが hoist 前のまま stale だった)。本 doc 自身が §8-5 で「comment を信じると現物を誤読する」と指摘しておきながら同じ罠を踏んだ形。
> **帰結**: spec §7.2 の「二重実装の解消」は不要作業と判明し、Sprint A から除外(spec 側も amend 済み)。§2.8 の表の該当行・§6-12 は**無効**として読むこと。なお同 §2.8 の「JST 日付バケツ(JS `todayInJst` vs SQL `AT TIME ZONE`)の 2 実装」は現物確認済みで**有効**(Sprint A で解消対象のまま)。

---

## 1. 対象表の現物 schema 全量

出典: `lib/db/schema.ts` と `drizzle/migrations/meta/0033_snapshot.json`(累積適用状態)を突合。**5 表とも schema.ts と snapshot に乖離なし**(cards は 0000 で `custom_props`/`tags` を持っていたが 0020 で DROP 済み・schema.ts と一致。study_days は 0009 で `distinct_card_count` 追加、study_sessions は 0013 で `updated_at` 追加、いずれも一致)。

### 1.1 answer_events(0012 新設)

| 列 | 型 | NULL | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| event_id | uuid | NOT NULL | — |
| session_id | uuid | NULL | — |
| card_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| selected_answer_ids | jsonb | NOT NULL | `'[]'` |
| is_correct | boolean | NOT NULL | — |
| answered_at | timestamptz | NOT NULL | — |
| elapsed_ms | integer | NULL | — |
| sync_status | text | NOT NULL | `'synced'` |
| created_at | timestamptz | NOT NULL | `now()` |

- PK = `id` / UNIQUE = `event_id` / CHECK = **なし**
- FK: `session_id → study_sessions.session_id` **SET NULL** / `card_id → cards.id` **CASCADE** / `user_id → users.id` **CASCADE**
- index: `(user_id, answered_at)` / `(card_id, answered_at)` / `(session_id)`

### 1.2 reviews(0000 からある最古参)

| 列 | 型 | NULL | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| card_id | uuid | NOT NULL | — |
| rating | integer | NOT NULL | —(TS 側 `$type<1|2|3|4>` のみ・**DB CHECK なし**) |
| reviewed_at | timestamptz | NOT NULL | **`now()`** |

- PK = `id` / UNIQUE = **なし** / CHECK = なし
- FK: `user_id → users` CASCADE / `card_id → cards` CASCADE
- index: `(user_id, reviewed_at)` / `(card_id, reviewed_at)`
- 注: `reviewed_at` の `defaultNow()` は現実装では常に明示値で上書きされ**未使用**。default が発火すると第 1 弾 §1.4 の「reviewed_at == answered_at」対応が黙って壊れる罠(§6-13)。

### 1.3 cards(FSRS 関連列のみ・全 28 列中)

| 列 | 型 | NULL | default | 分類 |
|---|---|---|---|---|
| answered | boolean | NOT NULL | false | 非正規化統計 |
| last_correct | boolean | NULL | — | 非正規化統計 |
| current_streak | integer | NOT NULL | 0 | 非正規化統計 |
| due | timestamptz | NOT NULL | `now()` | FSRS |
| stability | **real** | NOT NULL | 0 | FSRS |
| difficulty | **real** | NOT NULL | 0 | FSRS |
| elapsed_days | integer | NOT NULL | 0 | FSRS |
| scheduled_days | integer | NOT NULL | 0 | FSRS |
| reps | integer | NOT NULL | 0 | FSRS |
| lapses | integer | NOT NULL | 0 | FSRS |
| state | integer | NOT NULL | 0(TS `$type<0|1|2|3>`・CHECK なし) | FSRS |
| learning_steps | integer | NOT NULL | 0 | FSRS |
| last_review | timestamptz | NULL | — | FSRS |

- FSRS 関連 index: `cards_due_idx (user_id, due)` / `cards_answered_idx (user_id, exam_id, answered)`
- FK: `user_id → users` CASCADE / `exam_id → exams` CASCADE / `source_document_id → source_documents` SET NULL

### 1.4 study_sessions(0012 新設 + 0013 で updated_at)

| 列 | 型 | NULL | default |
|---|---|---|---|
| session_id | uuid | NOT NULL(PK・**client 採番**) | — |
| user_id | uuid | NOT NULL | — |
| exam_id | uuid | NULL | — |
| mode | text | NOT NULL(TS `'smart'|'custom'`・CHECK なし) | — |
| card_ids | jsonb | NOT NULL | `'[]'` |
| query | jsonb | NULL | — |
| started_at | timestamptz | NOT NULL | — |
| completed_at | timestamptz | NULL | — |
| status | text | NOT NULL(TS `'active'|'completed'|'abandoned'`・CHECK なし) | `'active'` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()`(drizzle `$onUpdate`) |

- FK: `user_id → users` CASCADE / `exam_id → exams` **SET NULL**
- index: `(user_id, started_at)` / `(exam_id)`

### 1.5 study_days(0000 + 0009)

| 列 | 型 | NULL | default |
|---|---|---|---|
| user_id | uuid | NOT NULL | — |
| day | date(`mode:'string'`) | NOT NULL | — |
| review_count | integer | NOT NULL | 0 |
| correct_count | integer | NOT NULL | 0 |
| distinct_card_count | integer | NOT NULL | 0 |

- PK = 複合 `(user_id, day)` / FK: `user_id → users` CASCADE / index 追加なし / CHECK なし(負数可)
- `created_at` / `updated_at` が**無い**唯一の対象表(→ 増分 cursor 不能・pull は 90 日 full-window。§4)

### 1.6 FK で繋がる外周表(概要のみ)

- **users**(`schema.ts:80-142`): PK id uuid。soft delete(`deleted_at`)+ PII scrub 方式。復習ドメイン 5 表すべての user_id cascade 先。
- **exams**(`schema.ts:254-291`): PK id。`card_count`(非正規化)/ `content_version` / `updated_at`。cards の cascade 親、study_sessions の SET NULL 親。
- **source_documents**: cards.source_document_id の SET NULL 親(復習動作に非関与)。
- 対象表を FK 参照する側: `card_asset_refs.card_id → cards` CASCADE / `card_tags.card_id → cards` CASCADE(復習ドメイン外だが card 削除連鎖に参加)。**reviews / answer_events / study_sessions / study_days を参照する表は無い**(全て leaf)。

### 1.7 制約の欠落(全表共通)

CHECK 制約は対象 5 表に **1 つも無い**(snapshot の `checkConstraints: {}`)。rating 1-4 / state 0-3 / mode / status / count 非負はすべて TS の `$type` narrow か zod のみ(DB レベル無防備)。

---

## 2. 各列の書き手と読み手

凡例: 【死】= どこからも読まれない(production コード)。

### 2.1 answer_events(server)

| 列 | 書き手 | 読み手 |
|---|---|---|
| 全列 | `insertAnswerEvents`(`lib/reviews/session-repository.ts:90-101`・唯一の書込)| **production で SELECT する箇所ゼロ**。読むのは RLS 検証(`scripts/verify-rls-state.ts:77`)と iso/route test のみ |
| event_id | 同上 | INSERT の `RETURNING`(replay gating)にのみ使用 — 挿入 tx 内で完結 |
| sync_status | default `'synced'` 固定 | 【死】書き手も default のみ・値は 1 種 |
| elapsed_ms | **常に NULL**(client が送らない・第 1 弾 §1.1)| 【死】 |
| session_id / selected_answer_ids / is_correct / answered_at / created_at / id | insert のみ | 【死】(挿入後に読む経路なし) |

→ **server answer_events は表ごと write-only**。「生ログを保持する」(schema.ts:607)という宣言のみが読み手。

### 2.2 answer_events(client Dexie `answer_events`)

| 列 | 書き手 | 読み手 |
|---|---|---|
| 全列 | `recordAnswerEvent`(`lib/sync/review-events.ts:122-138`。唯一の呼出元 = `session-runner.tsx:291`)| flush 経路のみ(`getPendingAnswerEvents` → POST payload) |
| sync_status | record 時 `'pending'` / flush 成功 `'synced'` / 24h drop `'failed'` | `where('sync_status').equals('pending')`(flush 対象選別)。**UI 読み手なし** |
| rating | record 時に**常に**明示値(runSubmit は通常/FSRS 両モードで rating を渡す・`session-runner.tsx:253,290-296`)| flush payload に載せる。server の `deriveRating` fallback(`rating ?? is_correct→3/1`)は現 client では**防御専用**(常に明示値が来る) |
| last_attempted_at | flush 試行ごと打刻(`markAnswerEventsAttempted`)| 【死】(第 1 弾 §4.3 で確認済) |
| elapsed_ms | **書かれない**(caller が渡さない)| 【死】両側で死 |
| local_id | Dexie 採番 | 内部 auto-key のみ |

### 2.3 reviews(server)

| 列 | 書き手 | 読み手 |
|---|---|---|
| 全列 | `insertReviews`(`session-repository.ts:115-120`・唯一)。旧 `submitReview` server action は撤去済(test コメント `session-runner.test.tsx:55` が撤去を明言)| **唯一の読み手 = `upsertStudyDays` の distinct 再集計 SELECT**(`session-repository.ts:221-228`。`COUNT(DISTINCT card_id)` に card_id / reviewed_at / user_id を使用) |
| rating | 同上 | 【死】(distinct SELECT は rating を読まない。= **rating の唯一の永続先なのに、書いた後 1 箇所からも読まれない**) |
| id | DB 採番 | 【死】 |

→ reviews は「distinct_card_count の導出材料」としてのみ生きており、**rating 履歴としては write-only**。

### 2.4 cards(FSRS 関連列)

| 列 | 書き手 | 読み手 |
|---|---|---|
| FSRS 10 列 + 統計 3 列(全 13 列) | ① `applyCardFinalStates`(唯一の更新経路・絶対値上書き)② card create 時の DB default(server `applyCardCreateWithId` は FSRS 列を insert に含めず default 依存・`apply-card-mutation.ts:90-105`。client optimistic は `build-new-client-card.ts:50-58` で同値をローカル生成) | 下記 |
| due | 上記 | server: `getSessionCards`(smart 選定 `lte(cards.due, threshold)` + `orderBy(asc(due))`・`get-session-cards.ts:31-32`)/ client: dashboard dueCount(`[user_id+due]` range count・`dashboard-actions.tsx:45-52`)+ `get-dexie-session-cards`(due 到来分 fetch) |
| answered | 上記 | client: 回答状態フィルタ(`card-filter-predicates.ts:54-66` unanswered 判定。custom session + exam 詳細テーブル AS-1 フィルタ)。server 側読み手は**見つからず**(`cards_answered_idx` を使う server query は未発見 — 未確認) |
| last_correct | 上記 | client: 同フィルタ(correct/incorrect 判定)+ exam テーブル列表示(`exam-card-table-columns.tsx:346-366`) |
| current_streak | 上記 | client: streak フィルタ(`matchesStreakFilter`)+ exam テーブル列表示(:370-376) |
| last_review | 上記 | client: exam テーブル列表示(:383-389)+ replay 入力 |
| stability / difficulty / elapsed_days / scheduled_days / reps / lapses / state / learning_steps | 上記 | **replay 入力(`loadCardReplayStates`)のみ**。UI・集計・判定に読み手ゼロ(FSRS 内部状態としてのみ意味を持つ) |

### 2.5 study_sessions(server)

| 列 | 書き手 | 読み手 |
|---|---|---|
| 全列 | `upsertSessionGuarded`(insert + status/completed_at のみ conflict 更新)| **production の SELECT ゼロ**(第 1 弾 §1.6。書込 = upsert / 削除 = 退会 handler のみ) |
| query | **書かれない**(bulk payload の sessionSchema に query が無い・`ingest-review-events.ts:37-45`。flush payload にも無い・`review-events.ts:294-303`)| 【死】**書き手も読み手も無い完全な死列** |
| mode / card_ids / started_at / exam_id | insert 時のみ | 【死】 |
| status / completed_at | upsert(遷移ガード付き) | 【死】(ガード述語自身が読む以外ゼロ) |
| updated_at | `$onUpdate` | 【死】(「差分同期の基準」と宣言(schema.ts:591-597)されているが study_sessions は pull stream に無く、cursor として使われたことがない) |

### 2.6 study_sessions(client Dexie)

| 列 | 書き手 | 読み手 |
|---|---|---|
| 全列 | `createStudySession`(唯一の呼出元 = `session-launcher.tsx:56`)/ `completeStudySession`(session-runner 完了時)/ `markStudySessionSyncStatus` | `getStudySession`(flush が payload を組むためだけに読む・`review-events.ts:253`)。**UI 読み手なし** |
| query | **書かれない**(SessionLauncher が渡さない。`CreateStudySessionInput.query` を埋める caller ゼロ)| 【死】client 側も両死 |
| status='abandoned' | **到達不能**。`abandonStudySession`(`review-events.ts:80-87`)は export されているが**呼び出し元ゼロ**(grep: production 0 件)| — |

### 2.7 study_days(server + client)

| 列 | 書き手 | 読み手 |
|---|---|---|
| review_count | `upsertStudyDays` の `+` 加算 | server: streak 算出の `review_count > 0` フィルタ(`streak.ts:47-52`)/ client: 同 port(`lib/client/streak.ts:48`)。**カウント値そのものはどちらも読まない**(> 0 の真偽のみ) |
| correct_count | 同 `+` 加算 | 【死】**server / client どちらにも読み手が無い**(streak にも todayCount にも不使用。dashboard-stats は streak と distinct のみ) |
| distinct_card_count | reviews 再 SELECT で**上書き** | server: `getReviewStatsForUser` の todayCardCount(`streak.ts:36-40`)/ client: `getStreakStatsFromDexie`(:45-46) |
| day / user_id | upsert キー | 両側の streak window フィルタ |

### 2.8 同じ意味の値を複数表に持つ列(重複・非正規化)と同期機構

| 値 | 保持箇所(重複) | 同期機構 |
|---|---|---|
| 「回答した / 正解した」 | ① `answer_events.is_correct` ② `reviews.rating`(>=2 = correct)③ `cards.answered/last_correct/current_streak` ④ `study_days.correct_count` ⑤ client の session tally(`session-runner.tsx` の React state・揮発) | **単方向の同一 tx 導出のみ**(①→②③④ は processSession が 1 tx で書く)。事後の再導出・整合検査は無い。⑤ は独立実装(「触ったら 1 枚」の意味論で server とズレることを自認・session-runner.tsx:272-275) |
| 「その日に復習した card 数」 | `study_days.distinct_card_count` と(導出元)`reviews` | flush のたびに reviews から再 SELECT で上書き(片方向・遅延なし)。ただし card 削除で reviews が消えても study_days は**再計算されない**(次に同じ day へ flush があった時だけ縮む・§6-6) |
| 「streak / todayCount」 | server `lib/db/streak.ts` と client `lib/client/streak.ts` | **意図的 port(二重実装)**。`computeStreak` を「同仕様で port した」とコメント宣言(dashboard-stats.tsx:12-14)— CLAUDE.md「共有 invariant は pure 関数 1 定義を両側 import」の**明示的逸脱**(§6-12) |
| 「JST の日付バケツ」 | JS `todayInJst`(`lib/jst.ts`)と SQL `AT TIME ZONE 'Asia/Tokyo'`(`session-repository.ts:222-227` / 旧 streak SQL) | 無し。2 実装の一致は検証されていない(DST の無い JST では実質一致するが、機構ではなく偶然) |
| 「card 母集団」 | `study_sessions.card_ids`(snapshot)と cards 表そのもの | 無し(card_ids は insert-only の凍結 snapshot・I-1) |

### 2.9 慣習(値の一致)でしか対応が取れていない表間関係

- `reviews.reviewed_at == answer_events.answered_at`(第 1 弾 §1.4。UNIQUE なし・機械保証なし)
- `reviews` 行 ↔ `answer_events` 行の 1:1(同一 tx で書くという実装慣習のみ。FK・制約なし)
- `study_days.day == todayInJst(answered_at)`(導出関係が書込時にしか成立せず、事後検証手段なし)
- `study_sessions.card_ids ⊇ answer_events.card_id`(検証されない。card_ids に無い card への event も ingest は受け付ける — `admitEvents` は card の実在と option 実在のみ検査)

---

## 3. 表の意味論の実態

### 3.1 answer_events と reviews の行数関係

**現行コードの実行結果としては applied event について厳密 1:1**(同一 tx・`insertedEventIds` gating。第 1 弾 §1.3)。1:1 が崩れる経路:

1. **歴史的非対称(構造上確実)**: `reviews` は migration 0000 から存在し、旧 `submitReview` server action(撤去済・`session-runner.test.tsx:55` に撤去記録)が answer_events 無しで reviews を書いていた。**0012(answer_events 新設)以前の reviews 行には対応 event が無い**。stg/prod にその行が実在するかは未確認。
2. **reviews のみ削除・answer_events のみ削除の経路は無い**(両方 card_id CASCADE で運命共同体)。
3. **将来の gate 導入(sprint ③)で意図的に非 1:1 になる**(適用外 event も reviews に記録する案)— その時「適用フラグ」が無い問題が §6-2。

### 3.2 study_sessions の役割の実態

- **何の単位か**: 「SessionLauncher の 1 mount」(`session-launcher.tsx:46-72`・mount 時に uuidv4 採番、props 変化でも再生成しない)。smart / custom 両方が同経路。
- **無いと困る読み手**:
  - client flush の **payload 組み立て**(`flushPendingEvents` が `getStudySession` で session メタを読む。session 行が Dexie に無いと `attempted: 0` で何も送らない・`review-events.ts:253-263` → **answer_events が孤児化して永久 pending** になる唯一の依存)
  - server 側 `answer_events.session_id` の FK 先(参照整合のためだけ)
  - **それ以外に読み手なし**(UI・集計・判定すべてゼロ)
- つまり現状の study_sessions は「flush の transport 単位 + 将来のための行動ログ」であり、**アプリ機能はこの表が無くても(flush の wire を変えれば)成立する**。
- 補: `status` の 3 値のうち `'abandoned'` は到達不能(§2.6)、`'completed'` は 5 の倍数 session で届かない(第 1 弾 §1.6)。server の status 値は「active か、たまたま届いた completed」の 2 値が実態。

### 3.3 study_days の導出の全量(非対称の全体像)

| 列 | 導出元 | 演算 | 冪等性の根拠 |
|---|---|---|---|
| review_count | 今回 flush で apply した event(`aggregateStudyDays(eventsToApply)`・day = `todayInJst(answered_at)`) | `+` 加算(ON CONFLICT DO UPDATE) | event 単位の insert gating(重複 event は eventsToApply に入らない) |
| correct_count | 同上(`deriveRating(ev) >= 2`) | `+` 加算 | 同上 |
| distinct_card_count | **reviews 表の実体**(同 tx 内 SELECT・day = `reviewed_at AT TIME ZONE 'Asia/Tokyo'`) | **上書き** | 再計算ゆえ常に冪等 |

- 加算 2 列は「イベント由来・過去の総和(削除で減らない)」、上書き 1 列は「reviews 実体のその時点断面(削除で将来縮む)」— **保持意味論が 1 表の中で分裂している**。
- day の導出も 2 系統(JS `todayInJst` vs SQL `AT TIME ZONE`)で、値の一致は暗黙(§2.8)。
- schema.ts:483 の設計宣言「reviews と独立で持つことで cards 削除の影響を受けない(§2.5.4)」は**加算 2 列にのみ真**。distinct_card_count は reviews 依存のため cards 削除の影響を(次回 flush 時に)受ける。

### 3.4 cards の FSRS 列以外で復習結果から更新される列

`applyCardFinalStates` の SET 句(`session-repository.ts:155-171`)が全量:

- **answered**: fold 中 1 event でも適用されれば `true` 固定(`replay-card.ts:104`)。false へ戻る経路なし(card 再作成のみ)。
- **last_correct**: 最後に適用された event の `rating >= 2`(Again のみ false)。**client の is_correct(選択肢一致判定)ではなく rating 由来** — FSRS モードで「正解したが Again を押した」場合、`answer_events.is_correct=true` / `cards.last_correct=false` に**分裂する**(定義が 2 つある)。
- **current_streak**: correct(rating>=2)で +1、不正解で 0 リセット(`replay-card.ts:106`)。
- **updated_at**: `now()`(DB クロック)— pull cursor を進める副作用(FSRS 更新だけで card 全体が次回 pull に載る)。
- **content_version は bump しない**(復習は「内容」を変えないという区別は保たれている)。

---

## 4. Dexie mirror との対応

| server 表 | client 対応物 | pull | 方向 | 列差分 |
|---|---|---|---|---|
| cards | `cards` store(ClientCard) | **載る**(6 stream の 1)| server→client(FSRS 値は flush 後 pullBack で還流) | client のみ: `sync_status`(mirror 上ほぼ 'synced' 固定・optimistic create 時のみ 'pending')。他は 1:1 対応(`cards-mapper.ts` 全単射) |
| study_sessions | `study_sessions` store | **載らない** | client→server 片方向 push のみ | client のみ: `sync_status`。**client に `user_id` が無い**(server のみ)。`query` は両側にあるが両側とも死。`created_at` は server のみ |
| answer_events | `answer_events` store | **載らない** | client→server 片方向 push のみ | client のみ: `local_id` / `rating` / `sync_status`(4 値)/ `last_attempted_at`。**client に `user_id` が無い**。server のみ: `id` / `user_id` / `sync_status('synced' 固定・同名別物)` / `created_at`。**rating は client にしか無く、server では reviews に転写されて event との紐付けを失う** |
| reviews | **client 対応物なし** | 載らない | server 専用 | — |
| study_days | `study_days` store | **専用 endpoint**(`/api/study-days/pull`・90 日 full-window replace、増分ではない) | server→client | 列は 5 列とも 1:1。client 側は `clear()` → `bulkPut`(唯一の全置換 pull・`lib/sync/study-days.ts:70`) |

**client にしか無い状態**: 未 flush の pending event(server はその存在を知らない)/ failed 隔離 event(24h drop 後・server に永久に届かない)/ session の `query` 値(書かれれば。現状は書かれない)/ event の `rating`(flush 前)/ session tally(React state・揮発)。

**server にしか無い状態**: `reviews` 全体 / `answer_events` の受領記録(client は synced フラグしか持たず、他デバイスの event は見えない)/ 他デバイスで作られた study_sessions / `user_id` 帰属。

**tenant スコープの非対称(重要)**: Dexie の他表(cards / exams / study_days / media_assets / tag_*)はすべて `user_id` 列 + owner-scope query を持つが、**`study_sessions` と `answer_events`(と entity_mutations)には user_id が無い**(`client-db.ts:146-192`)。`getPendingAnswerEvents` は sync_status のみで絞る(`review-events.ts:143-146`)ため、同一ブラウザでアカウントを切り替えると**前 user の pending event が現 user の Clerk 認証で POST される**。server は card 所有権不一致で orphan reject(failed[])するので書込は守られるが、client では該当 event が pending のまま残り、24h drop まで毎 flush 再送される。

---

## 5. 寿命と掃除

### 5.1 退会 scrub での扱い(`lib/clerk/handle-clerk-event.ts:211-300`)

| 表 | 扱い |
|---|---|
| study_sessions / study_days | **Group I: handler 明示 DELETE**(:272,275) |
| reviews / answer_events | **Group II: exams 明示 DELETE → cards CASCADE で連鎖**(:236 に宣言。answer_events.user_id CASCADE は users が soft delete のため発火せず、実経路は cards 経由) |
| cards | Group II(exams CASCADE) |
| users | soft delete + PII scrub(行残置) |
| **client Dexie 側** | **退会時に何も消えない**(Dexie を掃除する退会経路なし。端末に answer_events / study_sessions / cards mirror が残置) |

### 5.2 FK cascade 連鎖の全体像

```
card 削除(delete-card / bulk delete / OCR discard):
  cards ─CASCADE→ answer_events, reviews, card_tags, card_asset_refs
  study_days: 影響なし(加算 2 列は永久保持 / distinct は次回同日 flush 時のみ縮む)
  study_sessions: 影響なし(card_ids jsonb 内の id は宙に浮く)

exam 削除(delete-exam.ts):
  exams ─CASCADE→ cards(→ 上記連鎖), source_documents
  study_sessions.exam_id ─SET NULL→(行は残る・exam 帰属だけ消える)
  tombstone は exam + 配下 card に立つ(answer_events/reviews は tombstone 対象外
  = client mirror を持たないので不要、という整合は取れている)

user 削除(退会 webhook):
  明示 DELETE: exams, study_days, study_sessions, (他 Group I 8 表)
  連鎖: 上記 card 連鎖すべて
  users: soft delete(行残置)

session 削除:
  study_sessions 行の個別削除経路は退会以外に無い
  → answer_events.session_id の SET NULL は現行経路で発火しない(第 1 弾 §1.5)
```

### 5.3 保持方針が決まっていない表

| 対象 | 現状 | 決まっていないこと |
|---|---|---|
| server `answer_events` | card 生存中は無期限蓄積(時間 GC なし) | 保持期間 / 上限。1 回答 = 1 行が永久に増える |
| server `reviews` | 同上 | 同上。加えて **FSRS ReviewLog としての要件を満たしていない**(`docs/audit/2026-07-17-test-quality-audit.md:110` が指摘済: パラメータ再最適化・FSRS 版移行に必要な「直前 review timestamp / scheduler 設定 version」を保持していない。ts-fsrs の `rate()` が返す `ReviewLog`(`result.log`)は `replay-card.ts:87` で**捨てている**) |
| server `study_sessions` | 無期限蓄積(completed/abandoned の掃除なし) | terminal session の保持期間 |
| client `answer_events` | **無期限蓄積**(synced / failed とも削除経路ゼロ・第 1 弾 §1.2) | 端末容量観点の掃除 |
| client `study_sessions` | 同上 | 同上 |
| study_days | server 無期限 / client 90 日 window | server 側の保持上限(現状は増分課題なし・行数 = user×日) |

---

## 6. 歪みの候補(CC の所見)

重い順。設計提案はしない。各項に根拠。

1. **event の一次記録(answer_events)が FSRS 入力(rating)を持たず、FSRS 入力の記録(reviews)が event と紐付かない**。1 つの出来事が 2 表に分割保存され、どちらも単体で不完全、結合キーは値一致の慣習のみ(第 1 弾 §1)。さらに ts-fsrs が返す正式な ReviewLog は捨てている(`replay-card.ts:87`)ため、**「何が起きたか」を完全に持つ表がどこにも無い**。監査 doc が launch 前確認事項として既に指摘(`2026-07-17-test-quality-audit.md:110`)。
2. **「適用されたか」を記録する場所が無い**。sprint ③(順序ガード + 履歴のみ記録)を実装すると reviews に「FSRS に効いた行」と「記録だけの行」が混在し事後判別不能になる(第 1 弾 §5.2)。gate 導入前に schema 側の受け皿が要る構造。
3. **3 つの履歴表で保持意味論が三様**: reviews / answer_events は「card と運命共同体」(CASCADE)、study_days は「card から独立して永久」(schema.ts:483 の設計宣言)、しかも study_days 内部でも加算 2 列と上書き 1 列で意味論が分裂(§3.3)。「学習履歴はユーザーのものか card のものか」が決まっていない。
4. **write-only 表が 2 つ**: server answer_events(読み手ゼロ・§2.1)と study_sessions(読み手ゼロ・§2.5)。reviews も実質 distinct 集計の材料のみ(rating は書いて読まず・§2.3)。「将来使う」で書き続けているが、将来の用途(FSRS replay)に必要な列(rating / scheduler version)が無いため、**このままでは将来も使えないログを溜めている**。
5. **完全な死列**: `study_sessions.query`(両側で書き手なし)/ `answer_events.elapsed_ms`(両側で書き手なし)/ `answer_events.sync_status`(server・単一値固定、client の同名列と意味が別で紛らわしい)/ `answer_events.last_attempted_at`(client・書くが読まない)/ `study_days.correct_count`(書くが読み手ゼロ・§2.7)/ `study_sessions.updated_at`(server・宣言された用途 = pull cursor が存在しない)。加えて到達不能状態 `status='abandoned'`(呼出元ゼロの export 関数 `abandonStudySession`)。
6. **distinct_card_count の时间的不整合**: reviews が card 削除で消えた後、同じ day に再 flush が起きた場合のみ distinct が縮み、review_count は縮まない。つまり **study_days の列間整合が「その日にもう一度復習するか」という偶然に依存**(§3.3)。streak は `review_count > 0` 基準なので実害は today 表示のみだが、表として自己矛盾を含む。
7. **正誤の定義が 2 つある**: `answer_events.is_correct`(選択肢一致)と `rating >= 2`(FSRS 評価)。`cards.last_correct` / `study_days.correct_count` は後者、client tally は前者ベース。FSRS モードで両者は日常的に乖離しうる(正解して Again を押す)。どの「正解率」を正とするかが決まっていない(§3.4)。
8. **client outbox 2 表(study_sessions / answer_events)だけ user_id が無い**。アカウント切替で他 user の pending が現 user の認証で送られ、orphan reject → 永久再送(24h drop が唯一の止め)になる(§4)。Dexie の他表はすべて user_id + owner-scope を持つ設計と非対称。
9. **answer_events.session_id の FK にテナント整合が無い**: Phase 0 の upsert ガード(setWhere の userId 一致)は**既存 session 行の UPDATE を防ぐだけ**で、events 処理は `applied=false` でも続行する(route.ts:123-135)。他 user 所有の session_id を payload に載せると、**自分の answer_events 行が他 user の study_sessions 行を FK 参照する**形が通る(FK 検証は RLS を通らない)。`COVERAGE.md:29` の「client session_id の cross-tenant を封鎖」は upsert にのみ真で、参照封鎖はされていない。実害は小(情報漏洩なし)だが、テナント境界の宣言と現物が食い違う。
10. **cards が 3 責務の複合体**: 出題内容(entity_mutations が書く)+ FSRS 状態(review flush が書く)+ 表示用統計(同)。単一の `updated_at` cursor を共有するため、**復習するだけで card 全体(question_text / options / images 含む)が次回 pull の差分に載る**(pull 帯域は履歴 979KB の実測が audit にあり)。書込主体が 2 系統(outbox / bulk)で同一行に交差するのは repo 内で cards のみ。
11. **数値制約の DB レベル不在**: rating 1-4 / state 0-3 / count 非負 / mode・status の値域すべて CHECK なし(§1.7)。TS `$type` と zod のみで、SQL 直接操作・migration バグ・将来の別経路に対して無防備。real 精度問題(第 1 弾 ②)と同根の「DB が正本のくせに DB が守っていない」形。
12. **streak 計算の二重実装が宣言付きで存在**: `lib/db/streak.ts` と `lib/client/streak.ts` は「同仕様で port」(dashboard-stats.tsx:12-14)— CLAUDE.md「client/server 二重実装をしない(pure 関数 1 定義を両側 import)」の明示的違反が既存内在。JST 日付バケツも JS / SQL の 2 実装(§2.8)。
13. **`reviews.reviewed_at` の `defaultNow()` は罠**: 常に明示値で書く現実装では無害だが、値を省いた insert が混入すると DB クロックが埋まり、answered_at との値一致(表間対応の唯一の鍵・§2.9)が silent に壊れる。default の存在自体が「省いても動いてしまう」経路を開けている。
14. **session の粒度が UI 実装詳細に結合**: session = SessionLauncher の 1 mount(§3.2)。「前へ」で同一 card を再回答すれば同 session 内に同 card の event が複数正当に発生し、replay は全部 fold する。この多重回答の意味論(復習 1 回か 2 回か)は study_days.review_count(2 回)と client tally(1 枚)と cards.reps(2 加算)で三様。
15. **card create の初期 due が client / server の 2 箇所で独立生成**: client optimistic は client クロック ISO(`build-new-client-card.ts:49` `due: now`)、server は DB default `now()`。pull で収束するとはいえ、初期値も「1 定義」でない(§3.4 の分類と同根の小粒)。

---

## 付記: 前回 doc との関係

- 並走 lost update / 24h drop / real 精度 / 順序ガード挿入位置 / test 波及は第 1 弾(`2026-08-11-fsrs-consistency-factfinding.md`)。
- 本 doc はその上流(表構造そのもの)の全量。sprint スコープ ①〜④ の再設計判断で、特に ④(event 紐付け)は §6-1/2、③ は §6-2/6、保持方針は §5.3 が直接材料。
