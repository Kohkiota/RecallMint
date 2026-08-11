# FSRS 整合 Sprint A — 設計 spec(r4・確定)

- 状態: **確定・凍結**(r3 = OT 条件付き承認 3 点を反映 / **r4 = plan 段階 Codex cross-check 由来の 2 点を OT 裁定で amend** — §5 の day 行ロック追加・§2.1 の tx throw 分類。以後の仕様変更は停止して OT 相談)。実装 plan = `docs/superpowers/plans/2026-08-11-fsrs-consistency-sprint-a.md`。
- 事実基盤: `docs/audit/2026-08-11-fsrs-consistency-factfinding.md`(第 1 弾)/ `2026-08-11-review-domain-schema-inventory.md`(第 2 弾)/ `2026-08-11-db-schema-full-inventory.md`(第 3 弾)。commit `1906c71`。
- Codex cross-check: `docs/codex/2026-08-11-plan-fsrs-sprint-a-spec.md`(1 パス)。r1→r2 の変更は Codex 指摘由来を「(Codex #n)」で帰属表示。
- 前提: ユーザー 0(stg/prod とも実データ保護不要)。互換レイヤー・backfill なしでクリーン形へ直行(§10)。
- OT 裁定済み確定事項 11 項(kickoff brief)に従う。裁定の実現形を変える提案・乖離は §12 に集約。

## 0. 目的と「正本」の意味の限定

復習イベントの正本を answer_events 1 表に一本化し、同一 card への FSRS 適用を DB 行ロックで直列化、時系列逆転 event を順序ガードで隔離する。reviews / study_sessions は廃止。24h drop・二重実装(streak / JST / 初期値)・正誤二義性を同時に解消する。

**正本の意味(Codex 独立 3 / 指摘 8,9,26 を受けて限定・r3 で明確化)**: answer_events が保証するのは 2 点のみ — **① 入力の監査可能性**(全回答 event の恒久記録)と **② 現行コードによる再計算可能性**。cards の **bit-exact な過去再現(決定的 rebuild)は保証しない**。崩れる要因は同時刻 event の適用順(= §2.4 のロック取得順)だけでなく、**scheduler(ts-fsrs)の版・パラメータ・ライブラリ更新**が含まれる — つまり同時刻が絡まない普通の履歴でも、コードが更新されれば過去状態の bit-exact 再現は不能になる。rebuild コマンドは非スコープ(§11)。ReviewLog スナップショット不採用の裁定はこの限定の上で成立する。

---

## 1. 新 schema

### 1.1 answer_events(全面再定義・唯一の復習正本)

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| event_id | uuid | **PK**(client 採番) | surrogate `id` 廃止。冪等キーと PK を一本化 |
| user_id | uuid | NOT NULL・FK → users **CASCADE** | 実削除は退会 handler の明示 DELETE(§8。CASCADE は users soft-delete で不発 — 第 3 弾 §8-1 どおり宣言のみ) |
| card_id | uuid | NOT NULL・**FK なし** | dangling を正規状態とする(学習履歴はユーザー帰属 — 従来 CASCADE 設計の意図的 override) |
| session_id | uuid | NULL・FK なし | ラベル。client 採番 uuid をそのまま保存(§4.4) |
| selected_answer_ids | jsonb | NOT NULL default `[]` | zod max 50(既存 bound 維持) |
| is_correct | boolean | NOT NULL | client 判定(選択肢一致)。統計・フィルタの正誤定義(§6) |
| rating | integer | NOT NULL・**CHECK (rating BETWEEN 1 AND 4)** | scheduling の正誤定義。**required 化 = P0 §A#7 deriveRating 凍結契約の改定**(現 client は常に明示送信 — 第 2 弾 §2.2。fallback 削除) |
| answered_at | timestamptz | NOT NULL・**CHECK (answered_at <= created_at)** | **clamp 済み値を保存**(§2.3)。raw は保存しない = 端末時計異常の事後調査能力を warn ログ以外は意識的に捨てる(Codex 独立 8 — 決定として明記) |
| elapsed_ms | integer | NULL・CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0) | 配線して実測を埋める(§4.5)。計測不能時のみ NULL |
| applied | boolean | NOT NULL | 順序ガードの結果(§2.4)。**ingest 時点の判定・以後不変**: 再評価・後変更はしない。card 不在で false になった event は同 uuid の card が後から現れても再評価しない(Codex 独立 2 — 契約化) |
| created_at | timestamptz | NOT NULL | **server 受信時刻を app 層で明示 set**(採取点は §2.3 で固定。DB now() 打刻規約からの意図的逸脱 — clamp 上界と同一時刻源にして CHECK を厳密化) |

