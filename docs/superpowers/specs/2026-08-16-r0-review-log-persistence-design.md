# R0: ReviewLog 持続化 design spec

- 日付: 2026-08-16 / 状態: **凍結(r2)**(2026-08-16 OT 裁定 — §12 の 4 論点 + r2 訂正 1 点、計 5 点確定。以後実装フェーズで書き換えない)
- **r2 訂正(2026-08-16・同日)**: R0 最終 review で **Critical** 検出 — `due_before` に ReviewLog の `due` field を verbatim 保存すると、2 回目以降の全 review で「適用前 due」ではなく「前回 review 時刻」が保存される(ts-fsrs `buildLog()` の実装起因、詳細は §3.1 訂正箇所 + §12-5)。§3.1 の `due_before` 行と総括文、§12 に裁定を追記して訂正する。他 field への影響なし。
- 前提 fact-finding: `docs/superpowers/sessions/2026-08-16-dashboard-track-factfinding.md` §11(生成点・挿入点の現物確認。本 spec はこれを正とする)
- kickoff 確定決定 8 項(claude.ai 2026-08-16)を全て引き継ぐ。逸脱は §12 論点に明示。

## 1. 目的と非目標

ts-fsrs が answer 適用時に生成する `ReviewLog` を server 新テーブル `review_logs` に永続化し、L4 分析データ(True Retention 厳密版・校正曲線・将来のパラメタ最適化)の蓄積を開始する。「今日記録しないものは永久欠損」が唯一の先行理由。**本 sprint は蓄積のみ** — 消費 UI・分析 endpoint・読み経路は一切作らない。

非目標(scope 外): 消費 UI / 分析 endpoint(Dash-3)/ パラメタ最適化 / answer_events・wire schema・client(Dexie 含む)の一切 / 保持データの削除・訂正(answer_events の同 follow-up と同枠)。

## 2. 不変条件(Sprint A 凍結契約は不触)

- answer_events が SOT / 受理 = synced が唯一の終端 / 冪等 2 段(payload 内 dedupe + `onConflictDoNothing`)/ `>=` 順序ガード / FOR UPDATE 直列化 — **全て不変**。
- review_logs は answer_events を置換も拡張もしない。**別テーブルへの追記のみ**。wire 変更ゼロ・client 変更ゼロ(zod 追加も不要 — server 内部で完結)。
- log の生成点 = server fold 内の ts-fsrs `rate()` 戻り値(`RecordLogItem.log`)。現在 `.card` のみ取得し log を捨てている(`lib/cards/replay-card.ts:73`)。applied=false の event(card_not_locked / unknown_option / 順序ガード skip)の log は**記録しない**(そもそも rate() が呼ばれない)。

## 3. テーブル設計 `review_logs`

### 3.1 列と ts-fsrs `ReviewLog`(v5.4.1)対応表

