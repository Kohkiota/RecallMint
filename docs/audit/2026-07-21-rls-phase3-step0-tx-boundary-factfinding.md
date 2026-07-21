# RLS Phase 3 Step 0 — tx 境界 DDD 整理 要否 + wave 分割 fact-finding

- **日付**: 2026-07-21
- **HEAD**: `9386501` (develop)
- **位置づけ**: Phase 3(残り全 tenant 表への RLS 展開)の spec を書く前の現実確認。過去 session doc / 見積りは**根拠にしない** — 現 HEAD の実コードのみを根拠にし、食い違いは session doc 側を疑う(§6)。
- **制約遵守**: read-only 調査。コード変更・migration・policy・test は一切していない。本 doc の作成のみ。sprint 完了 gate(test:iso 等)は非対象。
- **調査手法**: 一次読解(schema / tenant-tx / review-ingest / 2 bulk route / pull route / lifecycle handler / policy SQL)+ read-only subagent 2 体で全 call-site / closure を網羅列挙。全主張に `file:line` 根拠を付す。

---

## 0. 結論(binary)

| 問い | 判定 | 根拠節 |
|---|---|---|
| **DDD tx 境界整理を Phase 3 の前に独立 sprint 化すべきか** | **否**。Phase 3 に内包する(= 各 wave で write path を配線 + 最終 hardening wave で getDb 封じ込め)。前倒し全面 refactor は YAGNI。 | §1, §5.1 |
| **review-ingest 系は単純 predicate で閉じるか / dense-invariant を跨ぐか** | **単純 predicate で閉じる**。→ Wave 1 は **Fable 級**(機械反復)。Opus 級の設計判断は不要。 | §3, §5.2 |
| **wave 分割案** | Wave 1(7 表・配線ゼロ)/ Wave 2(5 表・軽配線)/ 特殊 3 表 / 最終 hardening wave。closure を割らない。 | §5.3 |

---

## 1. tx 境界の現状マップ

### 1.1 呼び出し地点の全数(非 test)

| helper | 定義 | call site 数 |
|---|---|---|
| `getDb()` | `lib/db/index.ts:19` | **40**(30 file) |
| `getAdminDb()` | `lib/db/index.ts:31` | **1**(`lib/integration-failures.ts:120`、`DATABASE_URL_APP` 未設定時のみ) |
| `withTenantTx()` | `lib/db/tenant-tx.ts:24` | **19** |
| `setTenantContext()`(直接) | `lib/db/tenant-tx.ts:18` | **8**(手動 tx 経路) |

**構造的事実**: `getDb()` は `lib/db/` 内部から一度も呼ばれない(定義が唯一の出現)。したがって **40 site 全てが `lib/db/` 外**で、これがそのまま「封じ込め対象の面積」(§1.4)。

### 1.2 layer 別分類(getDb / getAdminDb)

| layer | 数 | 代表 site |
|---|---|---|
| route handler(`app/api/**/route.ts`) | 8 | pull:72 / study-days/pull:27 / dashboard/stats:31 / entity-mutations/bulk:232 / review-events/bulk:83 / exams/status:49 / webhooks/stripe:33 / webhooks/clerk:69 |
| server action(`'use server'` / `_actions/`) | 14 | process:212 / delete-exam:43 / create-exam:53 / asset-actions:101/137/242 / save-*-limit:18 / save-fsrs-mode:21 / upgrade/actions:146/187/259 / contact:61 |
| server component / RSC page(`page.tsx`) | 7 | upload/page:94,97 / exams/[id]/page:32 / settings/page:31 / study/{smart:23,custom:20} / upload/result:31 |
| use-case / orchestrator(`lib/<feature>`) | 9 | handle-stripe-event:74/313/363 / handle-clerk-event:39/84 / source-doc-status:44/83/167 / ai-usage-counter:26 |
| **repository / infra(`lib/db/*`)** | **0** | — 全 helper が `db`/`TenantDb`/`TenantTx` を引数受領(= 既に「封じ込め済みの目標形」) |
| lib helper / other | 2 | integration-failures:120 / auth/ensure-user:46 |

**要点**: repository/infra 層は既に**引数受領形**(型 only import 12 file: `lib/db/*-pull.ts` / `pull-delta.ts` / `streak.ts` / `lib/exams/list.ts` / `lib/cards/get-session-cards.ts` / `lib/ai-usage-mcq.ts` / `session-repository.ts`)。DDD 整理の目標形の過半は**既に完了**している。

