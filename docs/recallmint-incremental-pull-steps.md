# ★ RecallMint 演習読込 増分 pull 化 — 全ステップ詳細

> ★ **重要設計リファレンス（恒久）**: 増分 pull 化 step 1-7 + 試験詳細 local-first 化 Stage 1-4 の実装ステップ詳細。各 step の設計判断・難所・確定方式を保持する。定石との対応・根拠は対の [`recallmint-idb-sync-bestpractice-comparison.md`](./recallmint-idb-sync-bestpractice-comparison.md)。

> ✅ **全 7 step 完全完了(2026-05-30)**。step 1-7 が develop に [reviewed] 着地・push 済み。最終総合 stg smoke **全16観点 PASS(16/16 すべて live 実機実証)**。§8-2 の読込側 7 項目を全充足し、全件 pull → 増分 pull が成立、試験一覧も Dexie 化、旧 endpoint も掃除済み。当初 code-invariance 担保だった 3 観点(復習 push クロック / pull-back positive-fire / offline→online)も test データ局所化で live 実証し直し、real データ(2 試験/52 card)非破壊を確認済み。

- 確定 spec: `docs/superpowers/specs/2026-05-29-incremental-pull-design.md`
- 進め方: 段階的に plan 化 → 実装 → push(OT, host) → stg smoke → 次段
- 各段で stg smoke を挟む。commit は `[no-review]` → push → smoke 全PASS → `[reviewed]` へ amend

---

## 確定事項(全段に効く所与)

- **スコープ**: cards / exams を増分 pull 化。exams は試験一覧UIを Postgres 直読み → Dexie mirror(useLiveQuery) へ切替。study_days は据え置き(updated_at 列なし・90日 full-window)。
- **API は統合**: 単一 `/api/pull` に集約(cards delta + exams delta + tombstone delta + ストリーム別 3 cursor + maxUpdatedAt を 1 round-trip)。新設は step 2、client 載せ替えは step 3、旧 endpoint 廃止は step 7。新旧併存は step 2〜3 の一時的なもの。
- **クロック**: cursor 比較に乗る打刻を DB クロック(SQL `now()`)に統一(step 1 で完了)。
- **cursor / 削除**: inclusive(`>=`) + 受信側 id 冪等適用(Dexie bulkPut/bulkDelete)。cursor はストリーム別 3 本独立(`sync_meta` の `cardsCursor` / `examsCursor` / `tombstoneCursor`、それぞれ cards updated_at / exams updated_at / tombstone deleted_at の max)。next-cursor = 返却行の max、0件は据え置き。削除は tombstone を返し client が bulkDelete。
  - 注: cursor key は step 3 実装で旧 `last_card_pull_at` 等(pull 時刻を表す名)から `cardsCursor`/`examsCursor`/`tombstoneCursor`(中身=cursor と一致する名)へ改称・旧 key 撤去済み。ユーザー0・DB全消去可のため移行考慮は不要だった。
- **exams card_count**: IDB の cards mirror から算出。exams.updated_at 凍結には触らない。
- **pull-back / トリガー / ガード**: flush 成功フックに pull-back(cards + study_days) 相乗り。pull トリガーを mount + visibilitychange + online に拡張。pull に 1タブ内 in-flight guard + 多タブ Web Locks(G-2、push 側流用)。

---

## Step 1: クロック統一 ✅ 完了(本番前段=develop に [reviewed] 着地)

打刻を App クロック(`new Date()`) → DB クロック(`sql\`now()\``)に統一。schema 不変。

- (a) card inline 編集の updated_at(`update-card-field.ts`)
- (b) 復習 bulk push の updated_at(`bulk/route.ts`、SET句のみ。FSRS値=ISO bind は据え置き)
- (c) tombstone の deleted_at(`delete-card.ts` / `delete-exam.ts`、exam+配下card を同一tx now() で揃える)

**状態**: 4 commit [reviewed] 化済み、stg smoke 全5観点 PASS。
**位置づけ**: 後続の inclusive cursor 比較が App↔DB skew で取りこぼさない前提を作る。

---

## Step 2: 統合 `/api/pull` 新設(サーバー単体) ✅ 完了(develop に [reviewed] 着地、push 済み)

統合 endpoint を立て、サーバー単体で検証する。**client はまだ載せ替えない**(旧 endpoint を使い続ける)。

- `?since` をストリーム別 3 本受領(cards / exams / tombstone)。欠落時は全件 fallback(初回 pull)、ISO 検証。
- inclusive(`>=`)でクエリ。cards/exams は `updated_at >= since`、tombstone は `deleted_at >= since`。
- DB 入口が `{rows, maxUpdatedAt}` を返す(0件は maxUpdatedAt=null)。
- レスポンス: cards delta + exams delta + tombstone delta + 3 cursor を単一レスポンスで。
- 既存 cards/pull・exams/pull・study-days/pull は残す。

