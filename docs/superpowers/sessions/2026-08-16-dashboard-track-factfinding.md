# ダッシュボードトラック(R0 / Dash-0〜3)spec 前提確認 — repo 現物調査

- 日付: 2026-08-16
- 種別: 調査のみ(実装 / commit なし)
- 対象 HEAD: `92da197`
- 依頼: claude.ai 側分析 doc の前提を repo 現物で照合(12 項目)

---

## 1. cards の FSRS 実列

正本 = `lib/db/schema.ts:296-392`(`cards`)。DB default は FSRS 整合 Sprint A Task 3 で**全撤去済**(供給漏れは NOT NULL 違反で loud fail)。初期値の 1 定義は `lib/cards/domain/initial-fsrs-state.ts:initialFsrsState`。

| 列 | 型 | NULL | 備考 |
|---|---|---|---|
| `due` | `timestamp with time zone` | NOT NULL | index `cards_due_idx (user_id, due)` |
| `stability` | `double precision` | NOT NULL | real → double は Task 3 で変更済 |
| `difficulty` | `double precision` | NOT NULL | 同上 |
| `elapsed_days` | `integer` | NOT NULL | |
| `scheduled_days` | `integer` | NOT NULL | |
| `reps` | `integer` | NOT NULL | **有り** |
| `lapses` | `integer` | NOT NULL | **有り** |
| `state` | `integer` `$type<0|1|2|3>` | NOT NULL | 0=New / 1=Learning / 2=Review / 3=Relearning。CHECK `cards_state_range` (BETWEEN 0 AND 3) |
| `learning_steps` | `integer` | NOT NULL | |
| `last_review` | `timestamptz` | **NULL 可** | **有り**(未回答 = NULL) |

FSRS 以外の学習統計(同 block): `answered boolean NOT NULL` / `last_correct boolean NULL`(NULL = 未回答)/ `current_streak integer NOT NULL`。

初期値(`initialFsrsState(now)`): `due = now` / stability 0 / difficulty 0 / elapsed 0 / scheduled 0 / reps 0 / lapses 0 / **state 0** / learning_steps 0 / last_review null / answered false / last_correct null / current_streak 0。
→ **新規 card は生成時点で即 due**(後述 §4 に直結)。

client mirror 側は同名 snake_case + ISO 文字列(`lib/client-db.ts:96-127` `ClientCard`)。`due` / `last_review` は ISO8601 文字列。

---

## 2. Dexie v12 / 11 store の内訳

`lib/client-db.ts`。version 1〜12(最新 = v12、`entity_mutations` を owner-scope schema で再作成)。現存 store は 11:

| store | 主キー / index | 役割 |
|---|---|---|
| `exams` | `id, user_id, updated_at, content_version` | pull mirror(read-only) |
| `cards` | `id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id], [user_id+due]` | pull mirror。演習 / dashboard の読み元 |
| `answer_events` | `++local_id, &event_id, [user_id+sync_status]` | **上り専用 outbox** |
| `entity_mutations` | `++local_id, &mutation_id, [user_id+sync_status]` | 汎用 outbox |
| `sync_meta` | `key` | cursor / view pref |
| `study_days` | `[user_id+day], user_id, day` | server study_days の mirror(90 日) |
| `tag_categories` | `id, user_id, updated_at` | tag master mirror |
| `tag_options` | `id, user_id, category_id, updated_at` | tag master mirror |
| `card_tags` | `[card_id+option_id], card_id, option_id, user_id` | junction mirror |
| `media_assets` | `id, user_id, [user_id+hash], status` | 画像 asset 状態 |
| `media_download_jobs` | `[user_id+exam_id], user_id, status` | デッキ DL 進捗 |

### answer_events のローカル保持方針

- 書き込み: `lib/sync/review-events.ts:56 recordAnswerEvent`(回答確定ごとに即 add、debounce なし)。
- 状態遷移のみで **delete する経路は存在しない**。Dexie 上の `answer_events` に触るのは 3 箇所だけ(`review-events.ts:72 add` / `:87 pending 取得` / `:95 pending count`)+ `modifyByKeys` による `sync_status` 更新。
- **件数上限・TTL・sweep なし**。旧「24h drop」は撤去済(`ClientAnswerEvent` の `last_attempted_at` も削除済)。`dropStaleByKey`(`lib/sync/outbox-ops.ts:69`)の呼び手は `entity_mutations` のみ(`lib/sync/entity-mutations.ts:219`)。
- 終端は `synced` / `failed` の 2 値。**synced 行も端末に残り続ける**(v9 の store drop のような schema migration 以外に消える契機がない)。
  → ローカルで「直近の回答履歴」を読む機能を足すなら現状の蓄積がそのまま使えるが、無限成長である点は spec で扱う必要あり。

