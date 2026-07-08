# グループ A: server invariant 独立 fix — design spec

- 日付: 2026-07-08 / branch `develop`
- 出所: `docs/audit/2026-07-08-server-invariant-verification.md`(REAL 2 / 部分的 2 のうち、aggregate 設計を待たず独立 fix できる 3 件)
- 位置づけ: 完全 DDD(F1〜F3)と独立の先行 sprint。②(session guard)/ ③ is_correct 再計算 / ④ fix M(webhook populate)は DDD 同梱で**対象外**。
- 性質: **behavior-changing**(invariant 追加 = 不正 payload を弾く方向の意図的変更)。正当な既存操作(正常なタグ付与・正しい解答・正常なプラン変更)を壊さないことが最優先の完了条件。

## 共通事実(fact-finding 確定・両 outbox の reject 後挙動)

server が mutation/event を 'failed' にした場合、client 側は該当項目を pending 残置して次 flush で再送し、`dropStaleByKey`(`lib/sync/outbox-ops.ts:69`)が maxAge 超過 pending を client 側 'failed' に隔離する。**reject は無限再送(poison pill)にならず有界**。既存の server 検証失敗(owner mismatch 等)と同じ経路。

---

## A-1: single カテゴリ制約の server enforce

### 事実(確定)

- **client は「置換」(ラジオ的)**: `lib/tags/build-next-tag-set.ts:33-38` — single カテゴリで別 option を選ぶと同カテゴリ既存を全削除して新 option を add(再クリックは解除)。`lib/tags/tag-crud.ts:445-454`(handleCreateOptionAndAssign)も同じ意図。**正常 client が送る whole-set は single カテゴリにつき常に ≤1 個**。
- server `handleTagOptionIds`(`lib/cards/card-field-handlers.ts:192-241`): 検証 = ① uuid[] 形式 ② 重複排除 ③ card 所有 ④ option 全件の存在+所有(id のみ SELECT)。**category / select_type を見ない**。失敗は全て理由文字列なしの `'failed'` + 副作用なし(既存作法)。
- card_tags への他の書込経路 = `apply-ocr-tags.ts` のみで、selectType `'multi'` hardcode(:132)につき single 制約に抵触しない(現 HEAD 再確認済)。

### 設計判断: 不正 payload(single カテゴリに 2 個)の扱い

**推奨 = (a) mutation ごと reject(`'failed'`・副作用なし)**。

- (b) 「server が 1 個に絞って置換」は不採用: payload は whole-set replace であり、矛盾した set のどれを残すかを server が選ぶのは新しい意味論の発明(client の「置換」は toggle 操作の意味論で、set 内矛盾の解決規則ではない)。
- 正常 client はこの分岐に**到達しない**(上記事実)ため、reject でも既存 UX は不変。既存 server 検証(owner mismatch 等)と同一の 'failed' 作法・同一の伝播経路に乗る。

### 実装方針

`handleTagOptionIds` の検査 ④ を拡張: tag_options SELECT に `categoryId` を追加取得 → 対象 category の `tag_categories.select_type` を owner-scope SELECT → categoryId で grouping → `select_type='single'` かつ同カテゴリ 2 個以上 → `'failed'`(DELETE/INSERT 前・副作用なし)。見積り 40〜60 行 + test。DB trigger は既存方針(trigger ゼロ)に反するため application 層のみ。

### 付随項目の訂正(スコープ除外)

kickoff の「tag_options UNIQUE(category_id,name) が実 DB に不在」は**誤り** — `schema.ts:725` + `drizzle/migrations/0020_rare_magneto.sql:43` + **実 DB pg_indexes に `tag_options_category_name_uq` を物理確認済**。前回監査は `information_schema.table_constraints` を見たが、drizzle の `uniqueIndex()` は UNIQUE INDEX(constraint ではない)を作るため同 view に出ない(enforce 効果は同一)。audit doc は訂正済み。**本 sprint での DB 制約追加は不要**(= migration も不要)。

### テスト

`card-field-handlers.test.ts` の既存 makeTagTx 構造に追加: single カテゴリ 2 個 → failed(DELETE/INSERT 不発)/ single 1 個 + multi 複数混在 → applied / multi のみ複数 → applied / 複数 single カテゴリに各 1 個 → applied(境界)。

---

## A-2: selected_answer_ids の存在検証

### 事実(確定)

- option id は**任意 string(uuid ではない)**: `lib/db/schema.ts:46-51` CardOption.id。client は click した option.id をそのまま送信(`lib/sync/review-events.ts:309`)。現検証は `z.array(z.string().min(1)).max(50)` のみ(`lib/validation/review-session-bounds.ts:11`・既知 deferral)。
- ingest Phase 1 の cards SELECT(`lib/reviews/ingest-review-events.ts:108-132`)は FSRS 列のみで **options を取得していない**。
- 既存の reject 語彙 = **orphanFailed**(card 不在 :154-162)+ **txFailed**(:384-399)。failed[] は HTTP 200 の body で返り、client は pending 残置 → stale 隔離(共通事実)。duplicate は failed に入れず silent skip。
- **正当 race が実在**: options は `update_field`('options')mutation で編集可能(`card-field-handlers.ts:158-175`)。「回答時点で実在した option id が、flush 前の options 編集で ingest 時点には消えている」が local-first 上起こりうる。server は「編集で消えた正当 id」と「捏造 id」を**区別できない**(answer 時点 snapshot を持たない)。

