# FSRS 整合 sprint — fact-finding(2026-08-11)

- 対象: ① 同一 card への FSRS 適用の直列化 / ② `stability`/`difficulty` の real → double precision / ③ 24h 期限の撤廃 + 順序ガード / ④ reviews への event 紐付けの要否
- 方法: repo 現物のみ(実装・修正・commit なし)。実環境(stg/prod)の実データ・実測は本 doc の射程外で、該当箇所は「未確認」と明記した。
- Codex 準拠調査の 4 前提はすべて現物で確認した(§0)。

---

## 0. 前提 4 点の現物確認

| Codex の主張 | 現物 | 判定 |
|---|---|---|
| 復習 flush は session ごとの POST を並列送信 | `lib/sync/review-events.ts:231-247`(`Promise.allSettled(sessionIds.map(...))`) | **真** |
| server は card 行を通常 SELECT のみ(FOR UPDATE なし) | `lib/reviews/session-repository.ts:40-71`(`.select().from(cards).where(...)`、`.for('update')` なし) | **真** |
| `cards.stability` / `difficulty` が PG `real` | `lib/db/schema.ts:333-334` / `drizzle/migrations/0000_keen_the_hunter.sql:30-31` / 書込側 cast `lib/reviews/session-repository.ts:146` の `::real` | **真** |
| 24h 超 pending は flush 前に failed 化され server に届かない | `app/(app)/app/_components/review-flush-trigger.tsx:23,31-35`(mount で `dropStalePendingAnswerEvents(Date.now(), 24h)` → その後 `kick`) | **真**(ただし発火点は「(app) layout の mount 時のみ」= §4.1) |
| `answer_events.event_id` UNIQUE + ingest は ON CONFLICT DO NOTHING | `lib/db/schema.ts:615` / `lib/reviews/session-repository.ts:94-100` | **真** |

---

## 1. answer_events の実態(④ の判断材料)

### 1.1 実列の全一覧

`lib/db/schema.ts:611-650`。

| 列 | 型 | 何として入るか(書込元) |
|---|---|---|
| `id` | uuid PK `defaultRandom()` | DB 採番 |
| `event_id` | uuid **NOT NULL UNIQUE** | client 採番(`lib/sync/review-events.ts:126` `newId()`)。冪等キー |
| `session_id` | uuid FK → `study_sessions.session_id` **ON DELETE SET NULL** | payload の `session.session_id`(`lib/reviews/ingest-review-events.ts:151`) |
| `card_id` | uuid NOT NULL FK → `cards.id` **ON DELETE CASCADE** | event の `card_id` |
| `user_id` | uuid NOT NULL FK → `users.id` **ON DELETE CASCADE** | auth 由来(`user.id`)。client 供給ではない |
| `selected_answer_ids` | jsonb NOT NULL default `[]` | client が選んだ option id 配列。server 側 A-2 検証済(`admitEvents`) |
| `is_correct` | boolean NOT NULL | client 判定(`session-runner.tsx` の `equalSet` 結果) |
| `answered_at` | timestamptz NOT NULL | **client クロック**の ISO 文字列。server は形式のみ検証(`z.iso.datetime()`)、範囲・skew の検証なし(`lib/reviews/ingest-review-events.ts:52` / `lib/validation/review-session-bounds.ts` は個数上限のみ) |
| `elapsed_ms` | integer NULL | client 計測。現状 client は送っていない(`lib/sync/review-events.ts:312` は `elapsed_ms !== undefined` の時のみ載せるが、`session-runner.tsx:290-296` の `recordAnswerEvent` 呼び出しに `elapsed_ms` が無い)→ **実データは常に NULL(現物上)** |
| `sync_status` | text `$type<'synced'>` NOT NULL default `'synced'` | server 側の受領確定のみ。client の SyncStatus 4 値とは別物(schema コメント :637-639) |
| `created_at` | timestamptz NOT NULL `defaultNow()` | DB 打刻 |

index: `(user_id, answered_at)` / `(card_id, answered_at)` / `(session_id)`(:646-648)。

**決定的に重要な欠落 — `rating` 列が無い。**
client は payload に `rating`(1-4)を載せる(`lib/sync/review-events.ts:313`、FSRS モードで user が押した値)が、`insertAnswerEvents` の行型 `AnswerEventInsertRow`(`lib/reviews/session-repository.ts:79-88`)に `rating` が無く、**`answer_events` には保存されない**。rating は `reviews.rating` にしか残らない。

### 1.2 保持方針 / 掃除経路

