# RLS-P2 spec 前 現場確認(user lifecycle / null 契約 / affected rows / Phase 2 closure)

- 日付: 2026-07-20 / branch: `develop`(HEAD `e10ce32`)
- 目的: GPT 最終アーキテクチャレビューの修正指摘 4 件のうち現状実装に依存する項目の**事実確認**。過去の「削除済みユーザーの再削除エラー」系バグの安定化実装を正確に把握し、既存挙動の保全を最優先とする(kickoff 指定)。
- **本 doc は調査のみ・変更なし**。設計提案は §4.2 の closure 提案のみ、他は事実に徹する。
- 方法: 2 並列 general-purpose/Explore subagent(§2 call-site 分類 / §3 UPDATE・DELETE sweep)+ CC 本体裏取り(§1 lifecycle 現物 Read + git/doc 考古学 / §4 tx 現物 Read / §3 の load-bearing 2 件を独立確認)。foreground dispatch、CLAUDE.md 規律。
- 注: **GPT レビュー原文は repo に無い**。「GPT 指摘との差分」は kickoff 記載の範囲(再削除・null 契約・affected rows・closure)との照合であり、原文条項との逐語照合ではない。

---

## 1. user lifecycle handler の防御機構(全列挙)

### 1.1 現状の事実 — フローと dedupe の位置

**webhook route(`app/api/webhooks/clerk/route.ts`)の処理順**:
svix 署名検証 → zod `safeParse`(未対応 type は 200 + warn で吸収)→ **`clerk_events` 記帳(PK=svix-id、`onConflictDoNothing` + `.returning`、duplicate なら 200 'duplicate' 即 return)** → `handleEvent()` → outer catch(`notifyWebhookError`)→ **常に 200**。

- **dedupe 記帳は resolver(users SELECT)の前**(`route.ts:73-80` → `:87`)。
- 帰結: handler が失敗しても event は記帳済み + 200 返却 → Clerk(Svix)再送は duplicate で吸収 = **再送による自動リカバリは構造的に無い**。これは設計意図(再送ループ抑止。復旧 = `integration_failures` 台帳 + 手動、route.ts header comment に明記)。
- RLS 含意(事実のみ): `clerk_events` INSERT は user_id を持たない global 表への write で、tenant 解決(users SELECT)より前に立つ。

**`handleUserDeleted`(`lib/clerk/handle-clerk-event.ts:73-228`)**:
① users SELECT WHERE clerk_id(tx 外)→ ② 0 行なら `notifyOps` + return ③ Stripe sub cancel ループ(tx 外・失敗は台帳記録して forward-only)→ ④ tx: users soft-delete + PII scrub(`deletedAt=now(), email=NULL, clerkId=NULL` を単一 UPDATE)+ Group I 10 表物理 DELETE + assets `status='deleting'` UPDATE。tx は `runTransactionWithRetry`(transient のみ最大 3 retry、最終失敗は `recordFailure(deletion_data)`)。

### 1.2 削除済みユーザーへの user.deleted 再着信(別 event ID)の現状挙動

- 1 回目の削除で users 行は scrub 済み(**clerkId=NULL**)→ 再着信の SELECT WHERE clerk_id は 0 行 → **`notifyOps('user.deleted received but users row not synced')` + return(HTTP 200)**。
- = **エラーなしの no-op**。ただし通知文言は「未同期」で、実際の「削除済みへの再配信」と区別されない(誤分類だが観測可能・機能影響なし)。
- 同一 event ID の再送は `clerk_events` dedupe で 'duplicate' 200(handler 不実行)。

### 1.3 user.created が user.deleted の後に着信した場合の現状挙動

- `INSERT users ... onConflictDoNothing(target: clerk_id)`(`handle-clerk-event.ts:50-54`)。scrub 済み旧行は clerkId=NULL なので conflict せず → **新規 users 行が作成される**(新 UUID、plan='free'、publicMetadata sync)。= 「復活」ではなく新規テナントの誕生。旧行(deletedAt 付・PII scrub 済)は残置。
- 逆順序(user.created 未着のまま user.deleted 先着)= SELECT 0 行 → notifyOps + return(F-5 fix、配送順序異常の観測性確保)。

### 1.4 過去バグ安定化の実装系譜(一次記録との対応)

