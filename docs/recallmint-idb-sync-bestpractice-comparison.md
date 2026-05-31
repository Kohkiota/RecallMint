# ★ RecallMint IDB↔サーバー同期 — ベストプラクティス比較 (増分 pull 実装 進捗反映版)

> ★ **重要設計リファレンス（恒久）**: offline-first / outbox 同期の定石と RecallMint 実装の対応表。同期サブシステムの設計判断の根拠を一次ソース付きで保持する。実装ステップ詳細は対の [`recallmint-incremental-pull-steps.md`](./recallmint-incremental-pull-steps.md)。**同期周りを触る前に §3 設計含意 / §8 実装状況マトリクス / §12 試験詳細 local-first を必読。**

- 初版日時: 2026-05-29 / 更新: 2026-05-31 (演習読込 増分 pull 化 step 1-7 完了 + 試験詳細 書込 local-first 化 **Stage 1-4 全完了** を反映)
- 目的: offline-first / outbox パターンの定石と RecallMint の実装を一次ソース付きで突き合わせる
- 参照した実コード調査: `2026-05-29-localsync-mvp-pre-investigation.md` / `2026-05-29-inline-edit-send-timing-inventory.md` / 増分 pull 各 step の inventory・session log
- 関連: 全ステップ詳細は `recallmint-incremental-pull-steps.md`、確定 spec は `docs/superpowers/specs/2026-05-29-incremental-pull-design.md`

> **更新サマリ (2026-05-30 最終)**: 演習読込の増分 pull 化が **step 1-7 完全完了**。
> **クロック統一 / 統合 /api/pull / client 増分 merge / ガード+トリガー / pull-back / exams Dexie 化 / 旧 endpoint 掃除** がすべて完了・[reviewed] 着地・push 済み。
> **§8-2 の読込側 未充足 7 項目すべて充足 + 試験一覧 Dexie 化 + 掃除完了**。最終総合 stg smoke **全16観点 live 実機実証**(real データ非破壊)。
> **試験詳細画面(exams/[id])書込 local-first 化は Stage 1-4 全完了**(server endpoint / client outbox+flush / pull-suppress / UI cutover、全 stg smoke PASS・[reviewed])。演習読込 + 試験一覧 + 試験詳細書込、すべて local-first 化済み — 進捗は §12 参照。

---

## 1. ベストプラクティスの柱 (outbox パターン / offline-first)

| # | 原則 | 要点 | ソース |
|---|---|---|---|
| A | ローカルが「いまの真実」 | UI は常にローカル DB を観測し、ネットワーク操作もまずローカルに書く。サーバーは「時間をまたいだ共有の真実」。衝突時の同期エンジンの仕事は調停 | educba.com/offline-first, androidengineers.substack.com |
| B | 書き込みは永続キュー (outbox) | outbox = 書込操作の永続的なキュー。sync worker がそれを drain しつつリモート変更を pull。各エントリに UUID 主キー | educba.com/offline-first, androidengineers.substack.com |
| C | 冪等性 | 「少なくとも1回」配送では同じメッセージが複数回届く。一意キー + サーバー側「処理済みなら skip」で冪等に | docs.aws.amazon.com (transactional outbox), dev.to/actor-dev (inbox pattern) |
| D | IN_FLIGHT 状態を持つ | 「成功/失敗」2値モデルが無限リトライ・データ消失の元。タイムスタンプ付き IN_FLIGHT 状態 + stuck item 回復ジョブが最小の防御 | dev.to/salazarismo (hidden problems of offline sync) |
| E | 多タブ排他は Web Locks / leader election | 単一タブなら IndexedDB 簡易ロックで足りるが、複数タブ同時なら Web Locks API か BroadcastChannel + leader election | dev.to/salazarismo, MDN Web Locks API |
| F | pull は cursor (updated_at) 以降の差分 | 全件でなく前回 cursor 以降の変更分だけ取得。初回のみ全件、以降は `updated_at > cursor` | docs.airbyte.com (incremental sync), fivetran.com, dlthub.com |
| G | timestamp 増分は削除を取りこぼす | 削除レコードは「存在しない」だけなので timestamp では検知不能。tombstone / 変更ログで型として区別する | fivetran.com, oneuptime.com (delta lake CDF) |

### 1-追補. 増分 pull 実装で追加裏取りした定石 (2026-05-30)

増分 pull spec の前段で、cursor のクロック源・境界・複数ストリームについてさらに裏取りした。