- index: **`(user_id, answered_at)` のみ**。card_id 系 index は**意識的に張らない**(現読み手ゼロ + YAGNI。追加トリガー = card 単位履歴 UI か運用調査の実需。必要時に CREATE INDEX 一発 — Codex 独立 16 / 指摘 12 への応答として明文化)。
- server 側 `sync_status` 廃止(単一値固定の死列 — 第 2 弾 §6-5)。

### 1.2 reviews / study_sessions — **廃止(DROP)**

- reviews: rating は answer_events に統合。唯一の読み手(study_days distinct 集計 — 第 2 弾 §2.3)は §5 の再集計へ差し替え。
- study_sessions: server 読み手ゼロ・completed 不達・abandoned 到達不能(第 2 弾 §3.2)。表・Dexie store・upsertSessionGuarded・session-values.ts(canApplyStatusWrite)・route Phase 0 を全て撤去。mode は保存しない(裁定)。

### 1.3 cards(FSRS 関連のみ)

- `stability` / `difficulty`: real → **double precision**。書込側 `::real` cast(session-repository.ts:146)を `::double precision` へ(第 1 弾 §3.4 の 3 点セット)。
- `state`: **CHECK (state BETWEEN 0 AND 3)** 追加。
- FSRS 列(due〜last_review + answered / last_correct / current_streak)の **DB default 撤去**。初期値は pure 関数 1 定義から全 insert 経路が明示 set(§7.1)。
- 分離しない(FSRS 状態は cards の列のまま — 裁定)。

### 1.4 study_days

- 列構造不変。書込意味論のみ変更(§5)。migration で TRUNCATE(§10)。

---

## 2. server ingest 新形(`POST /api/review-events/bulk`)

### 2.1 wire(応答の整理 — Codex 独立 6 / 指摘 5 を受けて単純化)

```
req:  { events: AnswerEventIn[] }            // session オブジェクト廃止。max 1000
event: { event_id, card_id, session_id?, selected_answer_ids, is_correct,
         rating(1|2|3|4 必須), answered_at(iso), elapsed_ms?(int 0..86_400_000) }
res:
  200 { ok: true, failed: string[] }  // 200 = failed に無い event は保存確定(synced 化可)。
                                      // failed = event_id 衝突(所有権 or 内容不一致・§2.2 手順 4)。
                                      // client は受領時に 'failed' へ terminal 化(§3)
  400                                  // schema 不正(client 送信前検証の突破 = client/server 不一致バグ)
  503 + Retry-After / 400              // tx throw は classifyBulkError で分類(r4):
                                       //   transient(DB conflict / lock timeout / connection / unknown)
                                       //     → 503 + Retry-After(全体再送)
                                       //   permanent-4xx(CHECK 違反・SQL shape 不良など実装/データ欠陥)
                                       //     → 400(client は再送しない = 恒久バグの無限 retry を作らない)
                                       // 旧「200 + 全件 failed」は廃止
  401 / 429                            // 既存どおり
```

単一 tx で全部か無かになったため「200 なのに何も保存されていない」形(旧 wire)を廃し、transient は HTTP 層(503)へ寄せる。client の classifyFlushResults は httpStatus ベースで現行のまま適合。

### 2.2 処理順(単一 withTenantTx)

1. zod parse(400 は request 単位)。payload 内 event_id 重複は**先勝ち dedupe**(内容不一致の重複は logger.warn 1 行 — 監査痕跡。Codex 指摘 7)。
2. **clamp**(§2.3)→ 各 event の実効 answered_at 確定。
3. distinct card_id を **ID 昇順ソート → `SELECT … WHERE user_id = ? AND id IN (…) ORDER BY id FOR UPDATE`**(直列化。複数行ロックの順序規律は publish-prepared.ts:153 の既存規律に従う。owner-scope により不在・他人 card は返らない)。ロック範囲の意味論(Codex 独立 7): card 削除・entity-mutation の同一行更新とは行ロックで相互直列化(先行した方が勝ち、削除が先なら該当 event は card-less として applied=false)。
4. **全 event を INSERT**(applied=false・ON CONFLICT (event_id) DO NOTHING・RETURNING で新規集合)。**非新規 event_id は 2 段検証**(Codex 独立 4 / 指摘 6 — r3 で内容一致検証を追加):
   - **所有権**: 既存行の user_id ≠ 自分 → failed[] + logger.warn(uuid 衝突 or 先取り攻撃の観測点)。
   - **内容一致(immutable fields 照合)**: 自分の既存行に対し card_id / selected_answer_ids / is_correct / rating / answered_at / session_id / elapsed_ms を照合。**answered_at の比較基準 = `min(再送 raw answered_at, 既存行 created_at)` と既存行 answered_at の一致**(= 初回 insert と同じ clamp 式を既存行の受信時刻で再評価する。正当な再送は raw が同一なので必ず一致し、初回に clamp された event の再送が受信時刻の差で偽陽性 mismatch になる罠を避ける)。一致 = 正当な再送(200・synced 化)/ **不一致 = failed[] + logger.warn**(既存行は不変 — 先勝ち immutable)。
   - failed[] を受けた event の client 側処理は §3(terminal 化)。