**plan で詰める点**: ?since の受け方(param名/fallback/検証)、DB 入口(既存関数に since 追加で流用 vs 新関数)、tombstone 用 DB 入口、maxUpdatedAt 算出、レスポンス型(既存 mapper 流用 + tombstone 行の型)。
**この段固有の論点**: client なしで endpoint をどう smoke するか(直叩きの認証 = OT hand-off の cookie/token 等)。

---

## Step 3: client 切替(統合 endpoint 参照 + 増分 merge) ✅ 完了(develop に [reviewed] 着地、push 済み)

client を統合 `/api/pull` に載せ替え、全置換 → 増分 merge に変えた。UI 経由 stg smoke 全6観点 PASS、3 commit [reviewed] 着地。**これで全件 pull → 増分 pull の本丸が成立**(server=step 2 + client=step 3)。観点2(tombstone 削除反映)は stale mirror の自然 reconciliation で実証、観点4(2回目以降 差分のみ)も確認済み。

- **cursor read 側新設**: `sync_meta` の cursor 3本(`cardsCursor` / `examsCursor` / `tombstoneCursor`) を read。旧 `last_card_pull_at` 等の dead-write key は撤去し、cursor の実体に合った新 key 名へ改称。pull 前に cursor を読んで `?since`(snake_case 3本: `since_cards`/`since_exams`/`since_tombstone`) に乗せる。
- **増分 merge**: `clear()` 撤去 → `bulkPut()`(id upsert)。
- **tombstone bulkDelete**: 返ってきた tombstone を entity_type 別に bulkDelete(`card` → cards / `exam` → exams)。
- **1 tx 化**: `db.transaction('rw', cards, exams, sync_meta)` で merge upsert + tombstone delete + cursor 3本更新(null skip)。失敗時は tx 前 return で不変性維持。
- **レスポンス validation**: 旧 `now` 前提 → 統合レスポンス形(`{cards, exams, tombstones, cursors}`)対応。
- client pull 処理を 1本の orchestrator `pullDelta` に統合。study_days は新 endpoint に含めず旧 study-days/pull で並走(別 helper・別 tx)。

**完了で**: 全件 pull → 増分 pull が成立。削除が tombstone 経由で mirror に反映(§8-4 の「全置換の暗黙削除を失う代わりに tombstone 反映が必須セット」の実装)。

---

## Step 4: pull ガード + トリガー拡張 ✅ 完了(develop に [reviewed] 着地・push 済み)

増分化で新たに生じた cursor の read→write 競合を防ぐガードと、更新タイミングを足した。UI 経由 stg smoke 全5観点 PASS、2 commit [reviewed]・force push 反映済み。§8-2 の「pull in-flight / 多タブ Web Locks / フォーカス・再接続トリガー」3項目を充足。観点1(多タブ Web Locks)は follower 側を実 Web Locks 機構で検証(leader 保持時間のみ模擬、cursor 破損なし)。

実装内容:

- **1タブ内 in-flight guard**: step 3 で作成した pull orchestrator(`pullDelta`)を包む `runGuardedPull` に module-scope の skip-if-running boolean。二重 mount / 重複 kick を coalesce。
- **多タブ Web Locks**: pull 用 lock 名(例 `recallmint:pull`)で push 側 `runGuardedFlush`/`MinimalLockManager`/`resolveLocks` を流用。`ifAvailable:true` skip(leader が書けば他タブは useLiveQuery で追従)。
- **トリガー拡張**: 現状 mount のみ → mount + visibilitychange(visible) + online(push 側 flush trigger と同型)。

---

## Step 5: pull-back 配線(flush 成功フック) ✅ 完了(develop に [reviewed] 着地・force push 済み)

復習 push 後に FSRS 再計算値を mirror に戻す(§8-2 ⑤ の解決)。UI 経由 stg smoke 全5観点 PASS、step5 全 feat 6 commit [reviewed]。**これで §8-2 の読込側7項目が全部充足、本機能の完了基準を達成。**