| 論点 | 結論 | ソース |
|---|---|---|
| 時刻はサーバー由来に統一 | client クロックは改変・ズレ・偽装が検出されず cursor に使えない。サーバー時刻(NTP同期)が信頼源 | shahjerry33.medium.com (clock skew), medium.com/@mwendaevansone |
| 境界の同一時刻 | バッチ挿入で複数行が cursor と同一タイムスタンプを持つのは典型。inclusive(`>=`)下限 + 受信側 id 重複排除が定石 (keyset tie-break は最適化であって正しさの要件でない) | dlthub.com (cursor), airbyte (append+deduped), cloudquery |
| 複数ストリームの cursor | 進む速度の違う複数ストリームを単一 global cursor で測るとデータ消失。ストリーム別 cursor が定石 | dlthub.com (single cursor isn't enough) |
| next-cursor 源 | wall-clock の now でなく返却行の max。クエリ〜レスポンス間の in-flight commit 取りこぼしを防ぐ | airbyte snowflake issue, dlt |

→ RecallMint 実装への反映: **全打刻を DB クロック(SQL now())に統一(step 1)、inclusive(`>=`)+ Dexie id 冪等適用、cursor はストリーム別 3 本独立、next-cursor = 返却行の max・0件据え置き**。

---

## 2. RecallMint 現状 vs ベストプラクティス (※インライン編集は未着手のまま、演習読込は §8 で更新)

| 定石 | インライン編集の現状 | 演習 (review-events) | 判定 |
|---|---|---|---|
| A. ローカル先行 | optimistic 反映あり (即 display)、ただし書込先は React state のみ | Dexie に記録 | 編集△ / 演習○ |
| B. outbox 永続キュー | 無い (state/ref のみ、unmount/reload で消失) | pending を Dexie に永続 | 編集✗ ← 最大の穴 / 演習○ |
| C. 冪等 key | 無い (直 UPDATE、last-write-wins) | event_id UNIQUE + ON CONFLICT DO NOTHING | 編集✗ / 演習○ |
| D. IN_FLIGHT 状態 | in-flight guard + queue 深さ1 あり (送信中フラグ + pending ref) | module Set で event_id 単位 | 両方○ (形あり、ただし非永続) |
| E. 多タブ排他 | 無い (component-scope) | push=Web Locks 済 / **pull=Web Locks 済 (step 4)** | 演習○ / 編集✗ |
| F. 増分 pull | 無い (clear()+bulkPut() 全置換) | **増分 pull 済 (cards/exams、step 2-3)** / study_days は full-window 据え置き | 演習○ / 編集✗ |
| G. 削除の tombstone | option 削除は配列除外で表せる。card 削除は schema に type/tombstone 列が無い | **tombstone 記録+読取とも実装済 (記録=割り込み / 読取=step 3)** | 演習○ / 編集△ |

> 注: インライン編集(試験編集)側は本スレのスコープ外で未着手のまま。演習読込側 (cards/exams/study_days mirror) が増分 pull 化で大きく前進した。

---

## 3. 設計の含意 (初版のまま、参考)

1. 送信制御の「形」(optimistic / in-flight queue / rollback / dirty 保護 / debounce / no-change skip) は既にベストプラクティス準拠。インライン編集は転用可能。
2. 欠けているのは全て「永続化 (B) とその波及」── outbox を Dexie に (B)、冪等 key (C)、Web Locks (E)、増分 pull (F)、削除 tombstone (G)。**このうち演習読込側の E/F/G は増分 pull 化 (step 1-4) で実装完了**。インライン編集側は引き続き未着手。
3. debounce の「層」が定石と違う (UI 層→push 層への移動が本質)。インライン編集側の課題、未着手。
4. 削除 (G) は明示決定が要る設計点。**→ tombstone テーブル(割り込みで記録側、step 3 で読取側)で解決済み**。

---

## 4. Web Locks の効果範囲 (裏取り結果、初版のまま)

| 範囲 | Web Locks で防げるか | 出典 |
|---|---|---|
| 同一ブラウザ・同一 origin の別タブ/worker | **防げる** (排他ロック保持中、同一 origin の別タブは同じロックを取得できない。leader election で「1タブだけが同期」が可能) | MDN Web Locks API, SitePen, w3c/web-locks EXPLAINER |
| 別ブラウザ (Chrome と Firefox 同時) | 防げない (別々にロックを保持できる) | medium.com/@piyalidas.it |
| 別デバイス | 防げない (デバイス間同期は対象外) | medium.com/@piyalidas.it |

要点: Web Locks は「同一ブラウザ内の複数タブ協調」のための API。他タブは防げる / 他ブラウザ・他デバイスは防げない。後者2つは結局サーバー側の冪等性 (定石 C) が最終防壁になる。
→ **step 4 で pull 側にも Web Locks(`recallmint:pull`)を導入済み**。push 側 `recallmint:review-events:flush` と対称。pull の Web Locks は「正しさ」でなく「多タブ無駄打ち削減 + cursor read→write 競合回避」目的(正しさは server 冪等 + inclusive cursor + bulkPut/bulkDelete 冪等で担保)。

---

## 5. in-flight ガードの現状 (初版 + 更新)

- push 側: `lib/sync/review-events.ts` の module-scope `inFlightEventIds` Set (event_id 単位)。
- **pull 側 (step 4 追加)**: `lib/sync/pull.ts` の `runGuardedPull` が module-scope の skip-if-running boolean (最外) + Web Locks(内側) で `pullDelta` を二重防御。1 タブ内並走 kick は in-flight skip、多タブは Web Locks の `ifAvailable` skip。
- 多タブ間の重複は server 冪等性 + inclusive cursor + Dexie 冪等で吸収。Web Locks は無駄打ち削減。

---

## 6. 増分 pull 改修の形 (初版の案 → 実装結果)

> 初版は cards/pull を個別に `?since` 対応する案だったが、**実装では統合 `/api/pull` 1 本に集約**(spec 確定)。

### 実装結果 (step 2-3)
- **server (統合 endpoint)**: `GET /api/pull` が `?since_cards` / `?since_exams` / `?since_tombstone` をストリーム別に受け、inclusive(`>=`)で cards delta + exams delta + tombstone delta を返す。各ストリームの next-cursor(返却行の max、0件 null)を `cursors` で返す。
- **client (orchestrator)**: `pullDelta` が `sync_meta` の cursor 3 本(`cardsCursor`/`examsCursor`/`tombstoneCursor`)を read → `?since` で統合 endpoint を 1 回叩く → `db.transaction('rw', cards, exams, sync_meta)` で bulkPut upsert + tombstone bulkDelete(entity_type 別)+ cursor write(null skip)を 1 tx。失敗時は tx 前 return で不変性維持。
- **削除 (難所だった点)**: tombstone テーブルを pull で返し、client が `entity_type` 別に bulkDelete。物理削除でも tombstone 経由で mirror に反映(§8-4 の「全置換の暗黙削除を失う代わりに tombstone 反映が必須セット」を実装)。
- **study_days**: updated_at 列が無く 90 日 full-window のため**増分化せず据え置き**。旧 study-days/pull で並走。

---

## 7. 演習側で先に整備する意味 (初版のまま、参考)

- 演習側は安定稼働。Web Locks と増分 pull のパターンをここで確立してから編集側に展開するのは「patterns を確立してから展開」と一致。**→ 演習読込側で増分 pull + Web Locks のパターンが確立した(step 1-4)。インライン編集側への展開は将来。**
- 演習側 Web Locks は「効率」目的。ユーザー0人だが、増分化で新たに生じた cursor read→write 競合の回避という正しさ寄りの理由も加わったため step 4 で導入(G-2 確定)。

---

## 8. 機能別 実装状況マトリクス (演習 / 試験編集 × 書込 / 読込)

凡例: ✅ 実装済 / ⚠️ 部分的 / ❌ 未実装 / — 該当なし / 🔄 着手中

### 8-1. 書き込み (push / outbox) — 試験編集側 Stage 1 で前進(2026-05-31)

凡例(試験編集列): ✅ 実装済 / 🔄 spec/plan 確定・該当 Stage 未実装 / 🟡 一部実装 / ❌ 未着手。Stage 1=server(bulk endpoint + 純関数抽出 + createCard 冪等)、Stage 2=client outbox+flush+多タブ Web Locks、Stage 3=pull-suppress、Stage 4=UI cutover、**全 stg smoke PASS / [reviewed]**。

| ベストプラクティス項目 | 位置づけ | 演習 (review-events) | 試験編集 (inline) |
|---|---|---|---|
| ローカル先行の楽観書込 (UI→IDB を先に) | 必須 | ✅ Dexie 記録 → 背景 flush | ✅ Stage 4: mirror へ直書き + useLiveQuery 直読み(即時表示は debounce 非依存・smoke 済) |
| 永続 outbox (Dexie キュー) | 必須 | ✅ pending を Dexie 永続 | ✅ Stage 2: Dexie `card_mutations` outbox(enqueue/coalesce/markSynced 等) |
| 冪等 key (mutation_id / event_id) | 必須 | ✅ event_id UNIQUE + ON CONFLICT | ✅ Stage 1 server dedup gate + createCard 冪等 / Stage 2 client mutation_id enqueue |
| in-flight guard (多重送信防止) | 推奨 | ✅ module Set + Web Locks (06c9ba2) | ✅ Stage 2: inFlightMutationIds Set 流用 |
| 失敗時の保全 (pending 残置 / retry / backoff) | 必須 | ✅ pending 残置 + 指数 backoff retry + 429 即停止 | ✅ Stage 2: classifyFlushResults 流用(429 即停止)+ 失敗側 pending 残置を smoke 確認 |
| 古い pending の破棄 (24h drop) | 推奨 | ✅ mount 時 answered_at 判定で drop | ✅ Stage 2: dropStalePendingCardMutations |
| bulk push endpoint (単一 tx + bulk SQL) | 推奨 | ✅ /api/review-events/bulk | ✅ Stage 1: /api/card-mutations/bulk 新設・smoke PASS |
| 多タブ flush 排他 (Web Locks) | 任意 | ✅ runGuardedFlush 最外 lock | ✅ Stage 2: runGuardedCardMutationFlush(`recallmint:card-mutations:flush`)・多タブ live smoke 済 |
| 削除の表現 (tombstone / type 列) | 必須 (削除のある機能) | — append-only | ✅ option 削除=配列除外 / card 削除=tombstone(Stage 1 bulk endpoint の delete op で踏襲・smoke 確認) |

### 8-2. 読み込み (pull)

| ベストプラクティス項目 | 位置づけ | 演習 読込 (最終状態) | 試験編集 (exams/[id]) |
|---|---|---|---|
| UI は IDB のみ参照 (reactive / useLiveQuery) | 必須 | ✅ (cards/study_days/exams 一覧) | ✅ Stage 4: cards mirror を useLiveQuery 直読み(snapshot/二層は不採用)・見出し件数も live |
| ① mount トリガー | 必須 | ✅ | ✅ Stage 3: 詳細 mount で入口 pull kick(ちょうど1本 smoke 済) |
| ② フォーカス復帰トリガー (visibilitychange) | 推奨 | ✅ | ✅ Stage 3: **詳細滞在中は suppress**(離脱で再開)・smoke 済 |
| ③ 再接続トリガー (online) | 推奨 | ✅ | ✅ Stage 3: 同上(滞在中 suppress) |
| ④ インターバル polling | 任意 | ❌ (単一ユーザーで不要) | ⏸️ 入れない(対称) |
| ⑤ push 後 pull-back (派生値再計算の反映) | 推奨 | ✅ flush の実送信成功時(syncedEventIds 非空)に pull-back 発火、FSRS 再計算値を mirror に戻す。3 経路(threshold/完了/controller)の各末尾に hook | ✅ Stage 2 flush 配線 + Stage 3: pull-back は suppress 対象外(詳細滞在中も通る・独立共存 smoke 済) |
| cursor による stale / dedup ガード | 推奨 | ✅ cursor を read して `?since` に使用 | ✅ Stage 3: 共通 pull 基盤を流用(入口 kick/pull-back とも) |
| 増分 pull (?since + merge upsert) | 推奨 | ✅ cards/exams(study_days は full-window 据え置き) | ✅ Stage 3: 共通 pull 基盤を流用 |
| pending 上書き防止 (dirty 保護) | 必須 (編集機能) | — (cards に client 書込なし) | ✅ Stage 4: inline 編集ガード(編集中/送信中は外部値で上書きしない)・カーソル保護 smoke 済。※滞在中 pull-suppress で自 pull×自編集の衝突は発生源から消える |
| pull in-flight guard (多重 pull を1本に) | 推奨 | ✅ runGuardedPull の skip-if-running | ✅ Stage 3: runGuardedPull 流用 |
| 多タブ pull 排他 (Web Locks leader election) | 任意〜推奨 | ✅ recallmint:pull lock | ✅ Stage 3: 流用 |
| 削除の pull 反映 (tombstone) | 必須 (削除のある機能) | ✅ tombstone bulkDelete で明示反映 | ✅ Stage 3: 増分 pull 資産を流用(削除 op の tombstone は Stage 1 で確認済) |

### 8-3. 読み解き (更新)

- 演習 書込: 完成 (変更なし)。
- **演習 読込: 「全件 pull」の本丸を越えた。** step 1(クロック統一)→ step 2(統合 /api/pull)→ step 3(client 増分 merge)で全件 pull → 増分 pull が成立し、削除も tombstone 経由で反映。step 4 でガード(in-flight + Web Locks)とトリガー(visibility/online)を追加。残るは step 5(pull-back)で ⑤ を埋め、step 6(exams 一覧 useLiveQuery 化)、step 7(旧 endpoint 廃止 + study-days now 掃除)。
- 試験編集 書込/読込: **着手済**。方式は「useLiveQuery 直読み + IDB 直書き + 詳細滞在中 pull-suppress」に確定(当初の snapshot 隔離 + 二層 + pending 除外案は複雑さの源として撤去)。Stage 1(server: bulk endpoint + createCard 冪等)smoke PASS、Stage 2-4 が残り。詳細は §12。

### 8-4. 重要な注意 — 全置換 pull は「削除をタダで処理している」(→ 解決済み)

初版の指摘: `clear() + bulkPut()` 全置換は server に無い行を clear で消すため削除が暗黙反映される。増分 pull に変えるとこの「削除のタダ処理」を失う(定石 G)。
→ **step 3 で解決**: tombstone を pull で返し client が bulkDelete することで、増分 pull でも削除が明示反映される。step 3 の stg smoke 観点2 で、stale mirror の削除済エンティティが tombstone bulkDelete でのみ消える「自然 reconciliation」を実データで実証。**「削除反映の仕組みを別途用意するコスト」は tombstone で支払い済み**。

---

## 9. 割り込みタスク完了記録 (試験/カード手動作成 + 削除 + tombstone) — 初版のまま

増分 pull の「削除反映」(§8-4) の前提として、削除を記録する仕組みを先に整備した。本番着地済み。

- **試験手動作成**: OCR レスで名前のみの空試験を作成可能に (`createExam`)。
- **カード手動作成・削除**: 試験詳細に「＋カードを追加」と削除 (2段 confirm) を追加。
- **tombstone テーブル新設** (`tombstones`, migration 0014): exam/card 統合の単一テーブル。`delete-exam`/`delete-card` が記録。記録側のみ実装、読む側は後続(→ step 3 で実装完了)。

---

## 10. 増分 pull 化 進捗 (2026-05-30 時点)

| step | 内容 | 状態 |
|---|---|---|
| 1 | クロック統一 (打刻を DB now() に) | ✅ 完了・[reviewed]・push 済み |
| 2 | 統合 /api/pull 新設 (サーバー単体) | ✅ 完了・[reviewed]・push 済み |
| 3 | client 切替 (増分 merge + tombstone bulkDelete) | ✅ 完了・[reviewed]・push 済み (全件→増分の本丸成立) |
| 4 | pull ガード + トリガー拡張 | ✅ 完了・[reviewed]・force push 済み |
| 5 | pull-back 配線 (flush 成功フック) | ✅ 完了・[reviewed]・force push 済み (初版 FAIL → 5b で実送信成功 gate により構造的に解消) |
| 6 | exams Dexie 化 UI (ExamListLive) | ✅ 完了・[reviewed]・force push 済み (試験一覧が Dexie 参照に、一覧に効く 5 操作へ pull 相乗り) |
| 7 | 後片付け (旧 endpoint 廃止 + study-days now 削除) | ✅ 完了・[reviewed]・force push 済み (最終総合 smoke 全16観点 PASS) |

§8-2 の読込側 未充足 7 項目 (フォーカス/再接続トリガー / pull-back / cursor stale / 増分 pull / 削除 tombstone / pull in-flight / 多タブ Web Locks) は **step 1-5 ですべて充足(本機能の完了基準を達成)**。step 6 で exams 一覧 Dexie 化、step 7 で旧 endpoint 掃除。**増分 pull 化 step 1-7 完結**。最終総合 stg smoke でクロック統一/増分 pull/cursor/inclusive 境界/tombstone bulkDelete/Web Locks/in-flight/トリガー/pull-back/exams Dexie/旧 endpoint 0 request/study-days now 非再生成/dashboard 回帰の全16観点を確認(live 13 + code-invariance 担保 3)。

---

## 11. push / pull トリガー一覧 (実コード棚卸し、2026-05-30 時点)

「どの操作・イベントを起点に push(サーバーへ送る)/ pull(サーバーから取る)が発火するか」の現状一覧。演習(review-events / cards・study_days mirror)と試験編集(exams / cards 詳細)に分けて整理。step 1-5 完了時点の状態 + step 6 で追加予定のもの(「予定」と明記)。根拠: `docs/superpowers/sessions/2026-05-30-push-pull-trigger-inventory.md`。

### 表A. push のトリガー (サーバーへ送る)

| トリガー (起点イベント) | 対象 | 送信先 | 呼出箇所 | 備考 |
|---|---|---|---|---|
| 復習回答 pending 5 件到達 | 演習 | POST /api/review-events/bulk | session-runner.tsx:287 | 即時直叩き / Web Locks 非経由 / 失敗は pending 残置 |
| セッション完了 | 演習 | POST /api/review-events/bulk | session-runner.tsx:313 | 完了 status 書込→全 session group flush / 直叩き |
| mount (アプリ起動・復帰) | 演習 | POST /api/review-events/bulk | review-flush-trigger.tsx:45 | controller 経由 / Web Locks / 前段で 24h 超 pending drop |
| visibilitychange (可視復帰) | 演習 | POST /api/review-events/bulk | review-flush-trigger.tsx:50 | controller 経由 / Web Locks |
| online (ネット復帰) | 演習 | POST /api/review-events/bulk | review-flush-trigger.tsx:54 | controller 経由 / Web Locks |
| retry (backoff) | 演習 | POST /api/review-events/bulk | review-flush.ts:202 | transient(5xx/network)のみ / 5回 10s→30s→1m→5m→15m+jitter / 429 即停止 |
| inline text 編集 blur | 試験編集 | Server Action updateCardField | inline-text-field.tsx:146 | debounce 500ms + queue / revalidate なし |
| 選択肢 cell 編集 blur | 試験編集 | Server Action updateCardField(options) | inline-option-row.tsx (InlineOptionList) | debounce 500ms + queue |
| 選択肢 checkbox 切替 | 試験編集 | Server Action updateCardField(options) | inline-option-row.tsx | 即時(debounce なし) |
| カード追加 click | 試験編集 | Server Action createCard | inline-card-list.tsx:37 | 即時 / revalidatePath('/app/exams') |
| カード削除 確定 | 試験編集 | Server Action deleteCard | delete-card-button.tsx:31 | 即時(2段 confirm) / revalidatePath('/app/exams') |
| 試験作成 submit | 試験編集 | Server Action createExam | create-exam-form.tsx:39 | 即時 / revalidatePath('/app/upload') |
| 試験削除 確定 | 試験編集 | Server Action deleteExam | delete-exam-button.tsx:33 | 即時(2段 confirm) / revalidatePath('/app/upload') |

注: 試験編集の push は REST endpoint でなく Server Action 直書き。演習の push は全て統合 bulk endpoint。

### 表B. pull のトリガー (サーバーから取る)

| トリガー (起点イベント) | 対象 mirror | 経由 | 呼出箇所 | 備考 |
|---|---|---|---|---|
| mount (アプリ起動・復帰) | cards / exams / tombstone | runGuardedPull | pull-trigger.tsx:43 | in-flight guard + Web Locks 有 / 実装済 |
| visibilitychange (可視復帰) | cards / exams / tombstone | runGuardedPull | pull-trigger.tsx:47 | guard 有 / 実装済 |
| online (ネット復帰) | cards / exams / tombstone | runGuardedPull | pull-trigger.tsx:49 | guard 有 / 実装済 |
| mount / visibility / online | study_days | pullAllStudyDays | pull-trigger.tsx:38 | guard 無(idempotent full-replace)/ 実装済 |
| flush 成功 pull-back (controller) | cards / exams / tombstone + study_days | pullBack → runGuardedPull + pullAllStudyDays | review-flush-trigger.tsx:27 | outcome==='ok' のみ / 実装済 |
| threshold-flush 成功 pull-back | cards / exams / tombstone + study_days | pullBack | session-runner.tsx:292 | classify 'ok'(実 sync ≥1) のみ / 実装済 |
| session-complete 成功 pull-back | cards / exams / tombstone + study_days | pullBack | session-runner.tsx:316 | classify 'ok' のみ / 実装済 |
| OCR 完了 (processing→completed) | exams (+ cards 件数) | runGuardedPull | exam-status-live.tsx:83 | reason 'ocr-complete' / step6 実装済 / router.refresh も保持 |
| 試験削除 成功後 | exams / tombstone | runGuardedPull | delete-exam-button.tsx:42 | reason 'exam-delete' / step6 実装済 / 即時 live 消去 |
| 試験作成 成功後 | exams | runGuardedPull | create-exam-form.tsx:44 | reason 'exam-create' / step6 実装済 / 即時 live 表示 |
| カード追加 成功後 | cards | runGuardedPull | inline-card-list.tsx:48 | reason 'card-add' / step6 実装済 / 件数 live 更新 |
| カード削除 成功後 | cards / tombstone | runGuardedPull | delete-card-button.tsx:36 | reason 'card-delete' / step6 実装済 / 件数 live 更新 |

注: pull は全て統合 GET /api/pull(cards/exams/tombstone)+ GET /api/study-days/pull(study_days)。OCR完了/試験作成・削除/カード追加・削除の 5 行は step 6 で「一覧に効く操作への pull 相乗り」として runGuardedPull を既存成功ハンドラに 1 行ずつ追加済み(router.refresh は保持)。これにより一覧の鮮度が即時に保たれる。

### 読み解き

- **演習の push** は「5件閾値 / セッション完了 / mount・visibility・online / retry」の多重トリガーで漏れなく送る(outbox の教科書状態)。
- **試験編集の push** は Server Action 直書き(永続 outbox なし、unmount/reload で揮発)。これは本スレ未着手の課題(§8-1)。
- **pull** は現状「ambient トリガー(mount/visibility/online)+ flush 成功 pull-back(3経路)」で発火。step 6 で「一覧に効くサーバー変更の確定点(OCR完了/試験作成・削除/カード追加・削除)」への即時 pull 相乗りを追加し、一覧の鮮度を常に正しく保つ。
- pull-back の対象に study_days が含まれるのは、復習後の streak/todayCount 即反映のため(full-window 相乗り、§step5)。

---

## 12. 試験詳細画面 (exams/[id]) 書込 local-first 化 — 進捗

### 演習読込 増分 pull 化(前スレ)の到達点
- 演習読込(cards/study_days)+ 試験一覧(exams)は increment pull + Dexie-first(useLiveQuery)+ 削除 tombstone 反映 + 多タブ Web Locks + pull-back + 全トリガー、すべて [reviewed]・develop 着地・最終総合 smoke 16/16 live 実証で完了。
- §8-2 の演習読込側・試験一覧側は ✅。残っていた **試験詳細(exams/[id])= 試験編集側**(§8 の「試験編集」列)に本スレで着手。

### 確定した方式(設計議論の結論)
当初は「入口スナップショット隔離 + component state 二層 + pull の pending-card 除外(dirty-guard)」を検討したが、**複雑さの源(二層管理)**だったため撤去し、以下に確定:

- **表示**: cards mirror を **useLiveQuery で直読み**(表示の真実は IDB 一本、component state 二層を持たない)。
- **書込**: 編集を **mirror へ直書き + Dexie `card_mutations` outbox に enqueue → 背景 flush**。
- **pull**: 詳細入口で1回 pull kick、**詳細滞在中は ambient pull を suppress**(mount で止め unmount で必ず戻す=React cleanup 紐付けで解除し忘れを構造的に防ぐ)、離脱で再開。
- 裏取り: 直読み+直書き+背景同期は大手 SaaS(Notion 等)準拠。Notion は協働ゆえ編集中も pull を止めず CRDT でマージするが、**RecallMint は単一ユーザーなので「滞在中 pull-suppress」で衝突を発生源から消す軽量解**が最適(CRDT 不要)。

### 衝突方針(確定)
- **ケース1(自分の pull × 自分の未送信編集)**: 滞在中 pull-suppress で**そもそも発生しない**。flush 成功 → pull-back は離脱後/再開後の最新化として維持。
- **ケース2(他デバイス変更)**: 後勝ち(到達順 last-writer-wins。whole-field overwrite なので最後に DB に着いた UPDATE が勝つ、時刻比較コードは書かない)。field 単位なので重ならない編集は両立、同一 field のみ後勝ち、`options` のみ配列ごと後勝ち(部分マージ不可・低リスク許容)。client 時計ずれは DB now() 統一(step 1)で回避済。
- **OCC(content_version 照合)/ CRDT / field 単位 merge / 複数人協働**: defer(content_version の器は残置、v1.x)。将来 multi-user 化したら pull-suppress はマージ方式に置換が必要。

### 段階構成と進捗(縦切り・依存順 1→4、各段とも単独 stg smoke 可)
- 確定 spec: `docs/superpowers/specs/2026-05-30-exam-detail-local-first-write-design.md`(`9bdfcff`)
- 確定 plan: `docs/superpowers/plans/2026-05-30-exam-detail-local-first-write.md`(`de68f0c`)

| Stage | スコープ | 状態 |
|---|---|---|
| 1 | server: 既存3 action の core を共有純関数に抽出 + `/api/card-mutations/bulk` 新設(`mutation_id` UNIQUE dedup)+ `createCard` 冪等化(client id + ON CONFLICT)。旧 path 温存・UI 無改修 | ✅ **stg smoke 3観点 PASS / closure**(`6c5a69b`・`c75ea16`・`2fc6a60`、[reviewed] amend) |
| 2 | client: Dexie `card_mutations` write/(card_id,field) coalesce + flush + 新 lock の runGuardedCardMutationFlush + 演習 controller 再利用 + layout 常駐 trigger(ambient + pagehide)。UI 未配線 | ✅ **stg smoke PASS / closure**(①synced ②server反映 ③pull-back + 失敗系 pending 残置 + 多タブ Web Locks live。coalesce は unit 担保で見送り)(`205a02e`・`017ea87`・`3f73c14`、[reviewed] amend) |
| 3 | pull: 詳細滞在中 pull-suppress gate(mount で on・unmount で必ず off)+ 入口 pull kick。※「pending-card 除外」は方式変更で廃案 | ✅ **stg smoke 観点1-5 PASS / closure**(入口 kick ちょうど1本 / 滞在中 suppress / 離脱 resume / pull-back 対象外・独立共存 / A→B soft nav で gate 再評価)(`9de2121`・`6923236`、[reviewed] amend) |
| 4 | UI cutover: useLiveQuery 直読み + 編集/追加/削除を「mirror 直書き + outbox enqueue」へ + debounce を drain へ移設 + 旧 server action 撤去・dead 棚卸し | ✅ **stg smoke PASS / closure**(①即時反映 ②reload 永続 ③server 反映+件数 live ④再入場 ⑤多タブ Web Locks ⑥mobile ＋ auto-edit fix + 論点A probe 再現なし)(`cfb36b9`・`8a59a95`・`549ff34`・`99045b1`・`ebb8c20`・論点B `fa0740b`・auto-edit `0b0a935`、[reviewed] amend 済・develop・OT push 待ち) |

**完了サマリ(2026-05-31)**: Stage 1-4 すべて stg smoke PASS・[reviewed]。試験詳細の card 編集が local-first 化(useLiveQuery 直読み + IDB 直書き + outbox 背景 flush + 滞在中 pull-suppress)。auto-edit 不起動(`0b0a935`)・見出し件数 stale(論点B `fa0740b`)は fix 済。論点A(split-batch 遅延)は probe で再現なし=データ欠損なし確認。論点C(card_count 楽観更新の不実施=double-count 回避)は承認。残課題は無し。7 commit に [reviewed] amend 済(develop、HEAD `0b0a935`)、OT が host から force push 予定。将来 multi-user 化時のみ pull-suppress→マージ方式の置換が必要(その時点の課題)。

### 運用規律(前スレで確立、踏襲)
- 段階的: plan → OT 承認 → 実装(Subagent-Driven, TDD)→ [no-review] commit → OT push(host) → stg smoke → [reviewed] amend → force push。各 Stage 完了で停止し OT 判断待ち。
- 実機 smoke は全機構を端から端まで。code-invariance での省略は最小限。real データ非破壊は test データ局所化で。
- claude.ai は repo を直接読まない。確認は Claude Code に prompt で依頼。long prompt は討議+推奨 → OT 承認後に単一コードブロック。多選択肢は必ず推奨+理由。公式 doc の裏取りなしに技術判断を確定しない。
- 参照: 本ドキュメント §8-1/§8-2 の「試験編集」列、§3 設計含意、§11 push トリガー表の試験編集行。