| 列 | 型 | 制約 | ReviewLog field | 備考 |
|---|---|---|---|---|
| `event_id` | uuid | **PK**, FK → `answer_events(event_id)` ON DELETE CASCADE | — | 冪等キー = answer_events PK と 1:1(§4) |
| `user_id` | uuid | NOT NULL, FK → `users(id)` ON DELETE CASCADE | — | 全表 user_id 必須規約 + RLS 述語 |
| `card_id` | uuid | NOT NULL, **FK なし** | — | answer_events と同じ dangling 正規(card 削除後も履歴は残る) |
| `rating` | integer | NOT NULL, CHECK 1..4 | `rating` | grade 経路では Manual=0 は構造的に不可 |
| `state_before` | integer | NOT NULL, CHECK 0..3 | `state` | 適用前 state |
| `due_before` | timestamptz | NOT NULL | fold `dueBefore`(**`due` ではない — r2 訂正**) | 適用前 due(True Retention の「期限到来していたか」判定)。出所 = fold 適用前の `card.due` スナップショット(`replayCard()` 直前の `current.due` を退避)。ReviewLog の `due` field は使わない(理由は表下の r2 注記) |
| `stability_before` | double precision | NOT NULL | `stability` | |
| `difficulty_before` | double precision | NOT NULL | `difficulty` | |
| `elapsed_days` | integer | NOT NULL | `elapsed_days` | ts-fsrs v6 で削除予定(@deprecated)。本 sprint は verbatim 保存(NOT NULL)。v6 移行時の扱い(算出継続 / 列 deprecate)はその移行 spec で再裁定(§12-3) |
| `last_elapsed_days` | integer | NOT NULL | `last_elapsed_days` | 同上 deprecated。前回 review の elapsed。チェーン再構成では R0 稼働前の境界が欠損するため verbatim 保存。v6 移行時の扱いも同上再裁定 |
| `scheduled_days` | integer | NOT NULL | `scheduled_days` | 適用前の予定間隔 |
| `learning_steps` | integer | NOT NULL | `learning_steps` | |
| `review` | timestamptz | NOT NULL | `review` | = clamp 済 `answeredAt`(rate() に渡した now がそのまま返る) |
| `state_after` | integer | NOT NULL, CHECK 0..3 | —(`RecordLogItem.card.state`) | 適用後(§3.3) |
| `stability_after` | double precision | NOT NULL | —(同 `.card.stability`) | |
| `difficulty_after` | double precision | NOT NULL | —(同 `.card.difficulty`) | |
| `created_at` | timestamptz | NOT NULL | — | = `receivedAt`(answer_events.created_at と同一時刻源、app 層明示 set。DB now() 不使用も同方針) |

ReviewLog **9** field(`due` を除く)を verbatim + `due_before`(fold 由来・ReviewLog 非経由)+ 適用後 3 値 + 帰属 3 列 + created_at。session_id / is_correct / elapsed_ms / applied は**持たない**(event_id JOIN で answer_events から取れる値を二重化しない。card_id のみ「card 削除後も JOIN なしで per-card 系列を引ける」ため例外的に持つ — kickoff 指定列)。

**r2 注記(`due_before` の出所訂正)**: ts-fsrs の `buildLog()`(`node_modules/ts-fsrs/dist/index.cjs`)は `due` field に `last_review || due` を返す実装になっている。したがって 2 回目以降の全 review(`last_review` が non-null)では ReviewLog.due は「適用前 due」ではなく「前回 review 時刻」になり、当初案(ReviewLog.due を verbatim 保存)は誤りだった。とりわけ learning / relearning 行では `scheduled_days = 0` により日単位の復元も不能で、完全に情報が失われる。一方、前回 review 時刻は保持済みの answer event / review 時系列から導出可能な値である。したがって R0 が優先して保存すべき「復元不能な情報」は ReviewLog.due ではなく**適用前 `card.due`** であり、これを fold 側(`replayCard()` 呼出直前の `current.due`)から直接退避して `due_before` に保存する。verbatim 原則は他の field(rating / state / stability / difficulty / elapsed_days / last_elapsed_days / scheduled_days / learning_steps / review の 9 field)では維持する。

### 3.2 CHECK / index / 命名

- CHECK 3 本(Sprint B 命名規約 `<table>_<column>_<kind>`): `review_logs_rating_range` / `review_logs_state_before_range` / `review_logs_state_after_range`。stability 等の数値域 CHECK は張らない(cards と同じ非採用判断 — 値の正当性は ts-fsrs 出力で、DB 側 typo 防御の価値がない)。
- **index は PK のみ。追加ゼロ**(kickoff 決定 4)。user_id index も張らない: 読み手ゼロ / users は soft delete のみで user_id cascade は発火しない / answer_events から の cascade は PK lookup。必要時に CREATE INDEX 一発(answer_events.card_id と同じ裁定)。最初の消費者 = Dash-3(実測保持率・校正曲線)で、読み取り index はその spec で追加する — PK のみは意図的。
- drizzle export 名 `reviewLogs`。

### 3.3 after 3 値を持つ理由(導出可能性との突合)

after は「同 card の次 log 行の before」+ 最終行は cards 現在行、で原理上導出できる。ただし同時刻 event(`>=` ガードは同時刻を適用する)ではチェーンの順序が answered_at だけでは一意にならず、導出が曖昧になる。分析データの完全性を再構成アルゴリズムに依存させないため 3 列で持つ(kickoff の「stability/difficulty の前後・state 遷移」指定どおり)。