### study_days のローカル

**有り**(`ClientStudyDay` = `user_id, day, review_count, correct_count, distinct_card_count`)。`day` は JST 'YYYY-MM-DD'。同期は `lib/sync/study-days.ts:51 pullAllStudyDays` の **clear + bulkPut による全置換**(cursor なし・90 日 full snapshot)。失敗時は Dexie を触らない。

### tag mirror の構造

server 3 表と 1:1。`tag_categories`(id / user_id / name / select_type 'single'|'multi' / color / sort_key / created_at / updated_at)→ `tag_options`(+ category_id)→ `card_tags`(card_id + option_id + user_id + created_at、複合 PK)。いずれも read-only mirror で、編集は `entity_mutations` outbox 経由。

---

## 3. ホームの 3 数値の算出経路

`app/(app)/app/page.tsx` は **DB を一切引かない**(`getCurrentUser()` のみ)。3 数値すべて **client 計算(Dexie + `useLiveQuery`)**。

| 表示 | component | 経路 |
|---|---|---|
| スマート復習 n 件 | `app/(app)/app/_components/dashboard-actions.tsx:45-58` | Dexie `cards.where('[user_id+due]').between([uid,'0'],[uid,nowIso],true,true).count()`。native `IDBIndex.count` で行本体 fetch なし。0 件時は「復習完了!」表示に差し替え |
| 今日 x 問 | `app/(app)/app/_components/dashboard-stats.tsx:28` → `lib/client/streak.ts:27 getStreakStatsFromDexie` | Dexie `study_days` を `user_id` で読み、**今日(JST)行の `distinct_card_count`** をそのまま表示。= その日 1 回でも回答した unique card 数 |
| 連続 y 日 | 同上 → `lib/streak-core.ts:9 computeStreak` | `study_days` の直近 61 日 window(today + 過去 60)から `review_count > 0` の day 集合を作り、**today が無ければ yesterday 起点にフォールバック**して連続数を数える |

- server 版の同一計算は `lib/db/streak.ts:25 getReviewStatsForUser`(同 window / 同 filter / 同 return shape)。`computeStreak` は `lib/streak-core.ts` の 1 定義を server/client 双方が import。
- `GET /api/dashboard/stats`(`app/api/dashboard/stats/route.ts`)は**現在 caller ゼロ**。dashboard-stats.tsx のコメントに「fallback 用に据置」とあるだけの実質デッドルート。
- mirror 更新の trigger: `app/(app)/app/_components/pull-trigger.tsx:52 pullAllStudyDays()` と、flush 成功時の `lib/sync/pull-back.ts:21`。

---

## 4. スマート復習の出題仕様

経路: `app/(app)/app/study/smart/page.tsx` (RSC) → `study-session-host.tsx` → `session-launcher.tsx` → `session-runner.tsx`。

- **選定条件は `due <= now` の 1 本のみ**。exam 横断、state / answered による絞りは**無い**。
  - client: `lib/cards/get-dexie-session-cards.ts:25 getDueCardsFromDexie` — `[user_id+due]` の range cursor(`includeUpper=true` 必須)。
  - server fallback: `lib/cards/get-session-cards.ts:22 getSessionCards` — `WHERE user_id AND due <= now ORDER BY due ASC`。
  - host は **Dexie 優先 / 0 件 or throw で server props に fallback**(`study-session-host.tsx:47-66`)。両方 0 件で empty UI。
- **New カード混入 = 有り**。新規 card は `due = 作成時刻`(§1)なので生成直後から due。state=0 を除外する条件がどこにも無いため、New と Review は同一プールで混ざる。
- **1 回の上限** = `user_settings.session_limit`(**default 20**、行不在時も 20、明示 `null` = 上限なし)。`smart/page.tsx:33` で決定し、Dexie 側は `.limit(n)`、server 側は SQL `LIMIT`。
- **並び順** = **due 昇順のみ**(shuffle なし)。Dexie 側は index 順が構造的に due ASC なので `.sortBy()` を呼ばない。→ 期限が古い card から順、つまり**古い New card が先頭に来る**。
- 出題中の遷移: selecting → judged → finished。「次へ」でスキップ可(submit なし)、「前へ」で戻れる、「リトライ」で同 card を selecting に戻す。同一 card を複数回 submit すると server 側は event ごとに INSERT / 全て applied(順序ガードが `>=`)なので **reps も study_days.review_count もその分進む**(`session-runner.tsx:277-283` のコメントに明記)。