- **退会 scrub の対象か**: 明示 DELETE の対象**ではない**が、**実質は消える**。`lib/clerk/handle-clerk-event.ts:236` が「Group II(明示 DELETE しない・親 cascade で連鎖)」として `reviews / answer_events は cards cascade(= exams chain)で連鎖」と明記。同 tx の `tx.delete(exams)`(:271)→ cards CASCADE → answer_events CASCADE。
  - なお `study_sessions` は同 tx で明示 DELETE(:275)されるが、実行順で exams が先に消えるため answer_events は既に無い。`session_id` の SET NULL は退会経路では発火しない。
- **その他の削除経路**: exam 削除(`app/(app)/app/exams/_actions/delete-exam.ts:86` の exams DELETE → FK CASCADE)、card 削除(cards DELETE → answer_events CASCADE)。
- **時間ベースの掃除・GC は無い**(server 側 `answer_events` を DELETE / TRUNCATE する script・cron は grep で 0 件)。
- **client 側 Dexie の `answer_events` も一切削除されない**。`lib/sync/review-events.ts` に `add` / `modify` はあるが `delete` / `clear` は production コードに無い(`.clear()` は test のみ)。synced も failed も永久に残る。

→ **保持は「card が生きている限り恒久 / card が消えたら同時に消滅」**。時間で消えることはない。

### 1.3 reviews と answer_events の対応関係

同一 tx 内で両方 insert される(`lib/reviews/ingest-review-events.ts:147-189`)。

| ケース | answer_events | reviews |
|---|---|---|
| 正常 event(初回) | 1 行 insert | 1 行 insert |
| 重複 event(再送) | ON CONFLICT DO NOTHING で 0 行 | `planReplay` が `insertedEventIds` で gate → 0 行 |
| orphan / A-2 不正(`admitEvents` reject) | **0 行**(insert 対象に入らない) | 0 行 |
| tx throw | rollback で両方 0 行 | 同左 |

→ **applied event については 1:1**。ただし「片方にしか無い情報」がある:

- **answer_events にしか無い**: `event_id`(冪等キー)/ `session_id` / `selected_answer_ids` / `is_correct` / `elapsed_ms`(実質 NULL)/ `created_at`(server 受領時刻)
- **reviews にしか無い**: **`rating`**(1-4)

`reviews` の列は `id / user_id / card_id / rating / reviewed_at` のみ(`lib/db/schema.ts:148-168`)。

### 1.4 event_id から reviews を辿る手段

**現状は無い。** `reviews` に `event_id` / `answer_event_id` / `session_id` のいずれも無い。

ただし **値の一致は成立している**: `replayCard` は `reviews.push({ rating, reviewedAt: now })` で `now = event.answeredAt`(`lib/cards/replay-card.ts:67,109`)、`replaySession` は `answeredAt: new Date(ev.answered_at)`(`lib/reviews/domain/session-aggregate.ts:171`)。
→ **`reviews.reviewed_at` は対応する `answer_events.answered_at` と厳密一致**する。`(user_id, card_id, reviewed_at == answered_at)` が de-facto の join key になる。ただし UNIQUE 制約は無く、同一 card に同一 ms の event が 2 件あれば曖昧になる(現実にはほぼ起きないが、機械保証は無い)。

### 1.5 「イベントの恒久正本として answer_events を使えるか」

**使えない。** 理由は 3 つ(重い順):

1. **`rating` を保存していない**(§1.1)。FSRS モードで user が押した Hard(2)/Easy(4) は `answer_events` から復元不能。`is_correct` から derive すると 3 か 1 に潰れる。**`answer_events` 単体では FSRS の再 replay ができない**。
2. **card 削除で同時消滅**(§1.2)。card を消せば履歴も消える設計で、`reviews` も同じ。「card から独立した恒久ログ」ではない。
3. `session_id` は SET NULL で失われうる(現行経路では発火しないが schema 上は許容)。

→ ④ の判断材料としての結論: **`answer_events` と `reviews` はどちらも単体では event の正本たりえず、両者を合わせて初めて 1 event の全情報になる。両者を結ぶ機械的な鍵は存在しない**(値一致の慣習のみ)。③ で「古い event を reviews に履歴として記録するのみ」を実装する場合、その review 行は `answer_events` に対応行が有る(insert は gate 前に済むため)が、**「その review が scheduling に適用されたか否か」を後から判別する列が両表とも無い**。これは ④ の要否を分ける中心論点。

### 1.6 隣接する事実(scope 外だが ④ に効く)

`study_sessions.status` は **server 側で誰も読まない**(grep: 書込 = `upsertSessionGuarded` / 削除 = 退会 handler のみ)。かつ **completed が server に届かないケースが構造的にある**: `FLUSH_THRESHOLD = 5`(`session-runner.tsx:78`)で 5 件ごとに flush されるため、card 数が 5 の倍数の session は完了時点で pending 0 → `flushAllPendingEvents` の `sessionIds` に載らず POST されない(session-runner.tsx:302-303 のコメントが「session 完了 flush は残件 0 で skip」と自認)。よって `answer_events.session_id` の指す行の `status` は信用できない。

---

## 2. 直列化の設計材料(①)

### 2.1 flush の並列送信の実装箇所と理由

- **実装**: `lib/sync/review-events.ts:231-247` `flushAllPendingEvents`。全 pending を `session_id` で group 化し、`Promise.allSettled(sessionIds.map(sid => flushPendingEvents(sid, client)))` で**同時 POST**。同時数の上限は無い(pending が跨る session 数だけ並走)。
- **理由(コードから読める分)**:
  - :230 「`Promise.allSettled` を使うため一部 session の失敗が他の session を止めない」= 障害隔離。
  - 根本は **wire format**: `payloadSchema = { session, events }`(`lib/reviews/ingest-review-events.ts:62-66`)で **1 POST = 1 session 固定**。複数 session を送るには複数 POST しかない。`processSession` に `// future: multi-session payload 対応の拡張ポイント`(:79)と明記あり。
- **doc 側**: `docs/audit/2026-07-26-h0-part2-architecture-invariants.md` A4「review-events は session 別に並列」(§2 A4 / §「transport 制約」)。**`docs/architecture.md` §1 には並列の記述は無い**(:17 は 3 系統の列挙のみ)。
- 並列を選んだ理由が「性能」だと書いた記録は**無い**。

### 2.2 card 読み書きが交差する経路

**flush の入口は 3 つあり、うち 2 つは Web Locks を通らない。**