5. fold 対象 = 新規 ∧ card ロック済み ∧ A-2(option 実在)pass。per-card group を **answered_at 昇順 stable sort(同時刻は payload 順)** で fold:
   - 適用条件(順序ガード・漸進比較): `current.lastReview === null || ev.answered_at >= current.lastReview`
   - 適用 → `rate()` で state 前進 + applied 集合へ / 不適用(厳密に古い)→ skip(applied=false のまま)
6. cards UPDATE(既存 VALUES join・count-mismatch throw 維持・`::double precision`)。
7. `UPDATE answer_events SET applied = true WHERE event_id IN (applied 集合)`。
8. study_days 再集計(§5)。
9. tx throw → rollback → `classifyBulkError` で **503 + Retry-After / 400** に分岐(§2.1・r4)。

### 2.3 clamp(論点 2 の確定)

- 採取点を固定(Codex 指摘 13): **route handler で zod parse 成功直後に 1 回だけ `receivedAt = new Date()`**。`eff = min(answered_at, receivedAt)`、insert は `answered_at = eff, created_at = receivedAt`(同一時刻源 → CHECK が厳密成立)。multi-instance clock skew は Vercel 単一 region(hnd1)・ms 級で受容(記録のみ)。
- 下界 clamp はしない(過去 event はオフライン蓄積の正当ケース)。極端に古い answered_at は古い study day を生成しうる — 自 user の行のみで受容(Codex 独立 8)。
- 観測: 列は追加しない。**skew > 60,000ms のみ `logger.warn`**(event_id + user_id + skew ms)。60s の根拠 = 通常の NTP skew を大きく超える値のみを端末時計異常として拾う(それ以下はノイズ)。

### 2.4 順序ガードの境界と tie-break(論点 1 の確定)

- 境界 = **`>=` で適用**(不適用は「厳密に古い」のみ)。ガードの目的は時系列逆転の防止であり、同時刻は逆転ではない。重複排除は event_id PK が担う。
- 同一 request 内の tie = per-card stable sort(answered_at 昇順・同時刻は payload 順)で決定的。
- **cross-request の同時刻**(別 POST / 別端末・Codex 独立 1 / 指摘 1,2): **「到着順」= DB の card 行ロック取得順(= serialization 順)を正式な適用順とする**(HTTP 到着順・handler 開始順ではない — 順序を決めるのは §2.2 手順 3 の FOR UPDATE が付与する直列化のみ)。cards に順序 watermark(last_event_id 等)は追加しない。根拠: 同一 user の 2 端末が同一 ms に同一 card へ回答する事象は実用上発生せず、発生しても両 event とも適用され差は適用順のみ(FSRS 状態の微差)。この非決定性は §0 の「bit-exact rebuild 非保証」の一部として明示的に受容する。不採用案 = `(answered_at, event_id)` 全順序 + watermark 列(cards に列追加・uuid 順に業務的意味なし・得られるのは実用上起きないケースの決定性のみ)。
- lastReview = null(未回答 card)は常に適用。未来クロック汚染は clamp(§2.3)で先に断たれる。

---

## 3. 終端の設計(論点 3 の確定 — 「permanent」語彙の廃止)

**受理可能な event は card 不在・option 不一致でもすべて insert(applied=false)し、200 応答で client は synced 化 → 再送が構造的に止まる。**