| 時期 | 実装 | 一次記録 |
|---|---|---|
| 2026-04-22〜26(plan00 Bug 2/Bug 3 cycle) | **R2: webhook-only user sync** — `getCurrentUser()` を auth() + users SELECT のみに簡略化、`clerkClient.users.getUser()` 呼び出しと lazy upsert を撤去。「Clerk session JWT 60 秒 cache × deleteUser 後の 404 throw → app crash」の根治。null = webhook race の契約を導入 | `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md`(spec 本体は plan00 側リポジトリで当 repo に無い)。`ensure-user.ts` docstring の「R2 webhook-only sync, Bug 3 fix」が該当 |
| 2026-05-20 | R2-scrub: PII scrub(email/clerkId NULL) | `sessions/2026-05-20-r2-scrub-and-counter-schema-investigation.md` |
| 2026-05-21(S1.9.5) | 物理 cascade 削除の確立: handleUserDeleted の tx 化 + Group I 明示処理(11 表)+ `runTransactionWithRetry`(transient 3 retry)+ recordFailure(現 integration_failures) | `sessions/2026-05-21-s1-9-5-*.md`(3 docs) |
| 同上 | deletion-status polling: `/api/me/deletion-status`(4 状態、completed = deleted_at set かつ sub status ∉ {active, past_due})+ 30 回 timeout 強制 navigate + `/sign-out-deleted` + layout `BFCacheGuard` | 同上 + `2026-06-14-prod-settings-500-deletion-token-fact-finding.md` §2 |
| 2026-05-26 | **JWT claim 同梱(dbUserId + plan)**: `8125be4`(publicMetadata 埋込・webhook)→ `a426d72`(`getAuthContext()` + 4 page 切替) | `sessions/2026-05-26-jwt-template-setup.md` |

- **「JWT にユーザー情報同梱で解決」の経緯の正確な事実**: jwt-template-setup.md が記録する動機は **perf**(`/app` 全 navigation で発生していた users SELECT の撤去、cold 時 +2s 対策)であり、削除バグ対策ではない。削除系の安定化は R2 webhook-only sync + S1.9.5 cascade/retry + deletion-status polling の三点で実装されている。
- 冪等化の仕組み一覧: ① `clerk_events` PK(event 単位)② handleUserDeleted 内部の値レベル冪等(NULL 上書き・DELETE WHERE 再実行安全 — handler comment 明記)③ transient retry(最大 3)④ 未同期/再削除 = notifyOps + no-op(1.2/1.3)。

### 1.5 ユーザー主体 tombstone 相当の機構

- 専用の user-tombstone table は**無い**。相当物 = **users soft-delete 行そのもの**(deletedAt + email/clerkId NULL scrub。stripe_customer_id は個人特定不能な correlation key として保持)。
- `tombstones` table は entity(exam/card)の client-mirror 同期専用。補助台帳 = `clerk_events`(event 冪等)/ `integration_failures`(失敗記録)。

### 1.6 GPT 指摘との差分(§1 範囲)

- 「削除済みユーザーの再削除エラー」→ **既に対処済み**(エラー経路なし。no-op + ops 通知)。残余 = 通知文言が再削除と未同期を区別しない(観測ノイズのみ)。
- 「user.created 遅着 / 順序逆転」→ **既に対処済み**(観測可能な no-op / 新規行作成という明確な帰結)。
- RLS 含意(事実のみ): handleUserDeleted の tenant 解決は clerk_id → 内部 UUID の 2 段。users に RLS を張る場合、resolve SELECT は clerk_id anchor、tx 内は内部 id 判明済み。

---

## 2. getCurrentUser / getAuthContext の null 契約

### 2.1 現状の事実 — null / throw の条件

`getCurrentUser()`(`lib/auth/ensure-user.ts:38-51`、React `cache()` 済):
- Clerk session 無し → **`UnauthenticatedError` throw**。
- session あり + `users WHERE clerk_id` 0 行 → **null**。null になる実ケース: ① sign-up race(user.created webhook 未着)② **削除済み user の 60s JWT window**(scrub で clerkId=NULL のため 0 行)③ 行の物理不在(手動削除等)。
- **重要(現行スクラブの帰結): deletedAt 付き行が getCurrentUser から返ることは構造的に無い**。scrub UPDATE が deletedAt set と clerkId=NULL を同一文で行うため、clerk_id lookup では引けなくなる。docstring の「deletedAt 行も AS-IS で返す(zombie 検知は caller 責務)」および `/app/layout.tsx:42-44` の deletedAt → `/sign-out-deleted` redirect 分岐は、**現行削除フローでは実質 dead defense**(scrub 導入前の旧行・将来の部分 scrub への防御として残置)。現行の削除後 sign-out 誘導は client 側 deletion-status polling + BFCacheGuard が担う。

`getAuthContext()`(`ensure-user.ts:69-82`): session 無し → throw(同上)。claim(dbUserId/plan)未浸透 → undefined を返し、**呼出側が getCurrentUser() へ fallback**。DB SELECT なし。