| # | 入口 | Web Lock | in-flight guard |
|---|---|---|---|
| A | `ReviewFlushTrigger` → `createReviewFlushController` → `runGuardedFlush` → `flushAllPendingEvents`(`lib/sync/review-flush.ts:81-97`) | **あり**(`FLUSH_LOCK_NAME`、`ifAvailable:true` = 取れなければ skip) | あり |
| B | `SessionRunner` threshold flush → `flushPendingEvents(sessionId)` 直呼び(`session-runner.tsx:301`) | **なし** | あり(event_id 単位) |
| C | `SessionRunner` 完了時 → `flushAllPendingEvents()` 直呼び(`session-runner.tsx:326`) | **なし** | あり(event_id 単位) |

in-flight guard(`lib/sync/review-events.ts:209,270-285`)は **`event_id` 単位**で、card 単位でも session 単位でもない。

したがって同一 user の複数 POST が並走する経路は少なくとも次の 3 種:

1. **1 タブ・1 回の `flushAllPendingEvents` 内**(A/C 共通): pending が 2 session 以上に跨れば、その数だけ POST が同時に飛ぶ。**同一 card が 2 session に跨る**のは構造的に可能(session を中断して別 session を開始 / smart と custom で同一 card)。
2. **タブ間**: B と C は lock を取らないので、タブ 1 の threshold flush とタブ 2 の controller flush(A)は排他されない。
3. **同一タブ内**: B(threshold)の POST 中に C(完了)が走る。異なる event 群なので in-flight guard は通る。

server 側の交差点は `lib/reviews/ingest-review-events.ts:102-208` の 1 tx:

```
withTenantTx(user.id, tx => {
  loadCardReplayStates(tx, user.id, cardIds)   // ← 通常 SELECT。行ロックなし
  insertAnswerEvents(...)                       // ON CONFLICT DO NOTHING
  replaySession(cardStateMap, groups)           // in-memory fold(SELECT した snapshot 基準)
  insertReviews(...)                            // append-only
  applyCardFinalStates(tx, user.id, finalStates)// UPDATE ... FROM (VALUES ...)
  upsertStudyDays(...)                          // SUM increment
})
```

- `loadCardReplayStates` の結果を基に in-memory で計算し、`applyCardFinalStates` が**絶対値で上書き**する(`set: { stability: sql\`v.stability\`, ... }`、`lib/reviews/session-repository.ts:155-171`)。read と write の間にロックが無い → **classic lost update**。
- **失われないもの**: `reviews`(append-only)/ `study_days.review_count`,`correct_count`(`SUM` increment、`session-repository.ts:254-255`)/ `answer_events`(UNIQUE で冪等)。
- **失われるもの**: `cards` の FSRS 13 列すべて(due / stability / difficulty / elapsed_days / scheduled_days / reps / lapses / state / learning_steps / last_review / answered / last_correct / current_streak)。
- **時系列逆転**: POST の到着順 = 適用順であり、`answered_at` は一切参照されない(`planReplay` / `replaySession` は payload 順で fold するのみ)。古い event を含む POST が後着すれば、card は古い state に上書きされる。

### 2.3 withTenantTx の性質

`lib/db/tenant-tx.ts:29-37`:

```ts
return getDb().transaction(async (tx) => {
  await setTenantContext(tx, userId)   // SELECT set_config('app.user_id', ..., true)
  return fn(tx)
})
```

- **isolation level は指定していない** → PostgreSQL 既定の **READ COMMITTED**。drizzle の `transaction(fn, config)` 第 2 引数(`isolationLevel`)は未使用(repo 全体で grep 0 件)。
- **行ロックは張れる**: `tx` は通常の drizzle executor なので `.for('update')` も `tx.execute(sql\`SELECT pg_advisory_xact_lock(...)\`)` も可能。実際 `submitUploadTx` は `withTenantTx` 配下の tx で advisory lock を取っている。
- 接続は `getDb()`(Supabase Transaction pooler / PgBouncer transaction mode、`prepare: false`、`lib/db/index.ts:15-27`)。**transaction pooler では session-level advisory lock は使えない**(接続が使い回される)ため、使うなら **xact-scoped**(`pg_advisory_xact_lock` / `pg_try_advisory_xact_lock`)一択。既存実装もそうなっている。
- READ COMMITTED では `applyCardFinalStates` の UPDATE 自体は行ロックを取り最新行を再読するが、**書き込む値は古い snapshot から計算済み**なので lost update は防げない。

### 2.4 既存コードの流用可能 pattern

repo に**両方の前例がある**。

| pattern | 実装箇所 | 形 |
|---|---|---|
| **行ロック(`FOR UPDATE`)** | `app/(app)/app/upload/_actions/publish-prepared.ts:99,114,177`(drizzle `.for('update')`)、`app/(app)/app/upload/_lib/upload-pipeline.ts:1248`、`app/(app)/app/upload/_actions/submit-upload.ts:496` | `.select(...).from(t).where(...).limit(1).for('update')`。`publish-prepared.ts:153` に「**ready 行を ID 順に FOR UPDATE ロック**(単一 UPDATE は行ロック順を保証しないため)」= deadlock 回避の順序規律まで確立済 |
| **user 単位 advisory xact lock** | `app/(app)/app/upload/_actions/submit-upload.ts:435` | `SELECT pg_try_advisory_xact_lock(hashtext(${user.id})) AS locked` → 取れなければ `{ outcome: 'in_progress' }` で早期 return(待たない) |
| **楽観 version** | `upload_operations.lease_version`(`publish-prepared.ts:33` の `status='prepared' AND lease_version=:mine` 不一致拒否) | cards には version 列は無い(`content_version` は sync 用で FSRS 更新では触られない) |