設計の要点(初版 FAIL → 再設計 5b で構造的に解消):
- pull-back の発火条件は **「実際に events を send して成功した(syncedEventIds 非空)」**。skip(in-flight 空振り)/ session-only / 失敗では発火しない。classifyFlushResults の 'ok' を「failed 無し かつ 実 sync ≥1 件」に再定義。
- フックは **3 経路**(threshold flush / session 完了 flush / controller onFlushed)の各末尾に置き、各々が実送信成功時のみ発火。pull-back の中身(pullBack helper)は共通1つ。複数発火しても step 4 の in-flight guard で /api/pull 1本に絞る。
- 初版 FAIL の原因: daily=5=threshold の race で、完了 flush が threshold flush の in-flight 中で空振り(attempted:0)したのを 'ok' と誤分類し commit 前に premature 発火 → stale 取得。再設計で「syncedEventIds は bulk POST 200(tx commit 後)後にのみ set」を gate にし、pull-back が構造的に必ず commit 後になるよう解消。
- pull-back 対象 = cards(FSRS後値を増分 pull) + study_days(full-window 相乗り)。dashboard dueCount は useLiveQuery で再 mount 不要 live 反映。

---

## Step 6: exams Dexie 化 UI(試験一覧) ✅ 完了(develop に [reviewed] 着地・force push 済み)

dead read だった exams mirror を生かした。試験一覧を Postgres 直読み → Dexie mirror(useLiveQuery)参照に切替。UI 経由 stg smoke 全7観点 PASS、feat 2 commit [reviewed]。**OT 当初の「試験一覧の読み取りを軽くする(毎回 Postgres 直読みしない)」動機が実現。**

- 試験一覧の list を `ExamListLive`(client)に抽出、useLiveQuery で exams mirror(archived 除外・updated_at DESC)。card_count は cards mirror を 1 read して JS 集計(exams.card_count 列は読まない)。skeleton/空状態/list の 3 状態。
- RSC(page.tsx)は auth/statusMap/CreateExamForm/見出し保持。dead 化した getActiveExamsWithCardCount は撤去。
- 一覧に効く 5 操作(OCR完了/試験削除/試験作成/カード追加/カード削除)の成功ハンドラに runGuardedPull を 1 行相乗り。既存 router.refresh/push 保持、失敗時不発、カード編集は対象外。smoke で削除/作成/カード件数の即時反映を reason 付きで実証。

---

## Step 7: 後片付け ✅ 完了(develop に [reviewed] 着地・force push 済み)— 増分 pull 化 step 1-7 完結

旧 full-snapshot endpoint と dead 化した DB 入口/cursor を撤去。最終総合 stg smoke 全16観点 PASS、掃除 2 commit [reviewed]。

- 旧 /api/cards/pull・/api/exams/pull(route+test)廃止。client は統合 /api/pull に移行済み。
- dead 化した getAllCardsForUser/getAllExamsForUser 撤去(upload が使うのは別関数 getActiveExamsForUser、grep 確認済)。delta 関数/mapper/maxIso は温存。
- study-days/pull の now フィールドを server response → client write → cursor 定数(lastStudyDayPullAt)まで連鎖撤去(dead-write 掃除、E-b 確定)。
- B1(lock util 共通化)は見送り(reviewed 済 file の churn vs 価値、3つ目の consumer 未出、step 4 U2 と一貫)。
- 過渡期 404 はユーザー0で実害なし、即削除(段階廃止しない)。

**最終総合 smoke**: step 1-7 の全機構(クロック統一/増分 pull/cursor/inclusive 境界/tombstone bulkDelete/Web Locks/in-flight/トリガー/pull-back/exams Dexie/旧 endpoint 0 request/study-days now 非再生成/dashboard 回帰)を端から端まで確認、**全16観点 live 実機実証**(当初 code-invariance 担保だった 3 観点も test card 局所化で live 実証し直し、real データ非破壊を確認)。

---

## 完了基準(全段通しての達成目標)

比較ドキュメント §8-2 の読込側 未充足 7 項目が埋まること:
1. フォーカス復帰トリガー(visibilitychange) — step 4
2. 再接続トリガー(online) — step 4
3. push 後 pull-back(FSRS 再計算値の反映) — step 5
4. cursor stale ガード(増分 pull の cursor) — step 2-3
5. 増分 pull(?since + merge upsert) — step 2-3
6. 削除の tombstone 反映 — step 2-3
7. pull in-flight guard / 多タブ Web Locks — step 4

加えて: cards / exams の全件 pull が増分 pull になること。

→ **全項目達成。増分 pull 化 step 1-7 完全完了。**

---

## 次の workstream — 試験詳細画面(exams/[id])書込 local-first 化 [進行中]

### これまでの到達点(増分 pull 化で完了したこと)
- 演習読込(cards/study_days mirror)+ 試験一覧(exams mirror)は increment pull + Dexie-first(useLiveQuery)+ 削除 tombstone 反映 + 多タブ Web Locks + pull-back + 全トリガー、すべて [reviewed]・本番前段(develop)着地済み。
- 一覧に効くサーバー変更の確定点(OCR完了/試験作成・削除/カード追加・削除)に runGuardedPull を相乗りし、一覧の鮮度を即時に保つ。
- 旧 full-snapshot endpoint は廃止済み、pull は統合 /api/pull 1 本 + study-days/pull(study_days は full-window 据え置き)。