### 設計判断: 実在しない option id を含む event の扱い

**推奨 = (a) event ごと reject(failed[] へ・orphan と同列)**。

- (b) 「不正 id のみ除去して有効 id で続行」は不採用: 保存されるのは「ユーザーが実際に click した記録」であり、server が中身を改変すると answer_events の監査価値が壊れる。全 id 不正時は結局 reject が必要で分岐も増える。
- reject の trade-off(明記): 上記 race に該当する**正当な回答 1 件が失われうる**(stale 窓まで再送 → client 側隔離)。ただし race 窓は「回答 → options 編集 → flush」の順序が揃う稀なケースに限られ、失われるのは当該 review 1 件のみ(card は再 due で学習進行は自己回復)。捏造 id の混入防止(データ衛生)を優先する。
- **実害の追加確認(2026-07-08・OT 指示)**: client は FSRS をローカル計算しない(回答 = Dexie answer_events insert のみ `session-runner.tsx:287`、FSRS は server `replayCard` 一元 `ingest-review-events.ts:230`、flush 成功時 pull-back で mirror 反映)。よって reject の影響 = 「card の FSRS が進まず due のまま次セッションに再出現」(不正解時の再出題と同じ体験)+ streak/study_days の 1 カウント欠落のみ。巻き戻り・破損・複利的歪みは無い(以後の review は実状態から正しく計算)。**軽微確認済 → reject 確定**。
- **自己回復の due 判定裏取り(2026-07-08・plan 承認条件・コード読解)**: reject event は `applicableEvents` から除外され(`ingest-review-events.ts:154-165`)、`eventsToApply`/`grouped`/`finalStates` に入らないため当該 card の cards UPDATE は発行されず **FSRS state 不変(破損でなく非更新)**。state 不変 = `due` が前の過去値のまま → 次 session の `getDueCardsFromDexie` が `between([uid,'0'],[uid,nowIso], true, true)` = `due <= now` で再度拾う(`get-dexie-session-cards.ts:42`)= **再 due 再出題で自己回復**。停止条件(回復しない/state 破損)非該当。
- 検証は「対象 card の options に id が実在するか」まで。**is_correct の照合・再計算はしない**(F2 帰属・deriveRating intentional 契約に触れない)。別 card の実在 id も「対象 card の options に無い」ので同じ検査で弾ける。

### 実装方針

Phase 1 cards SELECT に `options` を追加 → `cardId → 有効 optionId Set` の Map を構築 → applicable フィルタ(orphan 判定の直後)で `selected_answer_ids` に Set 外の id を含む event を failed[] へ。見積り ~40 行 + test。

### テスト

contract test(`tests/contract/review-events-bulk.contract.test.ts`)に追加: 実在 id → applied / 存在しない id 混入 → その event のみ failed[](他 event は applied)/ 別 card の実在 id → failed[] / 全 id 実在の複数選択 → applied。

---

## A-3: upgrade 整合窓の observability

### 事実(確定)

- 窓の実体は audit doc §④-追補で確定済: changePlan downgrade の DB 3 列 UPDATE(`app/(app)/app/upgrade/actions.ts:141-145`)失敗は silent・webhook で自己修復せず最長 1 課金周期持続。cancelDowngrade の clear(:176-180)失敗は webhook 自己修復(数秒)だが同じく silent。
- notifyOps 作法(`lib/ops.ts:23`): `notifyOps(subject, context)`・subject は小文字フレーズ(既存例 `'plan change: subscription unresolved'`)・context に `environment: runtimeEnv()` + `timestamp` + 関連 id。
- `redirect()` は throw でフロー制御するため、**try/catch は db.update のみを包み redirect を巻き込まない**。

### 設計

2 箇所(changePlan downgrade / cancelDowngrade)の db.update をそれぞれ try/catch で包み、**notifyOps → rethrow**(ユーザー向け挙動 = 汎用エラーのまま不変・検知だけ追加)。共通 helper は作らない(2 箇所・rule of three 未満)。

- subject: `'plan change: db write failed after stripe success'`(1 subject・context.operation で区別 — 既存 `'plan change: '` prefix に整合)
- context: `operation`('scheduleDowngrade' | 'cancelDowngrade')/ `userId` / `operationId` / `scheduleId` / `targetPriceId`(downgrade のみ)/ `error` / `environment` / `timestamp`。scheduleId が通知に載ることで OT 手動修復が可能になる(schedule metadata の userId/targetPriceId と照合)。
- notifyOps 自体の失敗は notifyOps 内部で握られる(呼出元を巻き込まない設計・確認済)ため、二重 catch 不要。