- 従来 orphan reject の理由は (i) card_id FK 違反回避 (ii) replay 不能 — (i) は FK 撤去で消滅、(ii) は applied=false が受け皿。A-2 検証は「reject 条件」から「applied 条件」へ降格(不正 selected_answer_ids が入るのは自 user のデータ領域のみ・zod bound 済)。
- **poison-pill 対策(Codex 独立 5 / 指摘 4,15 — r1 の「local 残置で無害」は不正確だったため修正)**: 形式不正 event が chunk ごと 400 を誘発して正常 event を道連れにする経路を、**client 送信前検証**で断つ。flush 時に server と共有の event schema(`lib/sync/shared/` の前例に倣い zod 1 定義を両側 import)で per-event 検証し、不正 event は送信対象から外して **`sync_status='failed'` に隔離**(時間でなく形式による決定的 terminal 化 — 24h drop 廃止の裁定と両立。'failed' の review 側唯一の用途になる)。これにより server 400 は「共有 schema を通ったのに 400」= client/server 不一致バグの loud signal に純化。
- chunk 逐次送信の失敗時規則(Codex 指摘 15): chunk N が失敗(4xx/5xx/network)したら**以降の chunk は送らず中断**(次 trigger で先頭から。event 冪等ゆえ重複送信は無害)。429 は即停止(既存)。
- **failed[] の terminal 化(r3 修正)**: 200 応答の failed[] に載った event は client で **`sync_status='failed'` に terminal 化**する(pending 維持しない)。所有権・内容不一致の衝突は再送で永久に解消しないため、pending 維持では「残る pending は transient のみ」が偽になる(r2 の誤り)。local 行は残す(データ非損失と両立)。
- **'failed' の意味の統一**: 「**形式不正(client 送信前検証)または server 衝突(failed[])による決定的 terminal**」。時間ベース(24h)の failed 化は存在しない。
- **現行との差分(明記)**: 現行は 200 + failed[] を `classifyFlushResults` が 'permanent' に分類する(review-flush.ts:53-71)一方、行は pending のまま残り(review-events.ts:331-337 は synced のみ mark)、次 trigger で毎回再送される — 「分類は permanent・挙動は無限再送」の不整合。新設計は failed[] 受領 = 即 'failed' terminal で分類と挙動を一致させる。
- 帰結: 終端 = synced(受理)or failed(形式不正 / server 衝突)。残る pending は transient(503 / network / 429 / chunk 中断)のみ = 残置しても配送保証を損なわない。

---

## 4. client(Dexie / flush / 計測)

### 4.1 Dexie v9

- `answer_events` store 再作成(旧 store 破棄 — v3 の card_mutations 前例。§10):
  - 追加: `user_id` / 削除: `last_attempted_at` / `rating` 型必須化
  - index: `'++local_id, event_id, [user_id+sync_status]'`(pending 選別 = 等値。card_id / session_id / 単独 sync_status index は読み手なしにつき廃止)
- `study_sessions` store 削除(`null`)。
- SyncStatus 4 値のまま(review 側 'failed' = 形式不正 or server 衝突の決定的 terminal — §3 の統一定義。entity 側は不変)。

### 4.2 flush の一本化(論点 4 の確定)

**session 単位並列は構造ごと消滅** — 並列/逐次の選択自体が解消:

- `flushPendingAnswerEvents(userId)`: `[user_id+sync_status]` で自 user の pending 全件 → 送信前検証(§3)→ 1000 件 chunk **逐次 POST** → 応答で synced 化。
- **owner-scope の徹底**(Codex 独立 12 / 指摘 18): 選別だけでなく synced/failed 化も flush 開始時に閉じた userId + event_id で限定。アカウント切替中の in-flight 応答が新 user の状態に作用しない。
- 3 入口(threshold / 完了 / trigger)を**すべて runGuardedFlush(Web Locks)経由に統一**(第 1 弾 §2.2 の lock 抜け経路 B/C を閉じる)。lock busy skip 後の配送保証(Codex 独立 13): busy = 他タブが flush 中(そのタブが配送)+ 既存 trigger 網(mount / visibility / online / threshold / 完了)と backoff retry が再 kick 源。Web Locks 非対応環境は withWebLock の既存 fallback(直接実行)— 正しさは server 直列化が担う。
- FLUSH_THRESHOLD=5・pull-back・backoff retry controller は不変。

### 4.3 24h drop の全撤去

- `PENDING_MAX_AGE_MS` / `dropStalePendingAnswerEvents` / `markAnswerEventsAttempted` / trigger の drop 呼び出しを削除。`outbox-ops.dropStaleByKey` は entity_mutations(30d)用に残す。

### 4.4 session_id ラベル

- SessionLauncher は `newId()` で session_id を採番し続ける(**Dexie 行は作らない**)。event の label のみ。createStudySession / completeStudySession / abandonStudySession / getStudySession は削除。

### 4.5 elapsed_ms 計測(Codex 独立 11 / 指摘 17 反映)