`tests/integration/pg/submit-upload.test.ts:12` に「実 OS レベルの同時 advisory lock 競合(2 接続が同時に同じ hashtext を取り合う)は」検証していない旨の注記あり = **既存 advisory lock 自体も同時競合の実証は無い**。

### 2.5 直列化 3 候補の影響範囲(材料のみ・選定はしない)

| 候補 | 触る場所 | 効く範囲 | 効かない範囲 / 副作用 |
|---|---|---|---|
| **(a) card 行ロック**(`loadCardReplayStates` に `.for('update')`) | `lib/reviews/session-repository.ts:40-71` の 1 箇所 + 呼び側は不変。ただし `inArray(cards.id, cardIds)` の**複数行同時ロック**になるため deadlock 回避に **ORDER BY id** が要る(`publish-prepared.ts:153` の既確立規律と同型) | 同一 card への並走をすべて直列化。tab / session / device を問わない。server 完結 | ロック待ちが Vercel Function の実行時間を伸ばす。相手 tx が長い場合の待ち上限が無い(`FOR UPDATE NOWAIT` / `SKIP LOCKED` を使うなら「弾いた event をどう返すか」= wire の `failed[]` 設計に波及)。**別 user の card とは競合しない**ので粒度は最小 |
| **(b) user 単位 advisory xact lock**(`processSession` 冒頭) | `lib/reviews/ingest-review-events.ts:102` 直後に 1 文追加。前例あり(`submit-upload.ts:435`) | 同一 user の全 POST を直列化(card が異なっても)。実装最小・deadlock 順序問題なし | 粒度が粗く、無関係 session 同士も待つ / 弾く。`pg_try_` で弾くと失敗 event が `failed[]` に落ち、client は「permanent」扱い(§4.3)で自動 retry しない → 次の kick 待ち。`pg_advisory_xact_lock`(待つ)にすると Function timeout リスク。**`submit_upload` と同じ `hashtext(user.id)` を使うと upload と review flush が相互ブロックする**(key 空間を分ける必要あり) |
| **(c) client 側の直列送信化**(`flushAllPendingEvents` を逐次 for-await に) | `lib/sync/review-events.ts:239-246` の 1 箇所。`Promise.allSettled` → 逐次ループ | 同一タブ・同一呼び出し内の並走を消す。実装は最小 | **タブ間・入口 B/C の lock 抜け(§2.2)は消えない**ので単独では不十分。B/C を `runGuardedFlush` 経由に寄せれば多タブも塞がるが、`ifAvailable:true` は「取れなければ skip」なので flush 自体が起きない回が増える。**server は無防備のまま**(API 直叩き / 将来の別 client に対して構造保証にならない) |

補足: (a)(b) は server 側の構造保証、(c) は client 側の運用改善。`docs/architecture.md` の既存規律(「client/server 二重実装をしない / 共有 invariant は pure 関数 1 定義」)からは、**直列化の enforcement を server に置き、client は無駄打ち削減として扱う**のが素直。

---

## 3. real → double の影響範囲(②)

### 3.1 stability / difficulty を読む・書く全箇所

grep 全件(test / fixture を除く production コード):

| # | 箇所 | 役割 |
|---|---|---|
| 1 | `lib/db/schema.ts:333-334` | 定義 `real('stability').notNull().default(0)` / 同 difficulty |
| 2 | `drizzle/migrations/0000_keen_the_hunter.sql:30-31` | 初回 DDL `"stability" real DEFAULT 0 NOT NULL` |
| 3 | `lib/reviews/session-repository.ts:49-50` | **読み**(`loadCardReplayStates` の SELECT 列) |
| 4 | `lib/reviews/session-repository.ts:146` | **書き**(VALUES tuple の `${final.stability}::real, ${final.difficulty}::real`) |
| 5 | `lib/reviews/session-repository.ts:157-158,173` | **書き**(`set: { stability: sql\`v.stability\` }` / VALUES alias 列名) |
| 6 | `lib/reviews/ingest-review-events.ts:116-117` | row → `ReplayCardState` の詰め替え |
| 7 | `lib/cards/replay-card.ts:17-18,73-74,95-96` | pure fold(JS number = IEEE754 double で計算) |
| 8 | `lib/db/cards-mapper.ts:34-35`(`toClientCard`)/ `:72-73`(`toCard`) | server row ↔ ClientCard 変換 |
| 9 | `lib/client-db.ts:117-118` | Dexie `ClientCard.stability: number` / `difficulty: number` |
| 10 | `lib/cards/build-new-client-card.ts:50-51` | client 新規 card の初期値 `0` |

**書き手は #4/#5 の 1 経路(`applyCardFinalStates`)のみ**。card create は DB default `0`。他の FSRS 列(`reps` / `lapses` 等)を書く経路も同じくここだけ(grep 確認済)。

**UI に表示する箇所は 0 件**。`app/**` / `components/**` での `stability` / `difficulty` 出現は全部 test fixture(`stability: 0` の型埋め)。集計 SQL(`lib/db/streak.ts` / `getReviewStatsForUser`)も参照していない。

### 3.2 Dexie 側の型と pull 経路