### 2.2 null を受けた呼出側の全分類(subagent 全列挙・CC 抜粋)

wrapper `withReadOnlyAuth`(`lib/auth/with-read-only-auth.ts:47-79`): UnauthenticatedError → 401 / **null → 200 + emptyBody(provisioning 扱い)** / その他 error → authFailEvent 有なら warn+500・無なら rethrow。使用 4 route = `/api/dashboard/stats`(空 stats)/ `/api/exams/status`(空 statuses・authFailEvent 無)/ `/api/pull`(空 delta + null cursors)/ `/api/study-days/pull`(空配列)。

| 分類 | call site | null 時挙動 |
|---|---|---|
| provisioning 表示 | `/app/layout.tsx:34-40` | `<SyncingPage/>`(meta-refresh 2s)、children 非 render。deletedAt 行なら `/sign-out-deleted` redirect(2.1 の通り現行は実質不達) |
| 200 + 空 body | withReadOnlyAuth 4 route | 上記 |
| 401 + 専用 code | `/api/review-events/bulk:53-65` / `/api/entity-mutations/bulk:177-188` | `{ error: 'user_not_synced' }` 401(no-session の `unauthenticated` と区別、client は再送待機) |
| ActionResult エラー | settings 3 action / create-exam / delete-exam / asset-actions 3 site / upload `process.ts:124-125`(code:'AUTH') | `{ ok:false, error:'認証が必要です' }` |
| throw(error boundary) | `settings/actions.ts:8-14` / `upgrade/actions.ts:33-39, 83-87, 219-222` | `new Error('USER_NOT_SYNCED')` throw |
| null render | RSC 9 page(`page.tsx` 各所) | `return null`(空 render。layout が先に SyncingPage を出すため通常不達の防御) |
| 匿名継続 | `(marketing)/page.tsx:15-26` / `pricing/page.tsx:14-25` | 未認証扱いで landing/pricing render(deletedAt も未認証扱い) |

- UnauthenticatedError の扱い: bulk 2 route と marketing 2 page と asset-actions(`currentUserOrNull`)は catch して正常応答へ変換、他は propagate(`/app(.*)` は proxy `auth.protect()` が先に立つ)。

### 2.3 「claim あり + users 0 行」の現状経路と帰結

- `getAuthContext()` 利用 4 RSC page(upload / tags / exams / exams/[id])では、**dbUserId claim があると users SELECT を行わず claim を tenant key に直接使う** → users 0 行(削除直後の 60s window)でも fallback は発火しない。帰結 = owner-scoped query が空集合を返し**空 page render**(throw しない)。60s 経過で JWT 失効 → 通常の未認証経路へ収束。
- claim 無し(未浸透)時の fallback 現在形: `getCurrentUser()` を呼び、null なら `return null`(空 render)。upload page のみ dbUserId **or** plan の片方欠落でも両方を DB から取り直す(hybrid source 回避、`upload/page.tsx:39-49`)。

### 2.4 GPT 指摘との差分(§2 範囲)

- 「claim あり + users 0 行」は**現に起こり得る**(60s window)が、帰結は空 render / 空 body で **throw・crash 経路は無い**(= Bug 3 根治の設計どおり)。**設計上許容された degraded window** として実装済み。
- RLS 含意(事実のみ): null 契約は「users SELECT 0 行」を正常系として広く配線済み。RLS 導入で users SELECT が「context 未設定エラー」になる経路を作ると、この null 契約(0 行 = provisioning)とは**別種の失敗**が同じ call site 群に流入する — 呼出側分類(2.2)がその影響面の全リスト。

---

## 3. mutation の affected rows 検査の現状

### 3.1 現状の事実(subagent 全 sweep + CC 独立確認 2 件)

raw `db.execute` の UPDATE/DELETE は **0 件**(session-repository の raw SQL は SELECT のみ)— 全 write は drizzle builder 経由。

**[checked-throw](0 行/件数不一致 = throw、tx rollback)**:
| site | 対象 | 検査 |
|---|---|---|
| `upload-persistence.ts:64` `completeUploadTx` | source_documents UPDATE(id + **user_id**) | `.returning` 0 行 → throw。**CC 独立確認済**(Iso-1 fix 反映済) |
| `session-repository.ts:153` `applyCardFinalStates` | cards UPDATE(VALUES join + user_id) | `.returning` の id 集合 ≠ 入力件数 → **throw**(件数一致検査あり) |