### 確定した方式
詳細画面の書込を演習側 outbox/flush/pull-back と対称な local-first にする。当初の「snapshot 隔離 + component state 二層 + pull の pending-card 除外」は複雑さの源として撤去し、以下に確定:

- **表示**: cards mirror を useLiveQuery で直読み(表示の真実は IDB 一本)。
- **書込**: 編集を mirror 直書き + Dexie `card_mutations` outbox に enqueue → 背景 flush(bulk endpoint)。
- **pull**: 詳細入口で1回 kick、**滞在中は ambient pull を suppress**(mount で止め unmount で必ず戻す)、離脱で再開。
- **衝突**: ケース1(自 pull × 自編集)は滞在中 pull-suppress で発生源から消える。ケース2(他デバイス)は到達順 last-writer-wins(field 単位、options は配列ごと)。OCC/CRDT/複数人協働は defer。
- 裏取り: 直読み+直書き+背景同期は大手 SaaS(Notion 等)準拠。pull-suppress は単一ユーザー版の軽量解(協働 SaaS が CRDT で解く問題を発生源から消す)。

### 段階構成と進捗(縦切り・依存順 1→4)
- 確定 spec: `docs/superpowers/specs/2026-05-30-exam-detail-local-first-write-design.md`(`9bdfcff`)
- 確定 plan: `docs/superpowers/plans/2026-05-30-exam-detail-local-first-write.md`(`de68f0c`)

| Stage | スコープ | 状態 |
|---|---|---|
| 1 | server: 既存3 action の core を共有純関数に抽出 + `/api/card-mutations/bulk` 新設(`mutation_id` UNIQUE dedup)+ `createCard` 冪等化(client id + ON CONFLICT)。旧 path 温存・UI 無改修 | ✅ **stg smoke 3観点 PASS / closure**(`6c5a69b`・`c75ea16`・`2fc6a60`、[reviewed] amend) |
| 2 | client: Dexie `card_mutations` write/coalesce + flush + 新 lock の runGuardedCardMutationFlush + 演習 controller 再利用 + layout 常駐 trigger(ambient + pagehide)。UI 未配線 | ✅ **stg smoke PASS / closure**(①synced ②server反映 ③pull-back + 失敗系 + 多タブ Web Locks live、coalesce は unit 担保)(`205a02e`・`017ea87`・`3f73c14`、[reviewed] amend) |
| 3 | pull: 滞在中 pull-suppress gate(mount で on・unmount で off)+ 入口 pull kick | ✅ **stg smoke 観点1-5 PASS / closure**(入口 kick ちょうど1本 / 滞在中 suppress / 離脱 resume / pull-back 対象外・独立共存 / A→B soft nav 再評価)(`9de2121`・`6923236`、[reviewed] amend) |
| 4 | UI cutover: useLiveQuery 直読み + 編集/追加/削除を mirror 直書き + outbox enqueue へ + debounce を drain へ移設 + 旧 server action 撤去 | ✅ **stg smoke PASS / closure**(①即時反映 ②reload 永続 ③server 反映+件数 live ④再入場 ⑤多タブ Web Locks ⑥mobile ＋ auto-edit fix + 論点A probe 再現なし)(`cfb36b9`〜`ebb8c20`・論点B `fa0740b`・auto-edit `0b0a935`、[reviewed] amend 済・OT push 待ち) |

**完了(2026-05-31)**: 試験詳細 書込 local-first 化 Stage 1-4 全完了。演習読込 + 試験一覧 + 試験詳細書込、すべて local-first 化済み。論点A(split-batch 遅延)= probe 再現なし・データ欠損なし。論点B(見出し件数 stale)= fix 済。論点C(card_count 楽観更新の不実施)= double-count 回避で承認。7 commit [reviewed] amend 済(develop、HEAD `0b0a935`)、OT が host から force push 予定。将来 multi-user 化時のみ pull-suppress→マージ置換が課題。

参照: 比較ドキュメント(recallmint-idb-sync-bestpractice-comparison)§8-1/§8-2 の「試験編集」列・§12 進捗、本 workstream の spec/plan。

運用規律(踏襲): 段階的に plan 化 → 実装(Subagent-Driven, TDD)→ [no-review] commit → OT push(host) → stg smoke → [reviewed] amend → force push。実機 smoke は「全機構を端から端まで」確認し、code-invariance での省略は最小限に。real データ非破壊は test データ局所化で。