- 定義: **当該 card の表示開始(index 遷移・リトライ reset・前へ戻りの再表示)から submit までの wall-clock 差分**(`performance.now()`・int ms)。tab 非表示・スリープ時間を**含む**(操作時間であって注意時間ではない — 意味論明記)。FSRS rate 連打は最終 confirm(次へ/前へ)までの 1 計測 = 1 event。
- client 側で `min(計測値, 86_400_000)` に clip して送信。zod 上限 86_400_000(24h)。負値・計測不能は NULL。DB CHECK は >= 0 のみ。

### 4.6 owner-scope の供給

- recordAnswerEvent は userId 必須引数(SessionRunner へ RSC から props 供給 — 認証済み値)。entity_mutations outbox の同型の穴は非スコープ(Sprint B 候補・§11)。

---

## 5. study_days 再集計(論点 5 の確定)

- 全列を「**applied=true event からの full 再集計・UPSERT 上書き**」に統一(加算意味論の廃止)。
- 範囲 = **今回 applied になった event が跨る JST day 全部**。
- 集計は **対象 day の VALUES CTE + JOIN + GROUP BY の 1 文**(r3 で実装可能形に確定。day_bucket 実列は無く SQL の AT TIME ZONE も全廃方針のため、境界は JS 側 `jstDayRange()` で計算して bind する):

  ```sql
  WITH days(day, start_at, end_at) AS (
    VALUES (:day1::date, :start1::timestamptz, :end1::timestamptz), ...  -- 対象 day のみ列挙
  )
  SELECT d.day,
         count(*)                                AS review_count,
         count(*) FILTER (WHERE ae.is_correct)   AS correct_count,
         count(DISTINCT ae.card_id)              AS distinct_card_count
  FROM days d
  JOIN answer_events ae
    ON ae.user_id = :userId AND ae.applied
   AND ae.answered_at >= d.start_at AND ae.answered_at < d.end_at
  GROUP BY d.day
  ```

  min〜max の連続 range は**採らない**(遠く離れた 2 event で間の全履歴を走査し「event 数で bound」が崩れるため — r2 の誤り)。VALUES 列挙により走査は対象 day の range scan × day 数に固定され、**bound = day 数 ≤ event 数(≤1000)**。結果行を UPSERT(絶対値 set)。day ごとの N+1 はしない。
- **day 行ロックによる cross-card 直列化(r4 追加・必須)**: card 行ロック(§2.2 手順 3)は**同一 card しか直列化しない**ため、同一 user・**異なる card**・同一 JST day の 2 flush が並走すると、双方が相手の未 commit event を含まない集計値を作り `study_days(user_id, day)` を後勝ちで上書きしうる(full 再集計にしても消えない別種の lost update)。したがって再集計の**前**に対象 day 行を確保しロックする:
  1. 対象 day を **昇順ソート**し `INSERT INTO study_days (user_id, day, …) VALUES … ON CONFLICT DO NOTHING`(行を必ず存在させる。値は 0 でよい — 直後に絶対値 UPDATE する)
  2. 同じ昇順で `SELECT … WHERE user_id = ? AND day IN (…) ORDER BY day FOR UPDATE`
  3. 上記 CTE 再集計 → 絶対値 UPDATE
  これにより後続 tx の再集計 SELECT は先行 tx の commit 後に走り、正しい合計を読む。
  **ロック順序の全 tx 共通規約**: `cards`(ID 昇順)→ `study_days`(day 昇順)。ingest は全経路この順序でのみロックを取るため deadlock は生じない(publish-prepared の ID 順規律と同型)。
- **ゼロ件 day は発生しない**(再集計対象 = 今回 applied が属する day のみ・applied/answered_at/user_id は不変 — §1.1 の applied 不変契約が前提。event の削除・訂正・修復を将来導入する場合は full-rebuild で対応 = 非スコープに明記。Codex 指摘 10)。上記手順 1 で先に 0 行を作るが、手順 3 の UPDATE が必ず同 tx 内で実値に置き換えるため、0 行が残ることはない(tx throw 時は rollback で消える)。
- **correct_count の定義 = is_correct**(rating>=2 から変更・裁定)。
- **JST 1 定義**: day 導出は `todayInJst`(lib/jst.ts)のみ。SQL の `AT TIME ZONE 'Asia/Tokyo'` は全廃し、新 pure 関数 `jstDayRange(day)` の timestamptz 境界を bind(JS/SQL 二重実装の解消 — 第 2 弾 §2.8)。境界(日跨ぎ前後 1ms・閏日)は unit で pin(Codex 独立 10)。`lib/db/in-date-list.ts` は唯一の使用元消滅につき削除。
- 性能: `(user_id, answered_at)` の range scan × 対象 day 数(VALUES への nested loop)。1 user × 1 day 数百 event 想定 — **想定であって保証ではない**(Codex 指摘 11)ため、iso で 1000 event flush の所要を計測し記録する(閾値 gate にはしない)。
- 副次効果: 母集合が answer_events(card 非依存)になり、card 削除で distinct だけ縮む自己矛盾(第 2 弾 §6-6)が消える。dangling event も applied=true なら数え続ける。