---

## 5. カスタム演習の絞込パラメタ現況

form = `app/(app)/app/study/custom/_components/custom-filter-form.tsx`、選定 = `lib/cards/get-custom-session-cards.ts:50 selectCustomSessionRows`、述語 = `lib/cards/card-filter-predicates.ts`、criteria 型 = `lib/cards/custom-session-criteria.ts`。

| パラメタ | 実装状況 | 実体 |
|---|---|---|
| 試験(複数選択) | **有り** | `matchesExamFilter`(空 = 全試験、複数 = OR) |
| タグ | **有り** | `matchesTagFilter`(カテゴリ内 OR / カテゴリ間 AND)。UI は `CardTagAddPopover` の selectOnly |
| 間違い | **有り** | `answerState='incorrect'` = `last_correct === false`(**直近不正解**であって「過去に間違えたことがある」ではない) |
| 未出題 | **有り** | `answerState='unanswered'` = `answered === false` |
| 直近正解 / すべて | 有り | `correct` / `all` |
| 連続正解数 | **有り** | `matchesStreakFilter`(`≤` / `≥` / `=` × 数値、空入力 = 絞り込みなし) |
| 出題順 | **有り** | `sequential`(exam ごとに base_order 昇順 = `compareByBaseOrderAcrossExams`)/ `random`(Fisher-Yates。seed は `seedFromCriteria` でプレビューと一致) |
| 件数 | **cap のみ** | `user_settings.custom_session_limit`(default 20 / null = 無制限)。**ユーザーがその場で件数を指定する UI は無い**(設定画面の値がそのまま cap) |
| 時間指定 | **無し** | 該当コードなし |
| due / 期限 | **無し** | custom は due gate を持たない(全 card 対象) |

補助表示: 「条件一致 N 件 / 出題 M 件」の 2 値ヒント + cap 適用後の出題プレビュー一覧(`custom-session-preview.tsx`)。演習開始ボタンは常時 enabled。

---

## 6. exams の現列 / タグの帰属スコープ

`lib/db/schema.ts:260-287` の exams は **6 列のみ**: `id` / `user_id` / `name` / `content_version` / `created_at` / `updated_at`(hard delete、`deleted_at` なし)。
→ `exam_date` / `daily_new_target` は**未存在**。追加余地はあるが、触る箇所は以下:

1. `lib/db/schema.ts`(列 + 必要なら CHECK)+ `drizzle/migrations` の新規 migration
2. `lib/db/exams-pull.ts:12 toClientExam`(**explicit mapper**なので追記必須)
3. `lib/client-db.ts:40 ClientExam` 型(index 不要なら **Dexie version bump は不要**)
4. 書き込み側: exams は **outbox に載らない**(`ENTITY_MUTATION_REGISTRY` の entity_type は `card` / `tag_category` / `tag_option` / `card_move` の 4 種のみ)。実 write は server action 4 経路 — `app/(app)/app/exams/_actions/create-exam.ts:48` / `rename-exam.ts:54` / `delete-exam.ts:89` / `app/(app)/app/upload/_actions/submit-upload.ts:538`。
   → **client-first 編集にしたい場合は outbox に `exam` entity を新設する必要があり、それは registry + DB CHECK + iso test(`tests/integration/pg/check-constraints.test.ts`)の同時更新を伴う**(語彙拡張の deploy 順序も規約あり)。

タグの帰属スコープ = **user 単位**(exam 単位ではない)。`tag_categories.user_id` / `tag_options.user_id` があり、exam への FK は無い(`schema.ts:717-776`)。card への紐付けは `card_tags` junction(card_id + option_id)経由で、結果として「試験横断のタグマスタ」。

---

## 7. answer_events に下り(pull)はあるか

**無い。完全に上り専用。**

- `GET /api/pull` が返すのは cards / exams / tombstones / tag_categories / tag_options / card_tags の 6 種 + cursor 6 本(`lib/sync/pull.ts:42-61`)。answer_events は含まれない。
- `answer_events` を返す endpoint は存在しない(`app/api/review-events/bulk` は POST のみ)。
- 回答結果が client に返る唯一の経路は **pull-back**: flush 成功時に cards の FSRS 値と study_days を引き直す(`lib/sync/pull-back.ts`)。
- したがって「別端末で回答した個々の event」はローカルには来ない。**端末間で共有されるのは cards の最終状態と study_days の日次集計だけ**。