## 4. 冪等設計(Sprint A の 2 段とどう連動するか)

log INSERT の対象は `appliedEventIds`(⊆ 当該 tx で**新規 INSERT** された event)のみ。既存 2 段がそのまま log の冪等を含意する:

1. payload 内重複 → 手順 1 の dedupe Map で 1 件化(`ingest-review-events.ts:58-73`)。
2. 再送(過去 tx で insert 済) → `onConflictDoNothing` で `insertedEventIds` に入らない → `newRows` に入らない → fold 対象外 → log 対象外(`ingest-review-events.ts:136,162`)。

よって「同一 event の再適用」は**構造的に不存在**であり、log の INSERT は plain INSERT(onConflict なし)とする。PK(event_id) は backstop で、23505 発火 = fold 二重適用という上流バグの loud 検出。onConflictDoNothing にしない理由: 静かに握ると上流バグを隠す(loud fail 方針)。FK(event_id → answer_events)は手順 4 の event INSERT が先行するため常に充足。

## 5. 書込パス(fold 統合点 — fact-finding §11 の 3 点)

同一 tx(`withTenantTx`)内の既存 9 手順に「手順 7.5」を挿入する。変更 4 file:

1. **`lib/cards/replay-card.ts`** — `replayCard` の戻り値を `{ state: ReplayCardState, logs: FsrsReviewLog[] }` に拡張(events と同 index 対応)。`rate()` の戻り `RecordLogItem` から `.card` に加え `.log` を回収するだけ。ts-fsrs `ReviewLog` は type import(runtime import は既存の `rate` 経由のみ、pure 維持)。production caller は foldSession 1 箇所。
2. **`lib/reviews/domain/session-aggregate.ts`** — `foldSession` の戻り値に `appliedLogs: AppliedReviewLog[]` を追加。`AppliedReviewLog = { eventId, cardId, log: FsrsReviewLog, after: { state, stability, difficulty } }`。replayCard 呼出直後の `current` が after(1 呼出 1 event なので 1:1)。skip された event は現行どおり appliedEventIds にも appliedLogs にも入らない。
3. **`lib/reviews/session-repository.ts`** — `insertReviewLogs(tx, userId, rows)` 新設。**bulk INSERT 1 statement**(≤1000 行 / flush)。plain insert(§4)。
4. **`lib/reviews/ingest-review-events.ts`** — `markApplied`(手順 7)の直後・`recomputeStudyDays`(手順 8)の前に `insertReviewLogs` を呼ぶ。`user_id` は `user.id`、`created_at` は `receivedAt` を row に展開。

## 6. 同一 tx 性と失敗設計(kickoff 決定 3 の設計判断)

**書込失敗は answer 適用ごと tx rollback に倒す(= 落とす)。**

- 不変条件「applied ⟺ log が存在する」は同一 tx の原子性でしか成立しない(決定 3 前段の「適用されたのに log が無い、を作らない」)。別 tx / best-effort はこの不変条件を放棄することと等価なので採らない。
- Sprint A の全受理設計との整合: 「受理可能な event は全て insert し 200」は **tx が成功した場合の応答契約**であり、tx throw は既存でも透過して route の `classifyBulkError` が 503/400 に分岐する(`ingest-review-events.ts` 冒頭 comment、`recomputeStudyDays` の lock-mismatch throw と同型)。transient(接続断・deadlock)は 503 → client の pending 保持 + backoff 再送で自然回復。**新しい失敗クラスを追加するのではなく、既存の tx 失敗クラスに 1 statement 加わるだけ**。
- 恒久失敗(review_logs の schema 破壊等)は復習 ingest 全停止になる。これは「分析データの静かな永久欠損」より「loud な可用性障害」を選ぶ意図的トレード。リスク実体は小さい: 列は全 NOT NULL で値は app 層が全て供給、CHECK は enum 域 3 本のみ、FK は §4 で構造充足。

## 7. migration / RLS / grants / deploy 順