---

## 6. 統計列の導出変更(cards)

- `replayCard` の correct 定義を **event.is_correct** に変更(ReplayEvent に isCorrect 追加): `lastCorrect = is_correct` / `currentStreak = is_correct ? +1 : 0`。scheduling(rate)は rating のまま。**正誤の 2 本立て確定: 統計・フィルタ = is_correct / scheduling = rating**。
- `answered = true` は不変(適用 event があった card のみ更新)。

---

## 7. 二重実装の解消

### 7.1 初期 FSRS 値の 1 定義

- `lib/cards/domain/initial-fsrs-state.ts`(pure・**now を引数注入** — Codex 独立 14)を新設し、**3 生成点**(client `build-new-client-card` / server `applyCardCreateWithId` / OCR `saveExtractedCards`)を全てここからの明示 set に統一。client optimistic は client 時刻・server は server 時刻(reconcile-on-pull で収束 — 現行と同じ)。cards の FSRS 列 DB default は撤去。ts-fsrs `createEmptyCard` との一致は unit test で pin(client bundle に ts-fsrs を入れない)。
- **default 撤去の影響網羅**(Codex 指摘 19): production 3 経路に加え、tests/fixtures・`scripts/seed-perf-exam.ts`・iso setup の cards INSERT 全数を plan の探索 task で洗い、必須列供給へ更新する。

### 7.2 streak の 1 定義

- `computeStreak` + `addDays` + window 定数を `lib/reviews/domain/streak.ts`(pure)へ移設し、`lib/db/streak.ts` / `lib/client/streak.ts` は I/O + import に縮退。`getReviewStatsForUser`(fallback route 用)は維持。

---

## 8. 削除・退会

- **answer_events を Group I(退会 handler 明示 DELETE)へ移動**(card FK 撤去 + user CASCADE 不発のため必須)。handler と invariant test(Group I 集合一致)を更新。reviews / study_sessions の DELETE 行は表ごと消滅。
- exam / card 削除は answer_events に波及しなくなる(dangling 正規)。tombstone 機構は不変(answer_events は client mirror を持たない = 伝播不要)。

---

## 9. 検証(iso / test / smoke)

### 9.1 iso 新設(必須スコープ)

`tests/integration/pg/answer-events-serialization.test.ts`(実 PG・2 テナント harness 流用 + **同一 user 2 接続の同時実行 helper 新設**):

1. **直列化**: 同一 card へ 2 接続同時 flush → 両 commit 後 `cards.reps = 2` ∧ applied 2 行。**flake 対策(Codex 指摘 22)**: 両接続が同一 snapshot を読んだことを barrier(advisory lock 等の DB 側同期)で保証してから解放する構成にする(FOR UPDATE 撤去の red 変異が決定的に fail するため)。
2. **順序ガード**: (a) 適用済み card へ古い event → applied=false ∧ cards 不変 (b) 同一 request 内の新旧混在(sort で全適用)(c) 中間時刻 event の遅着 → applied=false (d) 同時刻 event(>= で適用)(e) lastReview=null。(Codex 指摘 21)
3. **clamp**: 未来 answered_at → 保存値 <= created_at ∧ due 非汚染。
4. **dangling**: card 不在 event → insert(applied=false)∧ failed に載らない。
5. **event_id 衝突**(Codex 指摘 20 + r3 拡張): (a) 他 user の既存 event_id → failed[] ∧ 行不変 (b) **自 user・内容不一致の再送 → failed[] ∧ 既存行不変**(immutable 照合)(c) **正当再送(内容一致)→ 200 ∧ failed に載らない** — 初回に clamp された event の再送も一致判定されること(§2.2 手順 4 の比較式の pin)。
6. **schema contract**(Codex 指摘 23): 新 answer_events の PK / CHECK / index / RLS policy / grant を実 PG から readback して pin(DROP/CREATE で policy・grant が失われる事故の恒久検出)。
7. **study_days CTE 集計**(r3): 複数 day 跨ぎ flush で全対象 day が絶対値 UPSERT されること + 遠く離れた 2 day の flush で中間 day の行が生成・変更されないこと(VALUES 列挙形の検証)。