- Dexie 型: `number`(`lib/client-db.ts:117-118`)。**index 対象ではない**(`cards` store の index は `id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id], [user_id+due]`、`client-db.ts:341-344`)→ **Dexie の schema version bump は不要**。
- 経路: `cards` 表 → `getCardsDelta`(`lib/db/cards-pull.ts:19-37`)→ `toClientCard`(`cards-mapper.ts:34-35`)→ `GET /api/pull` の `cards` stream(`app/api/pull/route.ts:73,84`)→ `pullDelta` の `db.cards.bulkPut(cards)`(`lib/sync/pull.ts:205`)。
- 値は JSON number(double)として運ばれる。**postgres-js は float4 も float8 も JS number で返す**ので、client 側コードの変更は不要。

### 3.3 `::real` cast の明示箇所

**production コードに 1 箇所のみ**: `lib/reviews/session-repository.ts:146`(VALUES tuple 内の `${final.stability}::real` と `${final.difficulty}::real`)。
他の `real(` 出現は `lib/db/schema.ts:979` の `paddingPct: real('padding_pct')`(`asset_derivations` 表・**本 sprint と無関係**)。

### 3.4 migration 1 本で完結するか

**完結しない。最低 2 ファイルのコード追随が要る。**

1. **migration**: `ALTER TABLE cards ALTER COLUMN stability TYPE double precision;` / 同 difficulty。`pnpm db:generate`(drizzle-kit)で `lib/db/schema.ts` の `real(...)` → `doublePrecision(...)` 変更から生成される。適用は `DATABASE_URL_ADMIN`(owner)経由(`drizzle.config.ts:9-21`)。
2. **`lib/db/schema.ts:333-334`**: `real` → `doublePrecision`(import も追加。`doublePrecision` の使用実績は repo に 0 件、drizzle-orm 0.45.2 で提供あり)。
3. **`lib/reviews/session-repository.ts:146`**: `::real` → `::double precision`(残すと **書込時に単精度へ丸められ、列型を広げた意味が消える**)。

追随不要が確認できたもの: Dexie schema(index 非対象)/ client コード(型は `number` のまま)/ RLS policy(`db/policies/rls-p2-enable.sql:25-27` は `cards_tenant ... USING(user_id ...)` で当該列を参照しない)/ index(`cards_*_idx` に stability/difficulty を含むものは無い)/ grants(列単位 grant なし)。

**運用上の注意(未検証・要 OT 判断)**:
- `real → double precision` は **binary-coercible ではない**ため、PostgreSQL は **テーブル全体を書き換える**(ACCESS EXCLUSIVE ロック)。cards の行数と所要時間は**未確認**(stg/prod の実 row 数を測っていない)。
- **既存値の精度は戻らない**。単精度で保存済みの値は「単精度の値を倍精度で保持」した状態になるだけ。この sprint 以降に計算される値からドリフトが止まる、という効果。
- iso harness は毎 run `drizzle/migrations` を `migrate()` で流す(`tests/integration/pg/setup/global-setup.ts:15-19`)ので、新 migration は自動で載る。

---

## 4. 24h ルールの実装全箇所(③)

### 4.1 判定・failed 化・drop の全列挙

**client 側のみ。server 側に 24h 判定は存在しない**(grep 確認)。

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `app/(app)/app/_components/review-flush-trigger.tsx:23` | `const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000`(**閾値の唯一の定義**) |
| 2 | 同 `:29-45` | **唯一の呼び出し点**。`useEffect` mount 時に `dropStalePendingAnswerEvents(Date.now(), PENDING_MAX_AGE_MS)` → その後 `controller.kick('mount')`。失敗は握り潰して kick は続行 |
| 3 | `lib/sync/review-events.ts:184-198` | `dropStalePendingAnswerEvents(now, maxAgeMs)` — pending 全件を取り `dropStaleByKey` に委譲。判定基準は **`answered_at`**(`timestampOf: e => e.answered_at`) |
| 4 | `lib/sync/outbox-ops.ts:69-94` | `dropStaleByKey` — `Date.parse(ts) < now - maxAgeMs` を **`sync_status: 'failed'` に modify**。境界(ちょうど 24h)は残す。drop した id 配列を返す |
| 5 | `app/(app)/app/layout.tsx:64` | コメント「backoff retry + 24h drop は controller 側」(記述のみ) |

**発火は「(app) layout の mount 時 1 回だけ」**。`visibilitychange` / `online` / retry timer では drop しない(`review-flush-trigger.tsx:47-56` は kick のみ)。常駐監視も無い(:22 のコメントが自認)。

**同種の前例**: entity_mutations 側は同じ機構で **24h → 30d に延長済**。`app/(app)/app/_components/entity-mutation-flush-trigger.tsx:37-39`「spec OT 修正 3 / audit §10.3 (b) #4 反映 = 24h → 30d 延長(隔離機構維持、30d 超は将来 ops 通知の打鍵点として温存)」。元指摘は `docs/audit/2026-06-12-repo-wide-audit.md:85`「durable outbox は本来 backoff retry を継続すべき。推奨: 自動 failed 化を撤去し backoff retry を継続」。**review-events 側は当時この是正が適用されていない**(閾値は 24h のまま)。

### 4.2 failed 化された event のその後

- **Dexie に残る**(物理削除しない。`review-events.ts:182` が明記)。
- **二度と送られない**: `getPendingAnswerEvents` は `where('sync_status').equals('pending')` のみ(`review-events.ts:143-150`)。`failed` は flush 対象外。復帰・再送・手動 retry の UI も API も無い(`sync_status` を読む UI は grep で 0 件)。
- **UI に見えない**: production コードで `sync_status` を参照する component は無い。ユーザーに通知も出ない(`review-flush-trigger.tsx:36-42` は `logger.info` だけ)。
- **永久に溜まる**: Dexie 側 `answer_events` の削除経路が無い(§1.2)。
- **server にも痕跡が無い**: 一度も POST されていないので `answer_events` にも `reviews` にも行が無い。**その回答は完全に消える**。