**[checked-branch / checked-warn](0 行 = 分岐 or warn)**:
| site | 対象 | 挙動 |
|---|---|---|
| `upload-persistence.ts:118` `markFailed` | source_documents UPDATE(id + user_id) | 0 行 → warn(PII 無)+ 台帳 skip。best-effort 契約。**CC 独立確認済** |
| `card-field-handlers.ts:101` `updateCardField` | cards UPDATE(id + user_id) | `.returning` 0 行 → `'failed'`(bulk route の failed[] へ伝播) |
| `apply-tag-mutation.ts:99 / :314` category/option update | tag_categories / tag_options UPDATE | `.returning` 0 行 → `'failed'` |
| `asset-actions.ts:174` `finalizeAsset` | assets UPDATE(id + user_id + status) | 0 行 → 再 SELECT で「既 finalize なら ok(冪等)/ 不在なら error」分岐 |
| `source-doc-status.ts:88` `reconcileStaleProcessing` | source_documents UPDATE(user_id + status + 閾値) | RETURNING 0 行 = skip(意図) |
| `subscription-repository.ts:143` `saveProjection` / `:157` `applyDeletedReset` | users UPDATE(whereFor) | `.returning` → `matched`。saveProjection は matched で Clerk sync を gate、applyDeletedReset は `!matched → notifyOps` |
| `session-repository.ts:300` `upsertSessionGuarded` | study_sessions UPSERT(setWhere: user_id + 状態遷移 guard) | `.returning` → applied=false で caller が `logger.warn(session_upsert_blocked)`(処理続行) |

**[unchecked-silent](0 行を静かに成功扱い)— 2 群に分類**:

(i) **上流 guard なし(真に silent)**:
| site | 対象 | 現状の 0 行セマンティクス |
|---|---|---|
| `handle-stripe-event.ts:50`(checkout Step 1) | users UPDATE(clerk_id) | `.returning` なし。0 行は Step 2(subscription fetch → projection)で回収される前提をコメントで明示 |
| `subscription-repository.ts:171` `saveReservation` | users UPDATE(id) | matched を caller(`upgrade/actions.ts:185`)が**破棄** |
| `subscription-repository.ts:186` `clearReservation` / `:207` `clearReservationMatching` | users UPDATE(schedule_id 等) | matched を caller が**意図的に破棄**(0 行 = 通常の no-op とコメント明示) |
| `card-count.ts:33` `bumpExamCardCount` | exams UPDATE(id + user_id) | card_count cache bump。0 行(exam 消失)silent |
| `card-field-handlers.ts:314`(updated_at bump) | cards UPDATE(id + user_id) | 直前の card 存在確認済みの追記 bump |

(ii) **上流 SELECT / 'applied' guard あり(文自体は不検査だが直前に存在検証済)**:
`delete-exam.ts:87`(exams DELETE — SELECT 先行、冪等 silent success は double-click 対策の**仕様**)/ `handle-clerk-event.ts:192, :196-205, :213`(users scrub + 10 表 DELETE + assets — internalUserId は SELECT 済、**値レベル冪等が仕様**)/ `apply-card-mutation.ts:162`・`apply-tag-mutation.ts:156, :349`(delete 系 — 存在 SELECT 先行、outbox 再送吸収の仕様)/ `card-field-handlers.ts:203, :300`(card_asset_refs / card_tags 全置換 DELETE — 親 card 検証済)。

- settings 3 action は user_settings **UPSERT(DoUpdate)**のため 0 行不成立。
- INSERT `onConflict` 一覧(冪等 skip / 加算): DoNothing = users(clerk_id)/ clerk_events / stripe_events / entity_mutations / tombstones(4 箇所)/ answer_events / cards / tag_categories / tag_options。DoUpdate = user_settings ×3 / ai_usage / ai_usage_users / study_days / study_sessions(setWhere guard 付)。
- scripts/ の write は 3 本(gc-image-assets / backfill-card-asset-refs / seed-perf-exam)= owner(ADMIN)経路。

### 3.2 GPT 指摘との差分(§3 範囲)

- 「0 行を静かに成功扱いする箇所が RLS で新しい失敗モードになる」→ **部分対処**が正確な整理:
  - 重要 write は既に checked(OCR complete = throw / FSRS final states = 件数一致 throw / card・tag update = 'failed' 伝播 / subscription projection = matched gate)。
  - unchecked-silent の大半は**意図された冪等吸収**(outbox 再送 / webhook 再配信 / double-click / 予約 clear の通常 no-op)で、無自覚な取りこぼしは少数(checkout Step 1・bumpExamCardCount 等)。
  - ただし silent RLS(context 未設定 → 0 行)を採ると、**RLS 起因の 0 行が上記の冪等吸収と識別不能になり、(i)(ii) 全箇所が漏れの隠蔽点化する**。これは affected-rows 検査を増やして解く問題ではなく、RLS 側を loud(context 未設定 = 例外)にして失敗クラスを分離する設計判断の材料(spec 論点)。