- **migration 1 本(0039)**: CREATE TABLE + FK 2 本 + CHECK 3 本。index 追加なし。既存データ移行なし(ユーザー 0・decision 8)。
- **RLS は `db/policies/` の versioned SQL**(P2 §2.9 規約・②-4a 前例踏襲 — kickoff 決定 7 の「migration 1 本に RLS 込み」からの逸脱、§12-1 論点): `r0-review-logs-enable.sql` / `-disable.sql` の対を新設。共通形 1 policy(`review_logs_tenant` FOR ALL TO recallmint_app、USING = WITH CHECK = `user_id = (SELECT app_current_user_id())`)。`tests/integration/pg/setup/global-setup.ts` の適用列に登録。
- **grants: 変更不要** — `db/roles/recallmint_app-grants.sql` の `ALTER DEFAULT PRIVILEGES` が新表を自動被覆(wave1 comment の既存規約)。
- **期待カタログ更新**: `scripts/verify-rls-state.ts` の `COMMON_FORM_RLS_TABLES` に +1(EXPECTED_RLS_TABLES 18→19 / EXPECTED_POLICIES 20→21 / EXPECTED_GRANTS は自動)。`tests/integration/pg/rls-drift.test.ts:84-86` の件数 assert を追随。
- **deploy 順: migrate 先行 → policies enable(同一メンテ窓・無防備窓を作らない)→ code deploy**。旧 code は新表に触れないため additive(decision 8)。stg には未適用スタック 0036-0038 が積まれている — 0039 はその後続として通常の適用順に乗る。prod は operator 手動適用(既存 runbook)。

## 8. 退会 scrub 整合(kickoff 決定 6 の確認結果)

**Group II になる(handler 変更不要)。** Group I 判定式(`app/api/webhooks/clerk/route.test.ts` の invariant): 「user_id direct cascade FK を持ち、かつ他 FK に user cascade chain を持つ cascade 親がない」。review_logs は `event_id` FK(cascade)の親 answer_events が user_id direct cascade を持つため **親 chain あり = Group II**。退会時は handler の既存 `tx.delete(answerEvents)`(`handle-clerk-event.ts:276`)の cascade で連鎖削除される。invariant test は schema から機械算出するため、**無変更で green のまま**(= 分類の実証になる)。answer_events と「同じ Group」ではない(answer_events は Group I)が、削除の実行点は同じ 1 文に収束する。

## 9. 保持ポリシーと容量見積り

- **保持: 無期限**(削除・訂正は scope 外 = answer_events follow-up と同枠。退会 scrub のみが削除経路)。
- 行サイズ ≈ 180B heap + PK index ≈ 計 220–250B/行。**1 ユーザー 1 日 100 event → 36,500 行/年 ≈ 8–9 MB/年/user**(index 込)。100 active users で ~0.9 GB/年、1,000 で ~9 GB/年。answer_events(同数の行が既に無期限蓄積)と同オーダーであり、tiering 判断が必要になる規模になったら follow-up(claude.ai todo)で扱う。

## 10. 性能

- 増分 = flush 1 回につき bulk INSERT **1 statement**(≤1000 行)。ロック追加なし・index 1 本(PK)のみ。
- Sprint A 実測基準 = **1000 event flush 110ms**(local PG・`docs/superpowers/sessions/2026-08-12-fsrs-consistency-sprint-a.md` §6.1)。予想増分 +5〜10ms。**許容劣化 = 同一ハーネス再計測で +20%(≈132ms)以内**。超過したら chat 報告(gate にはしない — Sprint A と同方針、log 出力のみ)。実測値は session doc に記録。

## 11. テスト戦略(gate は既存どおり)

**iso(実 PG、新 file `tests/integration/pg/review-logs.test.ts`)**:
1. 適用 1 event = log **ちょうど 1 行**。before 3 値 = seed した cards 値、after 3 値 = 適用後 cards 行、`review` = clamp 済 answered_at、`rating` = event 値。
2. 同一 payload 再送 → 行数不変(冪等 pin)。
3. applied=false の 3 経路(card_not_locked / unknown_option / `>=` 順序ガード skip)→ log 0 行。
4. 同 card 複数 event 1 payload → event ごとに 1 行、before/after が連鎖(row n の after = row n+1 の before)。
5. schema contract readback: PK + FK 2 本(cascade 込み)+ CHECK 3 本を定義文まで pin(answer-events-serialization の同型 describe)。
6. RLS: rls-drift のカタログ突合が自動被覆(§7 の期待カタログ更新後)。