### 1.3 tx-wrapped vs raw(P2 で配線した経路 vs 素の getDb)

判定: **A** = `withTenantTx` or `db.transaction`+`setTenantContext` / **B** = 手動 tx で context 無し / **C** = tx 外の raw query / **Mixed** = 同一 handle で A と C 両方。

| bucket | 数 | 意味 |
|---|---|---|
| **A(context 済)** | **19** | P2 closure + 既存の全 tx 経路。RLS 対応済。 |
| **B(手動 tx・context 無し)** | **0** | getDb から到達する Postgres `db.transaction` は**全て**冒頭で `setTenantContext` を張る。抜けは無い。 |
| **C(raw・tx 外)** | **16** | 素の getDb 直呼び。 |
| **Mixed(A+C)** | **5** | pre-tenant resolve + tenant tx が同一 handle に同居。 |

**raw 一撃を含む site = 21**(C16 + Mixed5)。これが RLS 化前に配線が要る面積。

**C(raw)16 site の対象表**(現状いずれも RLS 無効表):
- `user_settings`: settings/page:31, save-session-limit:18, save-custom-session-limit:18, save-fsrs-mode:21, study/custom:20
- `assets`: asset-actions:101(insert), :137(select→update→select の 3 連), :242(select)
- `source_documents`: source-doc-status:44, :167, exams/status route:49
- `upload_records`: upload/page:97(`getCurrentMonthOcrPages` → `ai-usage-mcq.ts:53`)
- `integration_failures`: integration-failures:120
- `contact_messages`: contact:61
- `stripe_events`: webhooks/stripe:33 / `clerk_events`: webhooks/clerk:69(idempotency)

**Mixed(A+C)5 site**: handle-stripe-event:74(resolve+tx) / auth/ensure-user:46(bootstrap+tx) / handle-clerk-event:84(bootstrap+retry tx) / study/smart:23(raw user_settings read + tx cards) / **review-events/bulk:83(Phase 0 raw study_sessions upsert + Phase 1 tenant tx)**。

### 1.4 raw getDb 封じ込めの面積(export 制限 + lint の blast radius)

`getDb` を `lib/db/` 外から呼べなくすると **40 site 全て**が壊れる(全て lib/db 外)。ただし難易度は二分される:

- **機械的に変換可(19 の A + 素直な C 約 10)**: 既に `withTenantTx` を通す A、および `user.id` が scope に在るだけの C(settings / assets / study page / exams/status / source-doc-status / upload month-quota)。`withTenantTx` に包む or `TenantTx` を渡すだけ。※`asset-actions:137` は select→update→select の 3 連で 1 tx に束ねる要あり。
- **構造的に変換不能(約 7)= 封じ込めの escape hatch が要る**:
  - `webhooks/stripe:33` / `webhooks/clerk:69` — `stripe_events`/`clerk_events` は **user_id を持たない event 単位 dedup 表**。tenant が無い → `withTenantTx` 不可、**非 tenant の owner/admin handle** が要る。
  - `handle-stripe-event:74` / `handle-clerk-event:84` / `auth/ensure-user:46` — tenant 確定**前**の resolve/bootstrap(SECURITY DEFINER lookup)。構造的に pre-tenant + multi-query。
  - `integration-failures:120` — app と operator(owner) 双方で走る監査台帳、`userId` null 有り。env 依存 handle 選択が要る。
  - `contact:61` — 匿名投稿可(`user_id` nullable)。

**含意**: 「getDb を lib/db に閉じ、tenant 経路は `withTenantTx` に一本化」は**達成可能だが all-or-nothing ではない**。上記 7 site 用に「**明示的な非 tenant handle**」(例: `getGlobalDb()` / 既存 `getAdminDb` の役割拡張)を先に用意しない限り封じきれない。→ 封じ込めは Phase 3 の**最終 hardening wave**(全表 RLS 化後・非 tenant handle 整備後)が適所(§5.1)。

---

## 2. tenant 表の完全 catalog

`lib/db/schema.ts` header は **23 表**(`schema.ts:1`)。全数分類:

### 2.1 分類表

