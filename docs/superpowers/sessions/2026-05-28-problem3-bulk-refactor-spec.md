# 問題 3 本体 (bulk refactor) — 確定 spec & 設計骨子

- 日付: 2026-05-28
- 種別: spec / 設計骨子 (実装前、 kickoff prompt の起点)
- 対象: `/api/review-events/bulk` の event 処理を「per-event tx」→「1 tx + in-memory FSRS replay + bulk SQL」へ
- 目標: N=5 で **~16s → ~3.2s**。 RTT ~445ms × 35 往復 → ~8 往復への削減 (RTT 支配は計測で確定済)
- 前提調査: `docs/superpowers/sessions/2026-05-28-problem3-sync-layer-pre-investigation.md` (実コード行付きで全軸確定済、 不変条件 11 件)

> 本 spec の判断は全て pre-investigation report の実コード所見に基づく。 report を ground truth とする。

---

## 0. スコープ確定

### やること

- `/api/review-events/bulk` の **server 側内部処理のみ** を bulk 化
- FSRS 純計算コアを DB 非依存関数として抽出し、 in-memory replay から呼ぶ
- cards 書き戻しを VALUES 単一 UPDATE 化

### やらないこと (今回スコープ外)

- **DB schema 変更**: 一切なし (既存カラムのみ使用、 migration ゼロ)
- **API payload 契約変更**: `{ session, events }` のまま (client 不変)
- **client flush (経路 1 / 経路 2 / in-flight guard)**: touch しない
- サーバー権威 / FSRS サーバー計算: 維持 (変えない)
- C2 (複数 session 1 POST) / outbox rename / TTL drop / region・RTT 改善 / ローカル FSRS investigation
- after 計測 (実装後に stg で ~3.2s 達成確認 = 別 task)

---

## 1. アーキ判断 (確定)

### サーバー権威・FSRS サーバー計算を維持

現設計は「server = source of truth / client = mirror + 送信キュー」で、 sync 層・PullTrigger が全てこれ前提。 FSRS をクライアントに移す案 (Anki 型ローカル計算) は検討したが**今回は採用しない**:

- truth 逆転で複数端末の衝突問題を抱える (現状はサーバー権威で衝突が無料で回避できている)
- 順番/重複問題は単一端末内では IDB outbox の local_id 昇順で既に解決済。 順不同が問題化するのは複数端末時のみ
- 複雑さは消えず client に移動 + stale base state の新リスクが乗る = 差し引き増える
- 複数端末対応を残す方針 (Clerk 認証・PullTrigger 前提) と整合

→ 今回の bulk 化は将来ローカル FSRS にしても無駄にならない (残すのは VALUES 書き込み口、 消すのは replay のみ)。 ローカル FSRS は「複数端末を捨てるか」次第の別 investigation として記録。

---

## 2. 処理フロー (最終形)

### Phase 0 — session upsert (tx 外、 現状維持)

- session upsert を先に独立実行。 失敗 → 500 `session_upsert_failed`、 events 未処理
- `card_ids` は初回 insert のみ (conflict 上書きしない) / status・completed_at は最新で上書き / `setWhere = user_id`
- events tx の外に維持 (1 event の失敗が session 行を巻き込まない)

### Phase 1 — read + 除外 (tx 内)

1. payload events から distinct card_id 収集
2. `SELECT cards WHERE user_id = me AND id IN (...)` — **FSRS 計算に必須の SELECT**。 現状態取得 + 存在確認を兼ねる (owner-scope = 削除済 / 他人カードも同時に弾く)
3. valid card set に無い card_id の event → `failed[]`。 残り = `applicableEvents` (payload 配列順保持)

> 除外は「FSRS 用にどのみち打つ SELECT」の結果に相乗りするため**追加コストゼロ**。 クライアント↔サーバーの事前問い合わせは発生しない (server↔Postgres 内部の 1 クエリ)。 FK だけに任せると 1 件の不在で bulk INSERT 全体がロールバック (5 件全滅) するため、 事前除外で 4 件を守る。 FK は最後の砦として残すが実運用では発火させない。

### Phase 2 — write (同 tx 内)