---

## 8. study_days の日界規則

- `study_days.day` は `date` 型で **JST 'YYYY-MM-DD'**(`schema.ts:519-538`)。3 統計列 + 非負 CHECK 3 本、PK = `[user_id, day]`。
- 日付を切る場所は **2 箇所だけ**:
  1. `lib/jst.ts:1 todayInJst(now)` — UTC+9 を足して UTC 日付として読む(DST なし前提)。
  2. `lib/jst.ts:15 jstDayRange(day)` — `${day}T00:00:00+09:00` から 24h の `[startAt, endAt)` を UTC instant で返す。
- 集計は `lib/reviews/session-repository.ts:301 recomputeStudyDays`。ingest 側(`lib/reviews/ingest-review-events.ts:170-177`)が **applied になった event の `answered_at` を `todayInJst()` に通して対象 day 集合**を作り、その day だけを **絶対値で再集計**(加算意味論なし)。SQL は `AT TIME ZONE` を使わず、`jstDayRange()` の timestamptz を bind する(JS/SQL 二重実装の回避)。
- 集計対象は `applied = true` の event のみ。`review_count` = 行数 / `correct_count` = is_correct 数 / `distinct_card_count` = distinct card_id。
- **TZ はハードコード JST**。ユーザー別 TZ 設定は存在しない。日界を変える / ユーザー TZ を導入する場合、`todayInJst` と `jstDayRange` の 2 関数 + それを呼ぶ streak 2 実装(server/client)が影響範囲。

---

## 9. 演習セッションの中断状態

**永続化ゼロ。再開機能は現状ゼロベース。**

- `session_id` は `SessionLauncher` の `useState(() => newId())` で **1 mount = 1 採番**(`session-launcher.tsx:39`)。server にも Dexie にも session 行は無い(`study_sessions` は Dexie v9 / server とも廃止済)。answer_events の `session_id` は **親表なしのラベル列**。
- 進行状態(`idx` / `phase` / `selectedIds` / `tally` / `submittedCardIds` / `lastRating`)はすべて `SessionRunner` の React state。**リロード・タブ閉じ・`/app` への遷移で全消失**。
- 出題 card 配列も mount 時に一度決めるだけ(`study-session-host.tsx` の `useEffect(..., [])`)。
- `sync_meta` の既知 key は cursor 6 本 + `exam_view_prefs` のみ(`lib/sync/sync-meta.ts:16`)。セッション用の key は無い。
- 唯一残るのは**回答済み分の answer_events**(Dexie pending / synced)。「どこまで解いたか」は復元できないが、「何を解いたか」は残る。
  → 再開を作るなら新規に持ち方を決める必要がある(sync_meta への JSON 保存 helper `getJsonSyncMeta` / `setJsonSyncMeta` は既存で、Grid-1 の view pref が前例)。

---

## 10. セッション開始の API / origin 1 列を足す場合の触る箇所

### 現状の「開始」

**開始 API は存在しない。** RSC(`smart/page.tsx` / `custom/page.tsx`)が `user_settings` を読むだけで、card 選定は client、session_id も client 採番。server に届くのは `POST /api/review-events/bulk`(flush 時)だけで、これは「開始」ではなく「回答の bulk 送信」。

### origin 種別 1 列(例: `answer_events.origin = 'smart' | 'custom'`)を足す場合