client 側 pin(unit / sync test・iso 外だが本 sprint 必須): **failed[] 受領 event が 'failed' に terminal 化され以降の flush 対象から外れること**(§3)+ 送信前検証の形式不正隔離。

red 検証(test-only 増分): gate を**個別に**変異(FOR UPDATE 外し / 順序ガード外し / clamp 外し / 所有権検証外し / **内容一致検証外し**)して各 pin が単独で fail することを実証。

### 9.2 既存 test 波及(論点 6 の確定 — 全量は第 1 弾 §6.1 が基礎)

| 対象 | 方針 |
|---|---|
| `tests/fixtures/review-events.ts`(564 行) | **新 wire 前提で書き直し**。既知の地雷: fake select chain が `.where()` で Promise を直接返すため `.for('update')`/`.orderBy()` 追加で一斉に落ちる(第 1 弾 §6.2)— chain を実 shape に再設計。session merge fake(G1)・canApplyStatusWrite 連携は削除で縮む |
| route.test(1789 行)/ contract(628 行) | 新 payload / 新応答(200・400・503)/ applied 意味論で全面改稿。session upsert 系 case 削除 |
| domain tests | sort+gate+isCorrect の新仕様で改稿。deriveRating / aggregateStudyDays / planReplay の test は削除または後継へ |
| sync tests(review-events / review-flush / trigger) | 24h drop 系削除・1 本化 flush・owner-scope・送信前検証・chunk 中断規則の新 pin |
| iso 既存 | rls-wave1(reviews / study_sessions 部削除)・rls-cascade(**answer_events が card cascade で消えないことの検証へ反転**)・fixture-completeness / completeness.ts 表リスト更新・write-isolation(applyCardFinalStates 続投) |
| RLS 配線 | `rls-p3-wave1-enable.sql` 更新(reviews 行削除・answer_events 新表向け)+ wave2 から study_sessions 削除 + `verify-rls-state.ts` リスト更新。**stg は「migration → 即 policy/grant 再適用 → 実効検証」を 1 手順として runbook 化**(無防備窓を作らない — Codex 独立 15。適用漏れ前例 2026-08-04) |
| migration 整合 | 手動調整した migration が snapshot/journal と一致し、直後の `db:generate` が **no-diff** であることを完了条件に含める(Codex 指摘 24) |

### 9.3 stg smoke(push 後・OT 指示で CC 実走)

演習 E2E(回答 → flush → cards/dashboard 反映・Network/IDB 証跡)+ offline 蓄積 → 復帰 flush + RLS 実効検証(§9.2)。実機依存なし(DevTools MCP で完結見込み)。

---

## 10. migration・データ移行(提案)

- **既存データは全捨て**: server answer_events(rating を持たず replay 不能)/ reviews(event 紐付けが値一致頼み)/ study_sessions / study_days(TRUNCATE)。Dexie は v9 store 再作成で端末側も破棄。ユーザー 0 につき許容 — **OT 承認対象**。
- migration 構成(schema.ts 新形 → `db:generate` → 手動調整・§9.2 の no-diff 条件付き):
  1. answer_events: DROP → CREATE(新形)
  2. DROP TABLE reviews / study_sessions
  3. cards: double precision ×2 / CHECK(state)/ FSRS 列 default 撤去
  4. TRUNCATE study_days(手書き追記)
- 適用: local/iso は global-setup が自動(migration + grant + policy 毎 run)。stg は OT が db:migrate(ADMIN)+ RLS/grant 再適用を 1 手順で(§9.2)。

---

## 11. 非スコープ(明記)

- ReviewLog スナップショット保存(不採用確定)/ **rebuild コマンド**(§0 の限定どおり保証しない。トリガー = 実需)
- event の保持上限(無期限。再検討トリガー = 容量の実測)/ event の削除・訂正・修復操作(導入時は study_days full-rebuild とセット — §5)
- cards の 3 責務分割・FSRS 状態の別表化(トリガー = LMS 着手)
- CHECK の全表展開・死列/死表/死 index の一掃(第 3 弾 §9 → Sprint B)。本 sprint の新設・変更列への CHECK のみ本 sprint
- entity_mutations outbox の owner-scope 化(同型の穴 — Sprint B 候補)
- tech-spec §14 系の全面改稿はしない。ただし**旧 wire / reviews / study_sessions を記述する節の冒頭に「2026-08-11 spec が正・本節は歴史記述」の注記 1 行を挿入**(正本競合の回避 — Codex 指摘 25 を最小形で反映)