4. `INSERT answer_events (applicableEvents) ON CONFLICT DO NOTHING RETURNING event_id` → `insertedEventIds`
5. **replay gating**: applicableEvents を payload 順に走査し「`insertedEventIds` に含む ∧ `consumedSet` 未消費」だけ採用 → `eventsToApply`
   - 新規 insert 分だけ適用 (冪等性 = event_id 単位)
   - payload 内に同 event_id 重複があっても初回 1 回のみ (`consumedSet` で吸収)
   - RETURNING の戻り順は input 順保証なし → **元 payload 配列順で走査**して順序を保つ
6. **in-memory replay**: `eventsToApply` を card_id ごとに group (group 内は payload 順)。 各カードは step 2 の現状態を起点に `rate(state, rating, now = event.answered_at)` を順に fold → カードごと最終状態 + event ごと review 行
7. `INSERT reviews` (適用 event 数 = 行数、 bulk)
8. `UPDATE cards` (VALUES 単一文、 カードごと最終状態、 owner-scope)
9. **study_days**: 適用 event を JST day ごとに group。 reviews insert 後に day ごと `COUNT(DISTINCT card_id)` 再集計 → upsert (`reviewCount += その day の適用数` / `correctCount += correct 数` / `distinctCardCount = 再集計値`)
10. commit

### 応答

`200 + { ok: true, failed: string[] }` (契約死守。 client の sync_status 遷移が依存)

---

## 3. 守る不変条件

| # | 不変条件 |
|---|---|
| 1 | 冪等性の単位は `event_id`。 新規 insert 分だけ適用。 再送済み event は**適用しないが failed にも入れない** (= 成功扱い、 client が synced 化) |
| 2 | orphan card のみ `failed[]` (現状の隔離挙動維持)。 FK は最後の砦、 事前除外で発火させない |
| 3 | tx 途中の非予測エラー → 全 rollback。 `failed[] = applicable 全件` (client が丸ごと retry、 event_id 冪等が安全網)。 ← **採用デフォルト** |
| 4 | 同カード複数 event は payload 配列順で直列 fold。 `rate()` は stateful (reps / lapses / state / streak / stability が適用回数・順序依存)。 「最後の rating 1 回」は誤り |
| 5 | replay 順 = payload 配列順。 server で `answered_at` sort しない |
| 6 | reviews は event 1 件 = 1 行 append (UNIQUE 制約なし) |
| 7 | study_days: reviewCount / correctCount は適用 event 数で増分、 distinctCardCount は reviews insert 後の再集計、 JST day ごと group |
| 8 | `rate()` の `now` = `event.answered_at` (共有 timestamp 不可) |
| 9 | owner-scope (`user_id`) を全 SQL で維持 (CLAUDE.md Clerk 4) |
| 10 | session upsert は events tx の外 |
| 11 | in-flight guard / client 側は触らない。 server は payload のみで完結、 client の in-flight Set に非依存 |

---

## 4. 実装メモ

- **FSRS 純計算コアの抽出**: 現 `submitReviewTx` は compute + DB op が tx で一体。 bulk では DB op を bulk 文へ移すため、 **DB 非依存の純計算コア `replayCard(現状態, events[]) → { 最終状態, review 行[] }` を抽出**し bulk replay から呼ぶ。 旧単発経路 (`submit-review.ts`、 client 未使用) は据え置きで可
- **VALUES 単一 UPDATE**: `UPDATE cards SET ... FROM (VALUES (...),(...)) AS v(id, due, stability, ...) WHERE cards.id = v.id AND cards.user_id = me`
  - raw は `sql` / `sql.join` で parameterized 構成、 **文字列連結禁止**
  - 型 cast 明示: `::uuid` / `::timestamptz` / `::real` / `::int` / `::boolean`
  - review で脆いと判断時のみ、 同一 tx 内 card 単位 UPDATE × N に fallback (1 tx 目標は満たす、 ~2.6s 残すが安全)