| 層 | file:symbol | 内容 |
|---|---|---|
| DB | `lib/db/schema.ts:616 answerEvents` + `drizzle/migrations/` 新規 | 列追加。CHECK を張るなら enum 制約 |
| wire | `lib/sync/shared/answer-event-schema.ts:8 answerEventWireSchema` | client/server 共有 1 定義。ここが契約 |
| client 型 | `lib/client-db.ts:136 ClientAnswerEvent` | 行型に追加(**index 不変なら Dexie version bump 不要**) |
| client write | `lib/sync/review-events.ts:42 RecordAnswerEventInput` / `:56 recordAnswerEvent` / `:144 toWireInput` | 3 箇所 |
| UI 経路 | `session-runner.tsx:313`(recordAnswerEvent 呼び出し)← `session-runner.tsx:90 SessionRunnerProps` ← `session-launcher.tsx:22 SessionLauncherProps` ← `study-session-host.tsx:93` / `custom-session-flow.tsx:92` | **props chain で 2 呼び出し元から値を渡す**形になる(sessionId と同じ経路) |
| server ingest | `lib/reviews/ingest-review-events.ts:94-106`(row 組み立て) | wire → insert row |
| server repo | `lib/reviews/session-repository.ts:67 AnswerEventInsertRow` / `:81 insertAnswerEvents` / `:108 CollisionCandidate`(再送の内容一致比較に含めるか要判断) | 含めるなら `verifyEventCollisions` の正規化比較も更新 |
| test | `tests/integration/pg/answer-events-serialization.test.ts` の「schema contract」describe が **PK 1 + FK 1 + CHECK 3 本を定義文まで pin** している。CHECK を増やすとここが red。CHECK 語彙を DB に持つなら `check-constraints.test.ts` の方針(app SSoT + DB backstop の集合一致)にも合わせる |

補足: 既存 `session_id` は `.optional()` / DB は nullable。origin も後方互換を取るなら nullable + default か、既存行の埋め方を migration で決める必要がある。

### クライアント UI イベント計測の既存基盤

**無い。** analytics / posthog / gtag / mixpanel いずれも依存にもコードにも不在(全 grep 0 件)。計測系は以下しかない:

- `lib/logger.ts` — **server 用**の構造化 JSON logger(Vercel Function Logs 向け。Sentry swap-ready と明記)。client component からも import 可能だが、出力先は `console.*` のみで収集先が無い。
- `integration_failures` 表 + Discord dual-write — **外部連携失敗の台帳**であって UI 計測基盤ではない。
- `answer_events.elapsed_ms` — 唯一の実測 UI 由来メトリクス(card 表示 → submit の wall-clock、24h clip、tab 非表示時間を含む)。

→ 「演習開始をイベントとして計測する」なら、**新規に経路を作る**か、**answer_events に列を足して回答時に運ぶ**かの二択。前者は endpoint 新設(= 認証 / RLS / 冪等 / iso test の一式)を伴う。

---

## 11. ts-fsrs の ReviewLog

- version: `ts-fsrs@5.4.1`(package.json:60、exact pin)。
- 生成箇所: `lib/fsrs.ts:25 rate()` が `scheduler.next(card, now, rating)` を返す。戻り値は `RecordLogItem = { card, log }`。
- **`log`(= ReviewLog)は捨てている**。唯一の消費点 `lib/cards/replay-card.ts:73` が `rate(fsrsCard, rating, now).card` と `.card` だけを取る。ReviewLog を保存している表・列は存在しない(schema に該当なし)。
- 情報の代替: `answer_events` が「いつ / どの card / rating / 正誤 / elapsed_ms / applied」を持つため、**ReviewLog の入力側は再現可能**。失われているのは ts-fsrs が計算した**遷移前スナップショット**(log の `state` / `stability` / `difficulty` / `elapsed_days` / `scheduled_days` / `last_elapsed_days` / `due` / `review`)。
- 持続化する場合の自然な挿入点(server 側 1 経路で完結する):
  1. `lib/cards/replay-card.ts:47 replayCard` の戻り値に log 配列を足す(pure 関数のまま。現状 `{ ...state }` を返すだけ)。
  2. `lib/reviews/domain/session-aggregate.ts:120 foldSession` が per-event に `replayCard` を 1 件ずつ呼んでいる(`:139`)ので、**event_id と log が 1:1 で対応づく**。ここで `appliedEventIds` と並べて集める。
  3. `lib/reviews/ingest-review-events.ts:167` 付近(`applyCardFinalStates` / `markApplied` の隣)で新表に bulk INSERT。同一 `withTenantTx` 内なので原子性は自動的に満たされる。
- 新表を作る場合の追加コスト: `user_id` 必須 → RLS policy + `tests/integration/pg/setup/completeness.ts:13 EXPECTED_USER_ID_TABLES`(現在 **19 表**)の更新 + `rls-drift` / `fixture-completeness` の追随が必須。

---

## 12. tag mirror の owner 無スコープ読み / sign-out purge — 現状再確認

`docs/architecture.md:26`(および `:199` の残余リスク行)の 2026-08-12 実測「7 file・11 箇所」は **2026-08-16 時点でも数・場所とも一致**(退行も改善もなし)。