### 4.3 撤廃した場合の波及

| 前提 | 現物 | 撤廃時の影響 |
|---|---|---|
| **恒久失敗 event の終端が 24h drop しかない** | orphan(card 削除済)/ A-2 不正の event は `admitEvents` で reject → `failed[]` に載って 200 で返る(`ingest-review-events.ts:138`)。client は `failedEventIds` を **pending のまま残す**(`review-events.ts:337`)。`classifyFlushResults` は httpStatus=200 → `isRateLimitError` も `isTransientError` も false → **`'permanent'`**(`review-flush.ts:70`)→ controller は backoff retry しない(`:206-216`)が、**次の mount / visibilitychange / online / threshold flush で毎回また送られる** | **撤廃するとこの event は永久に再送され続ける**。24h drop が事実上唯一の GC。**③ の設計に「恒久失敗 event の終端」を別途用意する必要がある**(例: server の `failed[]` の理由を分類して permanent なものだけ client 側で failed 化する) |
| **1 POST の event 上限 1000** | `payloadSchema.events` は `z.array(eventSchema).max(1000)`(`ingest-review-events.ts:65`)。超えると 400 `invalid_payload` → `reachable:true, httpStatus:400` → `'permanent'` | pending は **session ごと**に分割送信されるため、1 session の event 数(= session_limit 既定 20 前後 × 回答回数)で頭打ち。1000 到達は現実的でない。ただし恒久失敗 event が同一 session に溜まり続ける経路では理屈上到達しうる |
| **Dexie の容量設計** | `answer_events` に削除経路が無く、synced も failed も永久残留(§1.2)。24h drop は「pending → failed」への遷移であって行数を減らさない | **容量観点では 24h drop は何も守っていない**ので、撤廃しても Dexie の増え方は変わらない |
| **server 側の保持設計** | `answer_events` / `reviews` に時間ベース掃除は無い(§1.2) | 影響なし |
| **`last_attempted_at`** | flush 試行ごとに打刻(`review-events.ts:173-178`)。**読む側が production コードに存在しない**(判定は `answered_at` 基準) | 撤廃しても未使用のまま。「最終試行基準の backoff / ops 通知」に使うなら読み手を新設する必要あり |

---

## 5. 順序ガードの挿入位置(③)

### 5.1 answered_at と card.last_review を比較できる位置

`processSession` の tx 内で、card 状態は **Phase 1 で `cardStateMap` に載っている**(`ingest-review-events.ts:109-129`、`lastReview: row.lastReview` を含む)。

現在の流れ:

```
109  cardRows = loadCardReplayStates(...)          // last_review 取得済
112-129 cardStateMap: Map<cardId, ReplayCardState>
134  admitEvents(events, cardOptionIdMap)          // card 状態を見ない
147  insertAnswerEvents(...)                       // 全 applicable を insert
168  groups = planReplay(applicable, insertedIds)  // ← card 状態を受け取らない
173  { finalStates, reviewRows } = replaySession(cardStateMap, groups)  // ← ここで初めて card 状態と合流
```

→ **比較可能な最初の位置は `replaySession`(`lib/reviews/domain/session-aggregate.ts:159-185`)**。`planReplay` に持ち込むなら `cardStateMap` を引数追加する必要がある(現シグネチャは `(applicable, insertedEventIds)`)。

**重要な設計制約**: gate は「初期 `lastReview` との 1 回比較」では足りない。`replayCard` は fold 中に `lastReview` を更新する(`lib/cards/replay-card.ts:104` `lastReview: next.last_review ?? now`)。同一 card の group 内に複数 event があるので、**fold の各ステップで「現在の folded lastReview」と比較する漸進的な gate** が要る。よって `replaySession` の per-card ループ内(:166-183)、あるいは `replayCard` 自体に gate を持ち込むのが自然な位置。

**null の扱い**: `cards.last_review` は nullable(未回答 card)。`ReplayCardState.lastReview: Date | null`。null は「常に適用」でなければ新規 card が一切進まなくなる。

**client クロック依存のリスク(材料)**: `answered_at` は client 供給で server 検証が無い(§1.1)。端末時計が未来にずれた 1 event が入ると `last_review` が未来値になり、**厳密 `>` gate では以降の正常 event がすべて「古い」と判定されて永久に適用されなくなる**。現状は gate が無いので「未来 due になる」だけで済んでいる。gate 導入時に併せて決める必要がある論点。

### 5.2 「適用しない event を reviews に記録する」場合の既存 tx への収まり

現 tx の write 4 種(`ingest-review-events.ts`):

| Phase | 呼び出し | 入力 | gate 導入時 |
|---|---|---|---|
| 2a `insertAnswerEvents`(:147) | `applicableEvents` 全件 | **変更不要**。gate は insert の後段なので、古い event も `answer_events` には残る(= 生ログとしては欠落しない) |
| 2d `insertReviews`(:181) | `reviewRows`(= `replaySession` の第 2 戻り値) | **`replaySession` が「適用した event の review 行」+「適用しなかった event の review 行」を両方 `reviewRows` に積めば、呼び側は無改変**。行の順序は「group 順」で最終結果に影響しないとコメント済(:175-176) |
| 2e `applyCardFinalStates`(:196) | `finalStates` | **変更不要**。gate で除外した event は fold に入らないので `finalStates` に反映されない。全 event が除外された card は `finalStates` に entry を作らないこと(作ると「変わっていない値で UPDATE」= `updated_at` bump → 無意味な pull 差分が出る) |
| 2f `upsertStudyDays`(:203-207) | `aggregateStudyDays(eventsToApply)` | **要決定**(§5.4) |