- **Drizzle 0.45.2 capability** (確認済): bulk INSERT / ON CONFLICT DO NOTHING RETURNING / UPDATE FROM (subquery) は native。 VALUES tuple list だけ raw
- **handler を 1-session 処理関数として構造化**: payload は今回 1 session のまま。 内部を「1 session を処理する関数」に切り出しておけば、 将来 C2 (複数 session 1 POST) が必要になった際 payload を `sessions: []` に拡張して関数をループするだけで済む。 今回は migration も契約変更もせず拡張点だけ仕込む

---

## 5. テスト方針

### 純 replay コア (最重要)

現 `submit-review-tx.sequential.test.ts` の semantics を移植:

- Hard→Good→Easy で reps が apply 数分 increment、 streak 単調増加、 各 due が各 now より将来
- Good→Again→Good で streak 1→0→1、 reps は incorrect 含め 3 増加
- 期待値は **invariant check** (due 増加 / reps 増加 / streak 挙動)。 hard-code 回避 (ts-fsrs version up 耐性)

### bulk handler (新規)

- orphan card → failed[]、 他は適用
- payload 内重複 event_id → 1 回のみ適用
- 再送済み event_id → 適用せず、 failed にも入れず (成功扱い)
- 同カード複数 event の順序 (payload 配列順)
- study_days 集計 (多 day group 含む)
- VALUES UPDATE が card ごと別状態を正しく書く
- 注入エラーで全 rollback → applicable 全件 failed[]
- 応答契約 `200 + { ok, failed }`

### 既存 test の書き換え

`route.test.ts` で `submitReviewTx` の per-event 呼び出し回数 / 順序を assert している test は内部実装が変わるため、 **DB 結果ベースの assert に書き換え** (挙動維持なので結果は同じはず)

---

## 6. スコープ外論点 (記録のみ、 本 sprint では触らない)

1. **C2 (複数 session 1 POST)**: payload 契約 + client/server 両側改修 + 混在失敗の応答契約設計が必要。 現実は pending session 通常 1〜2 個 (= 経路 2 が普段投げる POST は 1 本、 稀に 2 本並列) で効果薄。 schema 変更は不要だが両側契約変更の壊れやすさ大。 dominant な勝ち筋は「1 本を速くする」bulk 化の方。 session 跨ぎ pending 滞留は長時間オフライン / 障害復帰時のみで、 経路 2 の全 pending 回収で取りこぼしは起きない (遅いだけ = 許容)
2. **outbox rename**: client answer_events は本質的に送信キュー (outbox)、 server 側は event store (永続) の非対称。 命名のみ
3. **TTL drop**: synced かつ 7日超の Dexie row を起動時 1 回 IDB query で削除 (client + IDB 完結、 server 問い合わせなし)
4. **region / RTT 改善 (B 軸)**: DB 移行 / function region。 RTT ~445ms 支配は記録済、 後回し方針維持
5. **ローカル FSRS investigation**: 複数端末を捨てるか次第。 別 investigation
6. **after 計測**: 実装後 stg で ~3.2s 達成確認 (before 16s と比較)。 計測基盤 (`d3617a8` TEMP-MEASURE) の撤去も campaign 後

---

## 7. 決定ログ (本 spec で確定した判断)

| 論点 | 確定 |
|---|---|
| A partial failure | 事前 SELECT 除外 (owner-scope) + 1 tx。 追加コストなし・事前問い合わせなし。 FK は最後の砦 |
| 全 rollback 時の failed[] | applicable 全件を failed[] に (client 丸ごと retry)。 500 にしない |
| B cards 書き戻し | VALUES 単一 UPDATE 第一候補 (parameterized・cast 明示)、 脆ければ card 単位 UPDATE × N に fallback |
| C replay 順 | payload 配列順維持。 answered_at sort しない |
| 重複 event_id ガード | insertedEventIds + consumedSet で初回のみ apply |
| `rate()` の now | event.answered_at |
| study_days | JST day group・reviews insert 後に COUNT(DISTINCT) 再集計 |
| session upsert | tx 外維持 |
| FSRS 純計算コア | `replayCard` を DB 非依存で抽出、 旧単発経路は据え置き |
| handler 構造 | 1-session 処理関数に切り出し (将来 C2 拡張点) |
| DB schema | 変更なし (migration ゼロ) |
| 実機実走 | 非 blocker (code + test で設計判断に十分) |