`tag_categories.toArray()` / `tag_options.toArray()` の owner 無スコープ直読 11 箇所:

| # | file:line | 対象 |
|---|---|---|
| 1 | `lib/cards/get-custom-session-cards.ts:60` | tag_categories |
| 2 | `lib/cards/get-custom-session-cards.ts:61` | tag_options |
| 3 | `lib/tags/tag-crud.ts:54` | tag_categories |
| 4 | `app/(app)/app/tags/_components/category-list.tsx:133` | tag_categories |
| 5 | `app/(app)/app/tags/_components/option-list.tsx:133` | tag_categories |
| 6 | `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:202` | tag_categories |
| 7 | `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:203` | tag_options |
| 8 | `app/(app)/app/exams/[id]/_components/exam-card-table.tsx:433` | tag_categories |
| 9 | `app/(app)/app/exams/[id]/_components/exam-card-table.tsx:434` | tag_options |
| 10 | `app/(app)/app/study/custom/_components/custom-filter-form.tsx:66` | tag_categories |
| 11 | `app/(app)/app/study/custom/_components/custom-filter-form.tsx:70` | tag_options |

= 7 file(get-custom-session-cards / tag-crud / category-list / option-list / inline-card-list / exam-card-table / custom-filter-form)。

**記録に含まれない追加の owner 無スコープ読みも実在する**(先行小修正のスコープを切るなら要判断):

- `where('category_id')` 経由(owner ではなく category で絞る): `lib/tags/tag-crud.ts:125` / `:210` / `:290`、`app/(app)/app/tags/_components/option-list.tsx:123`、`app/(app)/app/tags/_components/option-row.tsx:69`(**option-row.tsx は上記 7 file に含まれない 8 番目の file**)。
- `.get(id)` 直引き: `lib/tags/tag-crud.ts:50` / `:87` / `:121` / `:158`。
- `card_tags` 側は `where('card_id').anyOf(ownerScopedCardIds)` / `where('option_id')` の形で、card 側が owner-scoped なら間接的に閉じる(`get-custom-session-cards.ts:69` / `inline-card-list.tsx:215` / `exam-card-table.tsx:443`)。

### sign-out purge

**依然として不在。**

- sign-out UI は Clerk の `<UserButton />` のみ(`app/(app)/app/_components/app-header.tsx:79`)。カスタム `SignOutButton` / `useClerk().signOut` / `useAuth()` / `isSignedIn` の使用箇所は **repo 全体で 0 件**。
- Dexie を丸ごと消す経路(`Dexie.delete` / `deleteDatabase` / `db.delete()`)も 0 件。store 単位の `.clear()` は `lib/sync/study-days.ts:70` の study_days 全置換のみ。
- 退会経路(`app/(app)/app/settings/delete-button.tsx`)も Clerk `user.delete()` → webhook で server 側を消すだけで、**ローカル IndexedDB は残る**。
- 帰結(architecture.md:199 の既存 bug がそのまま): 共有ブラウザでアカウントを切り替えると、前 user の tag master が UI に出る。**書込側は Sprint B の「outbox owner は常に認証主体」で防御済**(他 user 名義の outbox が作られない)なので、残っているのは**表示の漏れ**。
- 加えて、上表の 11 箇所のうち **#1/#2/#10/#11 はカスタム演習の経路**(タグ絞り込み候補と選定ロジック)なので、ダッシュボード / 演習トラックの UI を触る際に自然に射程へ入る。

---

## 付随して確認できた事実(spec 判断に効きそうなもの)

1. `GET /api/dashboard/stats` は caller ゼロのデッドルート(§3)。ダッシュボード刷新時に「使う / 消す」を決めておくと良い。
2. スマート復習は **New と Review を区別しない**ため、「1 日の新規上限(daily_new_target)」を実装するには `state` / `reps` による分離が新規に必要(§4)。今は分離の材料が select 側に一切ない。
3. 同一 card を 1 セッション内で複数回 submit すると **reps / study_days.review_count が複数回進む**(§4 末尾)。「今日 x 問」の意味は distinct card 数なので、この二重進行は「今日 x 問」には出ないが「review_count」には出る。
4. ローカル `answer_events` は無限に蓄積する(§2)。ダッシュボードで履歴系を出すなら在庫としては使えるが、保持方針の決定が必要。
5. 新しい user 表を作る変更は必ず `EXPECTED_USER_ID_TABLES`(19 表)+ RLS policy + iso test 3 本に波及する(§11)。