→ **`replaySession` の戻り値の意味を「fold した state」+「記録すべき review 行(適用可否を問わず)」に拡張すれば、orchestrator(`ingest-review-events.ts`)の構造は変えずに済む**。`eventsToApply`(:169)の定義だけが分岐点になる。

`reviews` に「適用されたか」を残す列は無い(§1.4)ので、**適用済み review と履歴のみ review が同じ表に混ざり、後から区別できない**。区別が要るなら reviews に列追加(= ④ の一部)。

### 5.3 同一 flush 内に新旧混在 event がある場合の現状挙動

- **`answered_at` でのソートは一切していない**。fold は **payload 順**(`planReplay` が payload 順で group 化・`session-aggregate.ts:142-148`、domain test `session-aggregate.test.ts:187,237` が「payload 順を保持する」を pin)。
- payload の順序は `getPendingAnswerEvents` の `where('sync_status').equals('pending').toArray()` 由来(`review-events.ts:143-146`)。IndexedDB は index key 同値内では primary key 順(`++local_id` = 挿入順)で返すため、**実運用上は回答順とほぼ一致する**。ただしこれは IndexedDB の仕様依存であって repo 内に pin する test は無い(**この点は repo 現物では未確認**)。
- したがって現状は「新旧混在があっても payload 順で素直に fold」。逆順の混在(古い event が後ろに来る)は、その古い event の `answered_at` で `last_review` が**巻き戻る**。

### 5.4 study_days 集計は適用外 event を数えるべきか(判断材料)

現状の意味論(`session-repository.ts:208-259` / `session-aggregate.ts:194-207`):

| 列 | 算出 | 出所 |
|---|---|---|
| `review_count` | `dayMap[day].total` を **`+` で加算**(`SUM increment`) | `aggregateStudyDays(eventsToApply)` = **apply した event 数** |
| `correct_count` | 同上、`rating >= 2` の件数 | 同上 |
| `distinct_card_count` | **`reviews` 表を SELECT し直して `COUNT(DISTINCT card_id)`** で**上書き**(`session-repository.ts:221-228,249,257`) | **reviews 表の実体**(day は `reviewed_at` の JST date) |

→ **非対称が既に存在する**: 前 2 者は「今回の flush で apply した event」の累積、3 つ目は「reviews 表の実体」。

**gate 導入時に自動的に起きること**: 適用外 event を `reviews` に insert すると、**`distinct_card_count` には自動で数えられる**(SELECT が拾う)一方、`review_count` / `correct_count` は `aggregateStudyDays` の入力次第。何もしなければ**両者がズレる**。

判断の軸:
- `study_days` の消費先は dashboard の streak / 今日の枚数(`lib/db/streak.ts:10-14`「その日 1 回でも rate された card 数」)と Dexie mirror(`lib/sync/study-days.ts`)。**ユーザーから見て「その日に答えた」記録**であって「FSRS に効いた」記録ではない。
- 24h を撤廃する目的が「オフライン中の回答を失わない」なら、**学習記録(streak)としては数えるのが目的に整合**。一方 scheduling に効かないものを「復習した」と数えるのは、FSRS の内部整合とは別問題として切り分けられる。
- どちらに倒すにせよ、`review_count`/`correct_count` と `distinct_card_count` の**片方だけが変わる**のを避ける必要がある(現状すでにズレうる構造なので、gate で顕在化する)。

---

## 6. 波及確認

### 6.1 影響を受ける既存 test の当たり

| test | 行数 | ①(直列化) | ②(double) | ③(24h+順序) |
|---|---|---|---|---|
| `app/api/review-events/bulk/route.test.ts` | 1789 | 中(fake tx が `.for('update')` / `execute` 追加を通す形か要確認。§6.2) | 小(`::real` は文字列として assert していない) | **大**(replay 挙動の goldens が中心) |
| `tests/contract/review-events-bulk.contract.test.ts` | 628 | 同上 | 小 | **大** |
| `tests/fixtures/review-events.ts` | 564 | **要改修**: `makeFakeTx` の `select` chain は `.from().where()` で終端(:285-290)。`.for('update')` を足すと **chain が伸びて fake が壊れる** | 小(`VALUES_COLS_PER_ROW = 14` は列数であって型ではないので不変) | 小〜中(payload factory は不変、goldens 側が動く) |
| `lib/reviews/session-repository.test.ts` | 491 | **中**(SQL 構造 pin) | **小**(`::real` を pin していれば要更新 — 要現物確認) | 小 |
| `lib/reviews/domain/session-aggregate.test.ts` | 299 | 無 | 無 | **大**(`planReplay` / `replaySession` / `aggregateStudyDays` が gate 対象) |
| `lib/cards/replay-card.test.ts` | 134 | 無 | 無 | **中**(gate を `replayCard` に持ち込む場合) |
| `lib/sync/review-events.test.ts` | 926 | **中**(候補 (c) なら `flushAllPendingEvents` の並列 assert が動く) | 無 | **大**(`dropStalePendingAnswerEvents` の boundary / 戻り値 test 群 = :862,895,918 付近) |
| `lib/sync/review-flush.test.ts` | 351 | 中 | 無 | 小 |
| `app/(app)/app/_components/review-flush-trigger.test.tsx` | 99 | 無 | 無 | **大**(mount で drop→kick を pin している。:17,26 の `mockDropStale`) |
| `app/(app)/app/study/smart/_components/session-runner.test.tsx` | — | **中**(入口 B/C を lock 経由に寄せる場合) | 無 | 小 |
| **iso** `tests/integration/pg/write-isolation.test.ts:156-205` | — | **中**(`applyCardFinalStates` を実 PG で叩く唯一の test。並走 test を足すならここが土台) | **小**(`expect(rows[0]?.stability).toBeCloseTo(5.5)` = 既定精度 2 桁なので real→double で落ちない) | 無 |
| **iso** `tests/integration/pg/rls-wave1.test.ts` / `rls-cascade.test.ts` | — | 無 | 無 | 無(answer_events の RLS / cascade のみ) |