---

## 4. Phase 2 closure の確定材料

### 4.1 候補 tx / 経路の触表(直接 SELECT/INSERT/UPDATE/DELETE と cascade を分離)

**(a) exam 削除 tx**(`delete-exam.ts`):
- 直接: **exams**(SELECT owner 確認 + DELETE)/ **cards**(SELECT id 列挙)/ **tombstones**(INSERT)。tx 外: **users**(getCurrentUser)。
- FK cascade のみ: cards, source_documents(exams FK)→ reviews, answer_events, card_tags, card_asset_refs(cards FK)。study_sessions.exam_id は SET NULL。

**(b) user.deleted tx**(`handle-clerk-event.ts`):
- 直接 12 表: **users**(UPDATE scrub)+ 物理 DELETE 10(**exams, study_days, contact_messages, ai_usage_users, upload_records, user_settings, study_sessions, tombstones, entity_mutations, tag_categories**)+ **assets**(UPDATE 'deleting')。tx 外: users SELECT(clerk_id resolve)。
- FK cascade のみ: cards, source_documents, reviews, answer_events, tag_options, card_tags, card_asset_refs。

**(c) 通常 read 代表**:
- dashboard: RSC `/app` = **users** のみ(dueCount は S-perf-3 で client Dexie 化済)。`/api/dashboard/stats` = **users**(auth)+ **study_days**(raw SQL ×2)。
- pull: `/api/pull` = **users** + **cards / exams / tombstones / tag_categories / tag_options / card_tags**(6 並列)。`/api/study-days/pull` = **users** + **study_days**。
- (参考)review ingest tx(確定事項の set_config 対象): **cards**(SELECT/UPDATE)/ **answer_events** / **reviews** / **study_days**(UPSERT)/ **study_sessions**。

### 4.2 closure 単位の Phase 2 対象表 — 提案(本 doc 唯一の設計提案)

- 前提事実: **user.deleted tx を closure 単位に含めると直接 12 表 + cascade で user_id 19 表のほぼ全部**に達し、Phase 2 ≒ Phase 3 になる。closure 原則を全 tx に同時適用するなら Phase 分割自体が成立しない → Phase 2 は「closure が閉じる機能 tx を選ぶ」ことになる。
- **提案(案 A・推奨)**: Phase 2 = **{users, exams, cards, tombstones, study_days} の 5 表** = 「exam 削除 tx」+「dashboard stats」+「study-days pull」の closure 和。
  - exam 削除 tx は直接触表がすべて RLS on(cascade は RLS 非関与 = PG の FK 内部処理)→ **「1 つの機能 tx が触る全表を同 Phase で有効化」を満たす最初の実証**になる。
  - kickoff の「users / exams / cards + review 系 1」に対し、review 系 = study_days(raw SQL 経路 + UPSERT + delta pull + user.deleted 直接 DELETE を踏む)+ **tombstones を追加**(exam 削除 closure の要請 + pull の 1 stream)。
  - 残余(明記): `/api/pull` は 6 stream 中 tag 3 表が Phase 2 未 RLS(partial)。review ingest tx も reviews/answer_events/study_sessions が未 RLS(context 設定だけは確定事項どおり全 tx に入る)。
- **代替(案 B)**: 5 表 + tag 3 表(tag_categories/tag_options/card_tags)= **8 表**で `/api/pull` 全 stream を closure 化。実証範囲最大だが、tag 系 write 経路(apply-tag-mutation 群)の適用サイトが増える。
- いずれも user.deleted tx / review ingest tx の完全 closure は Phase 3 第一波へ(partial であることを spec に明記して検証設計に反映)。**採否は OT 判断**。

---

## 付録: 調査メタ

- subagent: 2 並列(§2 null 契約 call-site 全列挙 / §3 UPDATE・DELETE + onConflict sweep)。CC 本体裏取り: handle-clerk-event.ts / clerk webhook route / delete-exam.ts / upload-persistence.ts / dashboard stats route / session-repository 触表 / ensure-user.ts / layout・scrub 到達性 / git log(8125be4, a426d72)/ lessons・sessions doc 5 本。
- 未確定: GPT レビュー原文(repo 外)との逐語照合 / §3 表の subagent 網羅行の全数再検証(load-bearing 2 件のみ CC 独立確認)。