### テスト

actions の unit test: db.update を reject させ ① notifyOps が上記 subject + context で呼ばれる ② エラーが rethrow される(redirect に到達しない)を assert。正常系(db.update 成功 → notifyOps 不発 → redirect throw)も 1 本。

---

## A-4: 退会時の自己誘発 webhook 偽アラート fix(2026-07-08 追加・OT 承認済)

### 事実(確定・詳細 = `docs/audit/2026-07-08-deletion-self-induced-webhook-alarm.md`)

- 削除カスケードの Stripe 即時 cancel が `customer.subscription.deleted` を発火(正常な副産物)→ handler の UPDATE は soft-delete 行(stripe_customer_id 保持)に **1 行 match して正常成功** → しかし `handle-stripe-event.ts:263` が「RETURNING の clerkId 非 null」を「行 match」の **proxy に誤用**しており、GDPR scrub(clerkId=NULL)行を「行なし = 整合崩壊」と誤判定 → `notifyOps('stripe sub event for unlinked customer')` 誤発火(:269-275)。
- **構造的・毎回**(paid 退会ごと・env 非依存で prod でも)。同型 proxy 誤りは `.created/.updated` 分岐(:227-239)にも存在。DB 更新自体は正しい(解約終端状態)。害は偽アラートのみ。

### 設計

**notifyOps の発火条件のみ変更・webhook の DB 更新挙動は不変**。「真の整合崩壊(行が本当に無い)は引き続き通知する」を不変条件とする(偽アラートを消すために本物を殺さない)。

fix の形は plan でサイズ見積もりの上で確定(OT 指示):

- **root fix(推奨候補)**: clerkId proxy を実際の行 match 判定(RETURNING 行の有無)に置換 — `.deleted` / `.created/.updated` の 3 分岐すべて。metadata sync の要否(clerkId 有無)と「行 match の有無」を独立に判定する。3 分岐で S〜M に収まるならこちら。
- **症状 fix(fallback)**: root fix が L に膨らむ場合のみ。`.deleted` の RETURNING に `deletedAt` を追加し「match 有 + deleted 済 = 自己誘発 → 無害 skip」「match 0 行 = 真の整合崩壊 → 通知」を区別。proxy の根本整理は F1 に送る。

### テスト

route.test.ts(webhook)に追加: scrub 済み soft-delete 行への `.deleted` → DB 更新は従来どおり + notifyOps **不発** / 行なし(unlinked)への `.deleted` → notifyOps 発火(既存挙動維持)/ root fix 採用時は `.updated` の同型ケースも。

### stg smoke

退会フロー実走(stg のテスト sub で削除)→ Discord に偽アラートが**出ない** + DB 終端状態は従来どおり。真の整合崩壊ケースの実走は不可能(行を消す破壊的操作)のため unit test を正とする(規律準拠でここに明記)。

---

## Sprint 全体の完了条件・gate

- 各 fix: テスト可能 + canonical review Critical 0 + Codex review(未解決 Critical/Important 0)+ `[reviewed]`。**commit は A-1 / A-2 / A-3 / A-4 で分離**(DB 制約変更は発生しないため形の変更 commit は無し)。
- **A-3 は決済絡み** → 重要 fix の裏取り規律により review pass → commit(tag 無し)→ OT 実機確認後に [reviewed] 追記。
- sprint 完了 gate: whole-repo `pnpm lint --max-warnings=0` exit 0 + `pnpm test` 全通過(依存/Next/Node/lockfile は触らないため install/typecheck/build gate は対象外)。
- 既存 test への影響: 不正 payload を弾く方向の変更につき、既存正常系 test は不変のはず。変わる場合は「invariant 追加による意図的変更」として個別に妥当性を確認して記録。

### stg smoke 計画(push 後・OT 指示で CC が DevTools MCP 実走)

- **A-1**: 正常タグ toggle(single カテゴリで置換動作)が通る + DevTools console から entity-mutations/bulk へ「single カテゴリ 2 option」payload を直接 POST → failed 応答 + DB 不変。
- **A-2**: 正常回答 flush が applied + 「存在しない option id」event の直接 POST → failed[] に入る + answer_events 不挿入。
- **A-3**: 正常プラン変更(stg = Stripe test mode)が従来どおり動く(通知が誤発火しない)。**DB 失敗の意図的注入は unit test を正とし、実走は OT 実機領域として列挙**(破壊的操作のため)。この smoke 代替は本 spec に明記済み(規律準拠)。

## Out of scope(再掲)

② session completed guard(F2)/ ③ is_correct server 再計算(F2・契約判断)/ ④ fix M = subscription_schedule.created handler + 購読追加(F1)/ tag_options UNIQUE 追加(実在確認により不要)。