## 12. 裁定との乖離・OT 承認記録

**r2 は 2026-08-11 に OT 条件付き承認**(下記 1〜7 は承認済み)。条件 = r3 修正 3 点 + 付随修正 2 点(いずれも本 r3 に反映済み):

- (i) event_id 再送の**内容一致検証**を §2.2 手順 4 に追加(Codex 独立 4 の残り半分の取り込み。answered_at 比較基準 = 既存行 created_at での clamp 式再評価)。
- (ii) §3 の終端規則修正: **failed[] 受領 event は 'failed' に terminal 化**(r2 の「pending 維持」は「残る pending は transient のみ」を偽にする誤りだった)。
- (iii) §5 の集計 SQL を **VALUES CTE + JOIN + GROUP BY** に確定(r2 の day_bucket GROUP BY は AT TIME ZONE 全廃方針下で成立せず、min〜max 連続 range は bound 主張を崩す誤りだった)。
- 付随: §2.4「到着順」= card 行ロック取得順(serialization 順)と厳密化 / §0 再現性の限定を明確化(保証 = 入力の監査可能性 + 現行コードによる再計算の 2 点)。

**r4 amend(2026-08-11・plan 段階 Codex cross-check 由来・OT 裁定済み)**:

- (iv) **§5 に day 行ロックを追加**(Codex plan 独立 1 = 真の指摘)。card 行ロックは同一 card しか直列化せず、異なる card・同一 day の並走で study_days が後勝ち上書きになる — r3 の「full 再集計だから加算競合が消える」はこのケースで偽だった。ロック順序規約 `cards(ID 昇順)→ study_days(day 昇順)` を全 tx 共通として明記。
- (v) **§2.1 の tx throw を classifyBulkError 分類に修正**(Codex plan 独立 9)。一律 503 は permanent な実装/データ欠陥まで client に永久再送させる。transient→503+Retry-After / permanent-4xx→400。

以下は r2 時点の乖離・確認点の記録(全て承認済み):

1. **確定事項 8 の実現形変更**(CC 提案・Codex も「裁定変更であり OT 確認必須」と指摘 #3 で一致): 「server permanent 判定 → client terminal 化」の代わりに「全受理(applied=false)+ client 送信前検証で形式不正を failed 隔離」(§3)。目的(再送停止・データ非損失)は同一で機構が単純。不採用案 = reject + 'rejected' 状態 + 理由 enum wire(状態・語彙・migration が増えるだけで利得なし)。
2. **同時刻 cross-request の適用順 = 到着順を正式仕様とする**(Codex 独立 1 は watermark 全順序化も選択肢として提示 — §2.4 に両論と採否理由)。合わせて **§0 の「正本の意味の限定」**(bit-exact rebuild 非保証)を明文化した(Codex 独立 3 由来)。ReviewLog 不採用裁定の再確認を含む。
3. **rating required 化 = P0 §A#7 凍結契約の改定**(第 2 弾 §2.2 根拠)。
4. **created_at を app 層打刻に変更**(DB now() 規約からの逸脱・採取点は §2.3 で固定)。
5. **初期値 1 定義の対象は 3 生成点 + fixtures/seed/iso setup**(裁定文言の「二重」に対する現物拡張)。
6. **既存データ全捨て**(§10)。
7. 確定値の承認: 順序ガード `>=` + stable sort(§2.4)/ clamp 60s log(§2.3)/ study_days = 影響 day 全部・1 文 GROUP BY(§5)/ wire 3 値化 200・400・503(§2.1)/ event_id 所有権検証(§2.2-4)/ card index 意識的不採用(§1.1)。

## 13. docs 波及・完了条件

- architecture.md: §1(review-events 行の形更新)/ §2(cascade 用語 — answer_events をユーザー帰属へ)/ §4(Group I に answer_events)/ 証明の空白(「並走 flush の lost update」を iso 新設で埋めた旨)。tech-spec は §11 の注記 1 行のみ。
- 完了条件: whole-repo lint 0 / `pnpm test:iso` green(新 harness §9.1 含む)/ `pnpm run audit` 0 / `pnpm install --frozen-lockfile` + typecheck + build 0 / migration no-diff(§9.2)/ canonical + Codex review で Critical 0・Important 0 → `[reviewed]` / stg smoke PASS(§9.3)/ docs 更新(本節)。