| # | 表 | user_id | FK | 分類 | RLS 状態 |
|---|---|---|---|---|---|
| 1 | users | (id) | — | tenant(self) | **P2 済** |
| 2 | exams | ✓ | cascade | tenant | **P2 済** |
| 3 | cards | ✓ | cascade | tenant | **P2 済** |
| 4 | tombstones | ✓ | cascade | tenant | **P2 済** |
| 5 | study_days | ✓ | cascade | tenant | **P2 済** |
| 6 | reviews | ✓ | cascade | tenant(標準) | 未 |
| 7 | answer_events | ✓ | cascade | tenant(標準) | 未 |
| 8 | source_documents | ✓ | cascade | tenant(標準) | 未 |
| 9 | upload_records | ✓ | cascade | tenant(標準) | 未 |
| 10 | user_settings | ✓ (PK) | cascade | tenant(標準) | 未 |
| 11 | study_sessions | ✓ | cascade | tenant(標準) | 未 |
| 12 | entity_mutations | ✓ | cascade | tenant(標準) | 未 |
| 13 | tag_categories | ✓ | cascade | tenant(標準) | 未 |
| 14 | tag_options | ✓ | cascade | tenant(標準) | 未 |
| 15 | card_tags | ✓ | cascade | tenant(標準) | 未 |
| 16 | assets | ✓ | cascade | tenant(標準) | 未 |
| 17 | card_asset_refs | ✓ | cascade | tenant(標準) | 未 |
| 18 | **ai_usage_users** | ✓ (PK: user_id+date) | cascade | **特殊**(server counter) | 未 |
| 19 | **integration_failures** | ✓ nullable | **FK 無し** | **特殊(b)**(audit・削除後保持) | 未 |
| 20 | **contact_messages** | ✓ nullable | cascade | **特殊**(匿名投稿可) | 未 |
| 21 | ai_usage | ✗ (PK: date) | — | **global** | 対象外 |
| 22 | stripe_events | ✗ (PK: event_id) | — | **global** | 対象外 |
| 23 | clerk_events | ✗ (PK: event_id) | — | **global** | 対象外 |

根拠: user_id 列/FK/nullable は `schema.ts` 各 `pgTable` 定義(reviews:151, answer_events:611-625, integration_failures:226-232 `FK なし`+nullable, contact_messages:529 nullable, ai_usage:172-175 `date` PK 単独, study_days:485)。global 3 表は schema コメント「ルール B: stripe_events / ai_usage / clerk_events を除く全 table に user_id」(`schema.ts:20-23`)と一致。

### 2.2 数の裏取り(v47「14 表」/「19 表」の実数)