**unit**:
- `replay-card.test.ts`: logs が events と同数 / `log.review` = answeredAt / 空 events で logs 空。
- `session-aggregate.test.ts`: appliedLogs の eventId 集合 = appliedEventIds / skip event は appliedLogs に出ない / after 値 = 直後の fold 状態。
- ingest 単体: `insertReviewLogs` が **withTenantTx の tx オブジェクトで**呼ばれる(同一 tx 性の pin — tx identity assert)。

**red 変異**(working tree のみ・commit message に「red 検証」記録):
- ① `insertReviewLogs` 呼出を削除 → iso #1 fail。
- ② logs を appliedLogs でなく全 newRows から構築する変異 → iso #3 fail。
- ③ `insertReviewLogs` を tx 外(別接続)へ移す変異 → unit の tx-identity pin fail(iso での tx abort 決定化は困難のため、同一 tx 性の pin は unit 側を正とする)。

**既存 gate への波及(plan で task 化)**: `tests/integration/pg/setup/completeness.ts` EXPECTED_USER_ID_TABLES 19→20 / `setup/fixture.ts` seedTwoTenants に A/B 各 1 行(親 answer_events 込み)+ truncate 追随 / `scripts/verify-rls-state.ts` + rls-drift 件数 / global-setup への policy file 登録 / COVERAGE.md 追記。clerk route.test の Group invariant は**無変更 green を確認**(§8)。sprint 完了 gate = whole-repo lint / test:iso / pnpm run audit(全 exit 0、既存どおり)。

## 12. 論点と裁定(2026-08-16 OT 裁定・全 4 点確定)

1. **RLS の置き場** — **裁定: 規約踏襲**(migration = table + CHECK、RLS = db/policies/ 対 file)。kickoff 決定 7 の「migration 1 本に RLS 込み」はここで上書き。根拠 = policy は drizzle migration にしない規約(P2 §2.9)・②-4a の新表 3 表前例・iso global-setup の適用順序モデル(migrate → grants → policies)との二重化回避。
2. **after 3 列の保持**(§3.3)— **裁定: 保持**。導出可能性はあるが同時刻 event で曖昧化するため。
3. **deprecated 2 列(elapsed_days / last_elapsed_days)** — **裁定: 両列とも verbatim 保存(NOT NULL)**。「今日記録しないものは永久欠損」の premise 優先・int 2 列のコストは無視できる。**ts-fsrs v6 移行時の扱い(算出継続 / 列 deprecate)はその移行 spec で再裁定する**(本 spec は将来の裁定を先取りしない)。
4. **event_id FK(→ answer_events)** — **裁定: 採用**。scrub が Group II 自動化(§8)・参照整合が DB 保証。代替(FK なし・Group I)は handler + invariant test 更新が増えるだけで利点がない。
5. **`due_before` の保存元(r2・review 実施後の Critical fix)** — **裁定: (A) fold が保持する適用前 `card.due` を保存する**(ReviewLog の `due` field は使わない)。根拠 = ts-fsrs `buildLog()` が `due` に `last_review || due` を返す(dist 実装確認済)ため、2 回目以降の review では ReviewLog.due が「適用前 due」ではなく「前回 review 時刻」になり、learning / relearning 行(`scheduled_days = 0`)では日単位の復元すら不能になることが実証された。一方、前回 review 時刻は保持済みの answer event / review 時系列から導出可能である。したがって R0 が優先して保存すべき「復元不能な情報」は適用前 `card.due` であり、これを fold 側で保持して verbatim 原則の例外として直接保存する。他 field の verbatim 原則は維持。

## 13. 完了条件(sprint として)

- migration 0039 + policy 対 file + 実装 4 file + §11 テスト一式が green、red 変異 3 種の実証記録、性能再計測値の記録、期待カタログ/fixture 更新、whole-repo lint / test:iso / audit 全 exit 0、feat commit は canonical + Codex 並列 review で Critical/Important 0 → `[reviewed]`。