**`processSession` 全体を実 PG で叩く iso test は存在しない**(`tests/integration/pg/` に `processSession` の import は無い。`COVERAGE.md:29` は経路 6 を「IN / YES(W1/W2)」としているが、実体は `applyCardFinalStates` と `upsertSessionGuarded` の単体 pin)。
→ **① の lost update / ③ の順序逆転を behavioral に実証するには、iso に新規 test(2 接続同時 flush)が要る**。既存 harness(`asTenant` / 2 テナント fixture)はそのまま使えるが、**同一 user・2 接続の同時実行 helper は無い**(`submit-upload.test.ts:12` が advisory lock の同時競合を「していない」と自認しているのと同じ空白)。

### 6.2 fake tx の構造依存(実装時の落とし穴)

`tests/fixtures/review-events.ts:285-290` の select fake:

```ts
const selectChain = { from: (_t) => ({ where: (_c) => Promise.resolve([...state.cardRows.values()]) }) }
```

`where()` が **Promise を直接返す**ため、`.for('update')` や `.orderBy(...)` を実装に足すと **contract test / route test が一斉に落ちる**(型ではなく実行時)。① を (a) 行ロックで実装する場合、この fixture の改修が最初の作業になる。`tx.execute` は既に fake にある(:379-386)ので、(b) advisory lock 案なら `executeCallCount` / `executeCalls` の既存 assert(distinct 集計 SELECT の回数を数えている箇所)が動く可能性がある — **要現物確認**。

### 6.3 architecture.md / harness.md との矛盾

| doc | 記述 | ①②③ での扱い |
|---|---|---|
| `docs/architecture.md:17`(§1) | 「server 反映は 3 系統(… / review-events bulk / …)」 | **矛盾しない**(並列性に言及していない) |
| `docs/architecture.md:37`(§2 cascade 用語分離) | 「reviews / answer_events は cards cascade で連鎖」 | ④ で `reviews` に列を足しても**矛盾しない** |
| `docs/architecture.md:168-181`(証明の空白) | 現在 7 項目。**review-events の並走・順序に関する項目は無い** | **要追記**。① を入れずに ②③ だけやると「同一 card の並走で lost update しうる」が空白として残る。① を入れても「実 PG での並走実証」が無ければ空白として書くべき |
| `docs/harness.md` | review-events / FSRS への言及なし。§1 の機械一覧に該当項目なし | **矛盾しない**。① を lint/test で機械化するなら §1 に 1 行追加が要る |
| `docs/audit/2026-07-26-h0-part2-architecture-invariants.md` A4 / §「transport 制約」 | 「review-events は session 別に**並列**」 | **① の候補 (c) を採ると事実が変わる**。ただしこの doc は 2026-07-26 時点の棚卸し(audit)であり architecture.md のような恒久正本ではない。architecture.md 側に並列の記述が無いため、**正本の書き換えは不要 / audit doc は当時の記録として据え置き**が素直(要 OT 確認) |
| `docs/audit/2026-06-12-repo-wide-audit.md:85,409` | entity-mutations の 24h 自動 failed 隔離を P1 で「撤去すべき」と指摘し、30d 延長で決着 | **③ は同じ指摘の review-events 版**。撤廃の前例と根拠が既に repo 内にある |
| `docs/02-tech-spec.md` §14.7.1 / §14.9 | flush 契機(pending 5 件 / session 終了 / ネット復活 / 起動・復帰)と answer_events の定義。24h drop の記述は grep で無し | **矛盾しない** |
| `CLAUDE.md`「Sprint 完了 gate」 | `pnpm test:iso` 無条件 green | ①③ で iso を足す場合、そこに載る |

---

## 7. 未確認(この fact-finding で確かめていないこと)

- stg / prod の `cards` 実行数と `ALTER COLUMN TYPE` の所要時間・ロック時間(② の運用影響)。
- 単精度による FSRS 値のドリフトが実データでどの程度出ているか(② の効果量)。
- 並走 flush による lost update が実際に起きた形跡(telemetry / log)。`review_events.bulk.*` の logger 出力は残るが、lost update は成功扱いなので**ログには出ない**。
- `lib/reviews/session-repository.test.ts` が `::real` 文字列を pin しているか(§6.1 で「要現物確認」とした箇所)。
- `route.test.ts` / contract test の `executeCalls` assert が advisory lock 追加で壊れるか(§6.2)。
- IndexedDB の「index key 同値内は primary key 順」を pin する test の有無(§5.3)。repo 内に該当 test は見つからなかったが、網羅的に探索していない。