- **user_id 列を持つ表 = 19**(#2-#20。`users` は列名 `id` なので除外)→ v47「user_id 保持 19」は**正**。
- P2 RLS 済のうち 19 に含まれるのは exams/cards/tombstones/study_days の **4**(users は 19 の外)。
- **残り un-RLS な user_id 表 = 19 − 4 = 15**。
- **v47 の「14 表」は誤り**(§6-①): 「19 − closure 5」で計算しているが、closure 5 は `users` を含み、その `users` は 19 に含まれない。集合の混同。**正しい残数は 15**。
- うち **標準形 12**(#6-#17)/ **特殊 3**(#18-#20)。global 3(#21-#23)は RLS 対象外(user_id 無し・role grant で処理)。

### 2.3 削除後保持系(b)と匿名系の扱い(「user_id 列あるから一括 policy」にしない)

- **integration_failures**(#19): audit 台帳。**FK 無し**(`schema.ts:22-23,219` 「audit 行は user 削除後も残置」)、`user_id` nullable(webhook 文脈に userId 無し)、書込は `getDb()` **または `getAdminDb()`**(operator context・`integration-failures.ts:120`)。→ `user_id = current` policy は nullable 行と admin 書込行を**全 block** する。**推奨: tenant RLS を張らない**。app-role の SELECT を role grant で絞る(あるいは非 tenant 台帳として owner-only 化)方が整合。
- **contact_messages**(#20): 匿名投稿(`user_id` null・`contact.ts:70-82`)。`user_id = current` の WITH CHECK は匿名 INSERT を落とす。→ **特殊 policy**(`user_id IS NULL OR user_id = current`)か、非 tenant 化(サポート inbox は app が tenant として読まない)を要決定。
- **ai_usage_users**(#18): server counter(`incrementAiUsage` が ai_usage と同 tx で UPSERT・`ai-usage-counter.ts:41`、C8 で context 済)。RLS 化自体は標準 policy で可能だが、read 経路(利用上限チェック)が context 下かの確認が要る。

---

## 3. review-ingest の ordering 判別(Wave 1 モデル決定に直結)

### 3.1 write path の実体(`/api/review-events/bulk`)

2 段構成(`app/api/review-events/bulk/route.ts`):
- **Phase 0**(tx 外・context 無し): `upsertSessionGuarded(db, user, session)`(route:91)→ **study_sessions** の `INSERT ... ON CONFLICT DO UPDATE`(`session-repository.ts:287`)。**素の `getDb()`・`db.transaction` 無し・`setTenantContext` 無し**。tenant 分離は setWhere 内 `eq(userId)` の app 層のみ(`session-repository.ts:310`)。
- **Phase 1+2**(単一 tx): `processSession`(`ingest-review-events.ts:99`)が `db.transaction` + `setTenantContext`(:101)で **answer_events**(:146)→ **reviews**(:180)→ **cards** UPDATE(:195)→ **study_days** UPSERT(:202)を書く。read = cards(:108)+ reviews distinct(`session-repository.ts:221`)。

### 3.2 不変条件の所在(RLS が干渉するか)

順序付きイベント列の不変条件(冪等 id / 決定的順序 / 二重適用防止)を分解すると、**RLS(set_config + policy + definer)とは直交**:

1. **冪等(二重適用防止)** = `answer_events.event_id` の **global UNIQUE**(`schema.ts:611` `.notNull().unique()`)+ `INSERT ON CONFLICT DO NOTHING RETURNING`(`session-repository.ts:94-100`)。実 insert された event のみ replay 対象。**UNIQUE index は RLS で filter されない**(参照整合・一意制約は RLS を bypass)ので、policy 追加は ON CONFLICT の判定に影響しない。
2. **決定的順序** = `planReplay`(payload 順 per-card group)+ `replaySession`(in-memory FSRS fold)。**純粋 domain**(`session-aggregate.ts` — drizzle / @/lib/db / logger を import しない・`:1-12`)。DB 依存ゼロ。
3. **owner-scope** = 既存 query が全て `WHERE user_id = ?`(`loadCardReplayStates`:64-70 / `applyCardFinalStates`:176 / `upsertStudyDays`:225)。RLS policy `user_id = app_current_user_id()` は**これと同じ述語を DB 側に二重化するだけ**。挙動不変。

replay に入る DB 由来入力は `insertedEventIds`(ON CONFLICT RETURNING)と `cardRows`(SELECT)の 2 つのみ。両者とも RLS は「owner 行に可視性を絞る」= 既存の app 層 WHERE と同結果。→ **dense-invariant を跨がない**。

### 3.3 唯一の nuance(記録のみ・blocker でない)

`answer_events.event_id` / `entity_mutations.mutation_id` は **global UNIQUE**(user_id 複合でない)。ON CONFLICT は UNIQUE index 全域(= RLS 越し)で衝突判定する。理論上、別 user が同 event_id を送ると DO NOTHING で「重複」扱いされ replay されない cross-tenant idempotency leak が起こりうる。だが (a) event_id/mutation_id は client 採番 uuidv4 で衝突は無視可能、(b) **この挙動は RLS 導入で変わらない**(UNIQUE index は元から全 tenant 横断)。→ Phase 3 で新規に生む失敗モードではない。spec に 1 行注記で足りる。

### 3.4 判定(binary)

**単純 predicate で閉じる。Wave 1 = Fable 級。** reviews / answer_events は policy SQL(共通形)追加のみで RLS 下に入る。Opus 級の設計判断(closure / context / definer)は **P2 で既に消化済**。study_sessions のみ Phase 0 の tx 化(§5.3 Wave 2)が要るが、これも「1 経路を `withTenantTx` に包む」機械作業で、再設計ではない。

---

## 4. pull 6 stream + review-events/bulk のマッピング

### 4.1 `/api/pull` の 6 stream(`app/api/pull/route.ts:71-83`・既に単一 `withTenantTx`)

| stream | 読む表 | helper(`file:line`) | RLS 状態 |
|---|---|---|---|
| cards | **cards** | `cards-pull.ts:28` | P2 済 |
| exams | **exams** | `exams-pull.ts:33` | P2 済 |
| tombstones | **tombstones** | `tombstones-pull.ts:33` | P2 済 |
| tag_categories | tag_categories | `tag-categories-pull.ts:39` | **未** |
| tag_options | tag_options | `tag-options-pull.ts:38` | **未** |
| card_tags | card_tags | `card-tags-pull.ts:40` | **未** |

6 helper は共通 factory `getDeltaRows`(`pull-delta.ts:35`・`dbc: TenantDb` 受領)経由。tx 内 6 直列 await(単一接続ゆえ `Promise.all` 不可・route:69 コメント)。→ **tag 3 表を RLS 化すれば pull 6 stream 全てが RLS 下**(cards/exams/tombstones は既済)。

### 4.2 その他 pull/push route

- `/api/study-days/pull`: **study_days** のみ(`study-days-pull.ts:59`)、`withTenantTx`(route:27)。RLS 済。
- `/api/entity-mutations/bulk`: per-mutation tx(route:103 + `setTenantContext`:106)。op 別 write = cards/exams/tombstones/tag_categories/tag_options/card_tags/card_asset_refs/entity_mutations(§4.3)。
- `/api/review-events/bulk`: §3.1。

### 4.3 「tag 3 表 + review-ingest を closure 化すれば pull 全 6 stream + bulk が RLS 下」の裏取り

**概ね正・ただし bulk 側は表がもう少し広い**:
- pull 6 stream → tag 3 表の RLS 化で閉じる(§4.1)。**正**。
- entity-mutations/bulk の apply registry は tag 3 表以外に **card_asset_refs**(images field・`card-field-handlers.ts:204/228`)と **entity_mutations**(log・route:155)も同 tx で書く。→ bulk を「RLS 下」に完全に入れるには **card_asset_refs + entity_mutations も同 wave**が要る(いずれも context 済 = Wave 1 で吸収)。
- review-events/bulk → answer_events + reviews の RLS 化で Phase 1+2 が閉じる。**study_sessions(Phase 0)は別途 tx 化が要る**(§3.1)。

→ 記述の「tag 3 表 + review 系」は**必要表を 2 つ取りこぼす**(card_asset_refs / entity_mutations)。Wave 1 の実際の閉包は **7 表**(§5.3)。

---

## 5. CC の判定

### 5.1 DDD 整理を独立 sprint 化すべきか → **否(Phase 3 に内包)**

**根拠**:
1. tx-context 配線は**既に大半完了**: bucket A=19 / **B=0**(手動 tx の context 抜けゼロ)/ repository 層は全 helper 引数受領(§1.2-1.3)。残り raw = 21 site。
2. 残り 21 のうち約 10 は「`user.id` が scope に在るだけの素直な wrap」で、**対象表が wave に入る時に一緒に配線**すればよい(配線と RLS flip は不可分・per-table)。約 7 は**構造的 pre-tenant/global**(§1.4)で `withTenantTx` 化できず、非 tenant handle の整備が要る。
3. 「use-case 入口 withTenantTx / repository は TenantTx のみ / raw getDb 封じ込め」の完全形を**前倒し**すると、まだ RLS を張っていない経路まで先行 refactor することになり **YAGNI**(簡潔性規律)。かつ非 tenant handle(escape hatch)未整備のまま封じると 7 site が詰む。

**推奨する内包形**:
- **各 wave**: 対象表の raw write/read path をその wave 内で `withTenantTx` 配線 → policy flip。
- **Wave 0(安価・先行可)**: P2 が始めた「RLS 対象 helper の `dbc` 必須引数」を lint/型で強制し、rollout 中の regression(default/raw handle 混入)を防ぐ。全面 refactor ではない小 gate。
- **最終 hardening wave**: 全 tenant 表 RLS 化 + 非 tenant handle(`getGlobalDb` 等)carve out **後**に、getDb export 制限 + `no-restricted-imports` lint を一括投入。この時点で raw surface は各 wave の配線で最小化済。加えて policy の migration 昇格 + schema↔SQL drift-detection test(Task 0 pgPolicy 評価の申し送り)。

### 5.2 review-ingest = 単純 predicate → **Wave 1 は Fable 級**(§3.4)

### 5.3 wave 分割案(closure を割らない)

分割原則の**再定義**: 従来 spec の「closure(1 write tx が触る表)を割らない」は、より正確には「**RLS を張る表 T の全 write/read path が、T の flip 前に既に `setTenantContext` を張っている**」。RLS は表単位で独立評価され、RLS 無効表は GUC を無視する(P2 spec §で実証済)ため、context さえ張られていれば **1 tx 内に RLS on/off が混在しても安全**。よって「同 closure の表を同時 flip」は不要 — 必要なのは**表ごとの context-readiness**。この再定義が lifecycle 巨大 tx(§6-②)の mega-wave 懸念を解消する。

closure 台帳(C1-C19)から各表の readiness を判定:

**Wave 1 — 配線ゼロ(全 write/read path が既に context 済)= 7 表・純 policy SQL・Fable**
`reviews` / `answer_events`(C10 review-ingest tx ✅)/ `tag_categories` / `tag_options` / `card_tags`(C4 upload persist ✅ / C9 mutation ✅ / pull は withTenantTx ✅)/ `entity_mutations`(C9 ✅)/ `card_asset_refs`(C9 images ✅)。
→ 効果: pull 6 stream 完全 RLS 化 + review-ingest Phase 1+2 + entity-mutations/bulk 完全 RLS 化。**共通形 policy 反復のみ**。

**Wave 2 — 軽配線(standalone raw を数点 wrap してから flip)= 5 表・Fable〜Sonnet**
| 表 | 要配線(raw site) |
|---|---|
| study_sessions | Phase 0 `upsertSessionGuarded` を `withTenantTx` 化 or processSession tx に合流(review-events/bulk:91) |
| user_settings | save-*×3(:18/:18/:21)+ read 3(settings/page:31, study/custom:20, study/smart:23) |
| assets | asset-actions:101/137(3 連)/242 |
| source_documents | read: source-doc-status:44/167, exams/status:49 |
| upload_records | read: `getCurrentMonthOcrPages`(upload/page:97) |

いずれも C12 lifecycle delete 側は context 済(`handle-clerk-event.ts:209`)。write の主経路(C3/C5/C6/C7/C8)も context 済。残る素の read/write を包むだけ。

**特殊 3 表 — 設計判断が要る(標準 policy 反復にしない)**
- `ai_usage_users`: 標準 policy 可だが read(利用上限)context 化確認。Wave 2 併合も可。
- `integration_failures`: **tenant RLS を張らない**推奨(audit・nullable・FK 無し・operator 書込)。role grant で app-role SELECT を絞る。
- `contact_messages`: 特殊 policy(`user_id IS NULL OR user_id = current`)or 非 tenant 化。

**global 3 表**(ai_usage/stripe_events/clerk_events): RLS 対象外。role grant で処理。現状 `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES`(`recallmint_app-grants.sql:4`)= 全開放なので、Phase 3 完了時に app-role の到達範囲を見直す(FORCE RLS 不採用の穴埋めは role grant 側の責務)。

**closure を割っていない確認**: C4(cards+exams+tag3)/ C9(cards+exams+tombstones+tag/refs/entity_mutations)/ C10(answer_events+reviews+cards+study_days)/ C12(ほぼ全表)の各 tx は、構成表が Wave 1 or 既 RLS 済 or Wave 2 に**分散するが、全 tx が context 済**なので分散は無害(上記再定義)。Wave 1 の 7 表は互いに同 closure(C9/C10)で自然に閉じる。

---

## 6. session doc と実装が食い違った点

- **① v47 / handoff「残り 14 表」→ 実数 15**(§2.2)。`docs/todo-v47-integrated-status.md:79` / `sessions/2026-07-21-handoff-next-session.md:14`。「19 − closure 5」の集合混同(19 は users を除外・closure 5 は users を含む)。正 = 19 − 4 = 15。
- **② audit doc 2026-07-20「closure 原則を全 tx に適用すると Phase 分割不成立 / user.deleted tx = 12 表 + cascade 19 表」**(`docs/audit/2026-07-20-...factfinding.md:170`)。lifecycle tx が 12 表 explicit + cascade で広いのは**事実**(`handle-clerk-event.ts:214-230`)。だが「これが mega-wave を強制する」framing は**誤り**: 当該 tx は既に `setTenantContext` 済(:209)で、RLS は表単位独立評価 → partial-RLS 状態が安全。真の制約は closure 同時 flip でなく**表ごと context-readiness**(§5.3)。**Phase 分割は成立する**。
- **③ spec/handoff「review-ingest の完全 closure(reviews/answer_events/study_sessions)= Phase 3 で再設計対象」**(`sessions/2026-07-20-...implementation.md:51`)。**過大**: reviews/answer_events は**再設計不要**(Wave 1・配線済)。study_sessions のみ Phase 0 を 1 箇所 tx 化するだけで「再設計」ではない。
- **④ spec「raw getDb 封じは Phase 3 で lint/export 制限」**(`specs/2026-07-20-...design.md:110`)。**可能だが all-or-nothing 不可**: 7 site(webhook dedup no-user_id / cross-tenant resolve / 匿名 contact / audit 台帳)は構造的 pre-tenant/global で `withTenantTx` 化できず、非 tenant handle の carve out が前提(§1.4)。封じ込め spec にこの escape hatch を明記要。
- **⑤ handoff「残り 14 表への RLS 展開(共通形 policy + set_config 配線)」**(`sessions/2026-07-21-...:14`)。「共通形反復」は Wave 1+2 の 12 表には正だが、特殊 3 表(integration_failures/contact_messages/ai_usage_users)は**共通形でない**(§2.3)。「全表 共通形」は overstate。
- **⑥「tag 3 表 + review 系 closure 化で pull 6 + bulk が RLS 下」**(`specs/2026-07-20-...design.md:13`)。pull 6 は正だが bulk は **card_asset_refs + entity_mutations を取りこぼし**(§4.3)。Wave 1 実閉包は 7 表。
- **一致(食い違い無し)**: closure 5 = {users, exams, cards, tombstones, study_days} は `db/policies/rls-p2-enable.sql:19-54` / `rls-p2-disable.sql` と一致。RLS が drizzle migration でなく `db/policies/*.sql` に在るのも一致(`0025_rls_p2_functions.sql` は function のみ)。P2 の 3 経路(pull / review-ingest Phase1+2 / entity-mutations)が既に context 済も一致。

---

## 付録: 参照した一次コード

- schema: `lib/db/schema.ts`(23 表)
- tx helper: `lib/db/tenant-tx.ts`
- review-ingest: `lib/reviews/ingest-review-events.ts` / `session-repository.ts` / `domain/session-aggregate.ts` / `app/api/review-events/bulk/route.ts`
- entity-mutations: `app/api/entity-mutations/bulk/route.ts` / `lib/sync/server/entity-mutation-registry.ts`(agent 経由)
- pull: `app/api/pull/route.ts` / `lib/db/*-pull.ts` / `pull-delta.ts`
- lifecycle: `lib/clerk/handle-clerk-event.ts`
- RLS 正本: `db/policies/rls-p2-enable.sql` / `rls-p2-disable.sql` / `db/roles/recallmint_app-grants.sql` / `drizzle/migrations/0025_rls_p2_functions.sql`

---

## 追補: 特殊 3 表 read-path + contact GDPR 削除(2026-07-21 追加調査)

**目的**: §2.3 の特殊 3 表の RLS 方針を read-path の実在有無で確定 + contact_messages が GDPR user 削除で実際に消えるか(FK 無しゆえ cascade でなく明示 DELETE の有無が全て)を実コードで確認。

**全体所見**: 3 表とも **app 側 SELECT 地点 = 0 件**(全て write-only)。grep(`app/` + `lib/`・非 test・schema.ts 除く)で `.select()/.from()` 地点は 3 表いずれもゼロ。参照は INSERT / DELETE / コメント / validation のみ。

### 1. contact_messages

- **(a) read**: SELECT 地点 **0 件**。app に会員が自分の問い合わせ履歴を閲覧する UI/経路は**存在しない**。参照 = INSERT(`lib/actions/contact.ts:84`)/ lifecycle DELETE(`lib/clerk/handle-clerk-event.ts:217`)/ validation(`lib/validation/contact.ts`)のみ。→ **tenant read なし**。
- **(b) GDPR 削除**: 明示 DELETE **あり**。`handle-clerk-event.ts:217` = `tx.delete(contactMessages).where(eq(contactMessages.userId, internalUserId))`、C12 lifecycle tx 内(`setTenantContext` 済・:209)。users は soft-delete で FK cascade 不発ゆえ Group I の明示 DELETE で消す設計と一致。→ **会員行は user 削除で消える**(PII 齟齬なし)。匿名行(`user_id` null)は WHERE に当たらず**残置**(帰属 account 無し = 設計通り。ただし匿名行の `email` 列は残る)。
- **(c) 書込 user_id / PII 所在**: 会員 = 内部 UUID(`app_bootstrap_user_from_clerk` SECURITY DEFINER 解決・`contact.ts:74-77`、**raw db・context 無し**の execute)/ 非会員・未同期・Clerk 障害 = **null**(`contact.ts:70,81`)。email は **専用列**(`contact.ts:86` / `schema.ts:530` `email` NOT NULL)= PII 主所在(body/subject 自由文にも混入しうる)。
- **binary → tenant read なし = tenant RLS 張らない**。理由: (1) 保護すべき app SELECT が無い、(2) 匿名 INSERT(user_id null)+ 会員 INSERT が **context 無し raw db** 上で DEFINER 解決するため、`user_id = current` の WITH CHECK は両経路を壊す(現設計は context を張らない)。
  - **grant 訂正**: 「INSERT-only」は不正確 — lifecycle DELETE(:217)が app-role(`recallmint_app`)で走るため app-role には **INSERT + DELETE** が要る。SELECT / UPDATE は不要 → 縮小可。ops read は owner 限定。

### 2. integration_failures

- **read**: SELECT 地点 **0 件**。reconcile 系 UPDATE も**無し**(`retry_count`/`resolved_at` 等は dormant・`schema.ts:222`)。参照 = INSERT(`lib/integration-failures.ts:122`)+ コメントのみ。
- **write role 分岐**: `const db = process.env.DATABASE_URL_APP ? getDb() : getAdminDb()`(`integration-failures.ts:120`)。runtime = app-role INSERT / operator script = owner INSERT。両 role INSERT 可(コメント :117)。tx 無し(単発 INSERT)。
- **binary → app read なし = tenant RLS 張らない**。app-role は INSERT のみ(grant 既存)。将来の手動回収(reconcile UPDATE)も operator(owner・RLS bypass)想定。加えて `user_id` nullable + **FK 無し** + **user 削除後も残置**(lifecycle DELETE 対象外 = audit 保持・`schema.ts:219`)ゆえ tenant policy は原理的に不適(nullable 行 + 削除済 user 行を全 block する)。
- **PII 申し送り(スコープ外・記録のみ)**: integration_failures は user 削除で scrub されない(`clerkId`/`stripeCustomerId`/`context` jsonb/`errorMessage` 保持)。audit correlation の既定判断だが、contact 匿名残置行と併せ将来 PII 監査の検討対象。

### 3. ai_usage_users

- **read**: SELECT 地点 **0 件**。日次上限判定は **global `ai_usage`** を読む — `getTodayAiUsageGlobal`(`ai-usage-counter.ts:53-64`)が select するのは `aiUsage`(global)であって `aiUsageUsers` **ではない**。`ai_usage_users` は write-only 台帳(ops/分析用途、app enforcement は global 側)。
- **write / delete context**: `incrementAiUsage`(`ai-usage-counter.ts:29-46`)= `db.transaction` + `setTenantContext(tx, userId)`(:30)= **context 済**(C8。ai_usage(global)と同一 tx UPSERT)。lifecycle DELETE(`handle-clerk-event.ts:218`)も context 済(C12)。
- **binary → read 無し / write・delete とも context 済 = 配線ゼロで RLS 化可**。標準 `user_id = current` policy が無改修で通る。「Wave 2 で 1 経路 wrap」は**不要** — 実質 **Wave 1 相当**(zero-wiring)。「特殊」なのは由来(server counter)だけで RLS 機構は標準形。

### 方針更新(§2.3 / §5.3「特殊 3 表」の確定)

| 表 | 確定方針 | app-role grant |
|---|---|---|
| contact_messages | **RLS 非対象**(write-only inbox・匿名 + DEFINER 経路) | INSERT + DELETE(SELECT/UPDATE revoke) |
| integration_failures | **RLS 非対象**(audit・app read 無し・retained・nullable/FK 無し) | INSERT のみ |
| ai_usage_users | **標準 RLS 可・配線ゼロ**(Wave 1 相当へ格上げ) | 標準(共通形 policy) |

→ 当初「特殊 3 表 = 設計判断要」のうち、実質判断が残るのは **RLS を張らない 2 表(contact / integration)の grant 縮小可否**のみ。ai_usage_users は標準へ移す。global 3 表(ai_usage/stripe_events/clerk_events)と合わせ、**RLS 非対象 = 5 表**(global 3 + contact + integration)、**RLS 対象の残り = 13 表**(標準 12 + ai_usage_users)に整理される(§2.2 の「残り 15」= RLS 対象 13 + 非対象 2)。
</content>
</invoke>
