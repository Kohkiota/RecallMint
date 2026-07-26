# H-0 ② 設計不変条件の全棚卸し(fact-finding・読み取り専用)

- **作成日**: 2026-07-26
- **位置づけ**: H トラック H-0 の 2 本目。最終目的 = `docs/architecture.md`(設計不変条件の索引)の材料。**本 doc は素材。architecture.md は作らない。**
- **① との関係**: ① = ハーネス機構(lint/gate/権限/review)。② = **設計不変条件**(コード/データが守るべき約束)。① と重複する機構は再掲しない。
- **scope**: 現状の記述に徹する。改善提案・リファクタ提案は書かない(H-1 以降)。
- **調査手法**: 既知の正本候補を先に読み、現物と食い違うものだけ矛盾として報告。claude.ai の記憶ベース前提(ISR 不使用 / cascade=hygiene / prefetch=false 等)は**必ず現物確認**し、違えば実態を書く。確認できないものは「未確認」。
- **分量方針**: A〜K を記載順に厚く。A〜D(sync/tombstone/auth/GDPR)を最厚、E〜K も現物確認済。
- **how は書かない・テスト件数は書かない**(腐るため。ポインタのみ)。**HEAD**: `898b52c`(develop・① commit 後)。

---

## 1. サマリ表(architecture.md の行候補)

「証明」= 検証テスト(パス)。「決定」= 明示決定 + 日付(テストで守られない)。状態: 現行 / 理由未記録 / 未確認。

| # | 不変条件 / 決定 | 理由 | 証明 / 決定 | 正本(パス) | 状態 |
|---|---|---|---|---|---|
| A1 | IDB はクライアント正本(mirror)。server への反映は outbox(entity_mutations)/ dedicated bulk / server action のいずれか | local-first・offline 編集 | 証明: sync unit + `tests/contract/*bulk*` | `lib/sync/` / `lib/client-db.ts` | 現行 |
| A2 | pull は id-upsert のみ(`clear()` しない)。mirror 削除の唯一経路 = tombstone bulkDelete | 削除の決定性・部分 pull 安全 | 証明: `lib/sync/pull.test.ts` | `lib/sync/pull.ts` | 現行 |
| A3 | pull = 1 GET・6 stream・cursor は inclusive(`gte`) | 増分整合・取りこぼし防止 | 証明: `pull.contract.test.ts` / `lib/db/pull-delta.test.ts` | `app/api/pull/route.ts` / `lib/db/pull-delta.ts` | 現行 |
| A4 | entity-mutation flush = 全 pending を 1 bulk POST(zod max 1000)。review-events は session 別並列 | transport 単純化・DoS 上限 | 証明: `entity-mutations-bulk.contract.test.ts` | `lib/sync/entity-mutations.ts` / `app/api/entity-mutations/bulk/route.ts` | 現行 |
| A5 | 競合解決 = server 権威 reconcile-on-pull(client optimistic + silent catch → 次 pull が server 値で上書き)。cross-device merge なし | local-first の単純収束 | 決定(案 a 取り直し・コメント記録) | `lib/sync/optimistic-mutation.ts` | 現行 |
| A6 | 多重送信防止 3 重: mutation_id UNIQUE(server)+ in-flight set + Web Locks(pull) | 冪等・多タブ安全 | 証明: pull/flush unit | `lib/sync/pull.ts` / `entity-mutations.ts` | 現行 |
| A7 | client/server 共有 invariant は pure 関数 1 定義を両側 import(二重実装しない) | drift 防止 | 決定 + lint(① A2 domain-purity) | `CLAUDE.md`「設計方針(DDD)」 | 現行 |
| B1 | tombstones 専用表が削除伝播の唯一信号。時間ベース GC は無い(意図的) | 長期オフライン端末が削除を取りこぼさない | 決定(2026-07-24 FF §3) | `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md` | 現行 |
| B2 | exam 削除は exam + 配下 card **各々**に tombstone を立てる(client は子を導出しない) | 子 card の他端末 mirror 掃除 | 決定(load-bearing・FF §2) | `app/(app)/app/exams/_actions/delete-exam.ts` | 現行 |
| B3 | 正規 UI 削除は tombstone を立てる / script 直 DELETE は立てない(残留リスク) | 正規経路のみ伝播保証 | 決定(FF §4・follow-up) | 同上 FF | 現行 |
| B4 | 将来 tombstone GC は「cursor が保持期間より古い端末はフル再 pull」検出とセット必須 | GC 単独導入は削除永久取りこぼし | 決定(FF §3) | 同上 FF | 現行(未実装) |
| C1 | Clerk = source of truth。`users` 表は webhook 同期コピー | 認証境界の一元化 | 証明: `webhook-clerk.contract.test.ts` | `app/api/webhooks/clerk/` / `lib/auth/ensure-user.ts` | 現行 |
| C2 | 内部 id 解決 = claim-first(JWT `dbUserId`)→ fallback SECURITY DEFINER `app_bootstrap_user_from_clerk`(RLS 迂回) | RLS bootstrap 循環回避・60s JWT window 対策 | 証明: `ensure-user.test.ts` + iso `lifecycle-null-contract` | `lib/auth/ensure-user.ts` / `drizzle/migrations/0025` | 現行 |
| C3 | `getCurrentUser` は `React.cache` memoize(request-scoped dedupe・load-bearing) | layout+page 二重 SELECT 回避 | 決定(コメント load-bearing 明記) | `lib/auth/ensure-user.ts` | 現行 |
| C4 | SECURITY DEFINER 3 関数(bootstrap/resolve_for_stripe/scrub)は RLS 迂回が必須な特殊経路のみ。scrub は `p_user_id==app.user_id` 自衛 | context 確立前 / scrub 済行を引く必要 | 証明: `rls-functions.test.ts` | `drizzle/migrations/0025_rls_p2_functions.sql` | 現行 |
| C5 | `withTenantTx` が `app.user_id` GUC(SET LOCAL)を張り、policy が `app_current_user_id()` で読む。未設定 → P0RLS loud raise | tenant context の唯一経路・配管ミス表面化 | 証明: `rls-context` / `rls-per-command` | `lib/db/tenant-tx.ts` / `db/policies/` | 現行 |
| C6 | RLS = 「app の WHERE を信頼しない最終境界」。userId は常に auth 由来(client 供給は row ID のみ) | trust-boundary | 証明: `rls-single-defense.test.ts` | `tests/integration/pg/COVERAGE.md` | 現行 |
| C7 | 非 RLS 5 表は command GRANT のみで防御(行隔離なし)。contact は GDPR DELETE の WHERE 用に SELECT 保持 | 非 tenant / global 表 | 証明: `grant-narrowing.test.ts` | `db/roles/recallmint_app-grants-phase3.sql` | 現行 |
| C8 | proxy: `/app(.*)` protect。webhook bypass は callback 内 early-return(matcher lookahead でない) | path-to-regexp 制約(build 時表面化) | 証明: `proxy.test.ts` | `proxy.ts` | 現行 |
| D1 | 退会 = users soft-delete(deleted_at + email/clerk_id scrub・stripe_customer_id 保持)+ Group I 明示 DELETE + assets soft-delete(deleting) | GDPR PII 消去 + audit 相関保持 | 証明: `webhook-clerk.contract.test.ts` + iso GDPR | `lib/clerk/handle-clerk-event.ts` | 現行 |
| D2 | 削除テーブル分類: Group I(handler 明示 DELETE・11 件)/ Group II(exams・tag_categories の FK cascade) | 明示 vs cascade の境界 | 証明: route invariant test(Group I 集合一致) | `handle-clerk-event.ts` | 現行 |
| D3 | FK CASCADE = server 行削除の correctness(hygiene でない)。ただし client 伝播は担わない(= tombstone が別途担う) | cascade は SELECT 増分に出ない | 決定(現物確認・下記 §5) | `lib/db/schema.ts` FK + `pull.ts` | 現行 |
| D4 | 匿名 contact_messages(user_id null)行は退会 scrub で消えない(WHERE user_id 一致のみ) | 匿名 = tenant 非紐付 | 決定(現物) | `handle-clerk-event.ts:219` | 現行 |
| E1 | ISR/SSG を使わない(`revalidate`/`generateStaticParams` ゼロ)。認証 page は `auth()` 経由で dynamic | 認証必須の personalized 描画 | **暗黙**(明示 decision 行 未確認) | 現物: grep ゼロ | 理由未記録 |
| E2 | nav / dynamic への Link は `prefetch={false}` | prefetch 並列 SSR が server 負荷増幅 | 決定(lessons 記録あり) | `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md` | 現行 |
| E3 | 全 API route は `runtime='nodejs'` | pg driver / node crypto 依存 | 決定(各 route 明示) | `app/api/**/route.ts` | 現行 |
| E4 | serverActions bodySizeLimit=4.5mb + security headers(HSTS/XFO/CSP frame-ancestors/Permissions-Policy) | upload 上限を app-level に集約・prod grade header | 決定(コメント記録) | `next.config.ts` | 現行 |
| F1 | card は assetId を保存(URL 非保存)。表示時に presigned GET を resolve。R2 private bucket + presigned PUT/GET | URL 失効・非公開 bucket | 証明: `get-asset.test.ts` / `r2.test.ts` | `lib/storage/r2.ts` / `lib/media/get-asset.ts` | 現行 |
| F2 | 表示は Cache API(blob)+ objectURL。同一 key の presigned 発行は合流(重複回避) | 帯域・presigned コスト | 証明: `cache.test.ts` / `get-asset.test.ts` | `lib/media/cache.ts` / `get-asset.ts` | 現行 |
| F3 | GC v2: asset 状態機械 reserved→ready→deleting→deleted・card_asset_refs 正規化・状態ベース遅延 GC(mark→grace→promote→collect) | 参照ゼロ検出 + grace 猶予 | 証明: `asset-state.test.ts` / `gc-image-assets.test.ts` | `lib/media/domain/asset-state.ts` | 現行 |
| F4 | asset.status 語彙 SSoT = pure domain(DB に CHECK なし) | DDD 監査 D-1 是正 | 証明: `asset-state.test.ts` | `lib/media/domain/asset-state.ts` | 現行 |
| G1 | downgrade 予約 = subscription schedule(phase0 現行 + phase1 開放端 target)+ scheduled_* 3 列 | 期末 downgrade | 証明: `subscription.test.ts` | `lib/stripe/subscription.ts` | 現行 |
| G2 | 予約 clear は Stripe release 成功から decouple(price==target で冪等 UPDATE clear)・release は best-effort。clear site 複数で webhook 順序非保証を吸収 | webhook 順序非保証・orphan 恒久化防止 | 決定 + 証明: `subscription-changes.test.ts` | `docs/audit/2026-07-10-stripe-downgrade-reservation-clear-bug.md` | 現行 |
| G3 | Test Clock 検証ツールが downgrade/予約取消 回帰を証明(手動資産) | 時間依存の実走検証 | 決定(回帰資産) | `scripts/stripe-test-clock-verify.ts` / `docs/ops/stripe-test-clock-verify-runbook.md` | 現行 |
| G4 | Stripe apiVersion を明示 pin しない(SDK exact ゆえ送信版が決定的) | 二重管理回避 | 決定(matrix v2 §6・2026-07-25) | `docs/superpowers/sessions/2026-07-25-deps-target-versions-matrix-v2.md` | 現行 |
| H1 | 薄い DDD: domain=pure / repository・apply=書込 / usecase・action・handler=orchestration / infra=I/O | 不変条件の実在に応じた層分け | 決定 + lint(① A2) | `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` / `CLAUDE.md` | 現行 |
| H2 | client は repository を持たない(pure fn + runOptimistic* で不変条件計算 → 楽観書込) | local-first 優先 | 決定 | `CLAUDE.md`「設計方針(DDD)」 | 現行 |
| I1 | app 経路 = `DATABASE_URL_APP`(getDb・app role・RLS)。owner 経路 = `DATABASE_URL_ADMIN`(getAdminDb・script 専用) | 最小権限 / owner 分離 | 決定(RLS-P1) | `lib/db/index.ts` | 現行 |
| I2 | 破壊 script の L2 guard を信用しない(実効境界 = env 目視 + --user scope + dry-run 先行) | guard は stg/prod 非判別 | 決定(feedback memory) | `scripts/seed-perf-exam.ts` / `gc-image-assets.ts` | 現行 |
| J1 | OCR = Flash のみ(Pro fallback なし)・429 即 throw(retry/fallback せず)・overall deadline 720s | 無料枠運用・CLAUDE.md AI 絶対則 | 証明: `ocr.test.ts` | `lib/ai/ocr.ts` / `CLAUDE.md`「AI API」 | 現行 |
| J2 | @google/genai 1.x 維持(2.x は将来 OCR sprint 同梱・現状不可触) | 変更源分離 | 決定(matrix v2 §4) | matrix v2 doc | 現行 |
| K1 | pnpm 依存 lifecycle script は既定 block・`onlyBuiltDependencies`(bufferutil/utf-8-validate)のみ許可 | supply-chain 面の既定防御 | 決定(pnpm 10 既定 + workspace 設定) | `pnpm-workspace.yaml` | 現行 |
| K2 | コンテナ egress に制限を設けない(意図的) | 調査/install/push に必要・隔離はコンテナが担保 | 決定 2026-07-26 | ①doc §C + 本 doc §K | 現行 |

---

## 2. 領域別の詳細(A〜K)

### A. local-first sync

- **IDB = 正本 mirror / 書込経路**(A1): client は Dexie(`recallmint` DB)を mirror として持つ。server への反映経路は **3 系統**で、outbox 一本ではない(現物確認):
  - **entity_mutations outbox**: `card` / `tag_category` / `tag_option` の field 編集・create・delete。`enqueueEntityMutation` が coalesce(同 entity 同 field の連続編集を pending 1 行に畳む)→ `flushAllPendingEntityMutations` が 1 bulk POST。
  - **review-events bulk**: FSRS review イベント(session 別グルーピングで並列 flush・`lib/sync/review-events.ts`)。
  - **server action 直**: exam create/delete(outbox を通らない・`delete-exam.ts` / `create-exam-form.tsx`)/ settings / upload / billing。
  - → 「書きは outbox 経由のみ」は **card/tag に限る**。exam・review・settings は別経路(この非対称は B2 の tombstone 責務の背景でもある)。
- **pull 構造**(A2/A3): `GET /api/pull` が **6 stream**(cards / exams / tombstones / tag_categories / tag_options / card_tags)を返し、client `pullDelta` が **1 Dexie rw tx** で「id-upsert(`clear()` 不使用)→ 変更 card の card_tags 全削除 → card_tags upsert → tombstone bulkDelete → cursor write」を順序厳守で適用。cursor は `deleted_at`/`updated_at` base で `since` は **inclusive(gte)**。失敗時不変性 = tx を開く前に return(mirror を touch しない)。**mirror から行を消す唯一経路 = tombstone bulkDelete**。card_tags の whole-set 縮小(`[A,B]→[]`)は cards.updated_at bump + 変更 card の card_tags purge で伝播(案 a)。
- **transport 制約**(A4): entity-mutation flush は全 pending を **1 POST**(zod `max(1000)` = DoS 寄り巨大 payload 排除)。review-events は session 別に並列。bulk は per-mutation 独立 tx・部分失敗は `failed[]` に積んで 200(envelope 不正のみ 400)。冪等 = `mutation_id` UNIQUE + `onConflictDoNothing`。
- **flush / pull 契機**(A6): flush trigger = optimistic 書込後の fire-and-forget + inline field の debounce drain(500ms)+ mount trigger component + 画像 upload。pull trigger = 入口 mount kick / `pullBack` / OCR pending・complete(`exam-status-live`)/ exam create・delete。多重は in-flight guard(1 タブ)+ Web Locks(多タブ・`ifAvailable` skip)+ server cursor 冪等で吸収。
- **競合解決**(A5): 明示的 LWW doc は無い。実装上の規則 = **server 権威の reconcile-on-pull**。client の optimistic 書込は Dexie rw tx(mirror + outbox atomic)、失敗は silent catch + `logger.warn`(案 a 取り直し)→ **次回 pull が server 値で mirror を上書き**。cross-device 同時編集は「最後に server apply された field 値が勝ち、pull で全端末へ伝播」= 実質 server-side last-write-wins per field(coalesce は outbox 内 latest edited_at を保持)。→ §3 で「暗黙寄りの決定」に分類。
- **client/server 二重実装しない**(A7): 共有 invariant は pure 関数 1 定義を両側 import(DDD・lint domain-purity で境界強制)。client 側は repository を持たず pure fn + `runOptimistic*`(H2)。

### B. tombstone / 削除伝播

正本 = `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md`(現物確認済・転記でなく出典明記)。

- **tombstone = 削除伝播の唯一信号・GC 無し**(B1): 時間ベース GC / TTL / prune は repo 全体に**不在**(vercel.json に crons なし・GHA 不採用)。tombstones を DELETE する唯一箇所 = 退会時の per-user 全消し。**無期限蓄積 + inclusive cursor が「長期オフライン端末が削除を取りこぼさない」理由そのもの** = 現状は正しい設計(意図的)。
- **exam 削除の load-bearing 不変条件**(B2): exam 削除は `tombstones` へ **exam 1 件 + 配下 card 全件を個別 INSERT** してから物理 DELETE。client は exam tombstone から子 card を導出しない(`pull.ts` は exams のみ bulkDelete)ため、子 card の他端末掃除は server が撒く個別 card tombstone に全面依存。card_tags のみ client 側で card/option tombstone から導出 purge。
- **正規 vs script**(B3): 正規 UI 削除(server action)は tombstone を立てる。`seed-perf-exam.ts --cleanup` の DB 直 DELETE は tombstone を立てない(= 実ユーザー経路でない残留の再発源・follow-up)。
- **将来 GC の必須セット**(B4): GC 単独導入は禁物。保持期間より古い cursor を持つ端末は消えた tombstone を差分で永久取りこぼす → 「client cursor が保持期間より古ければフル再 pull(全 mirror 再構築)」検出とセットが必須。

### C. 認証 / テナント境界

- **Clerk → 内部 id 解決**(C1/C2/C3): Clerk = source of truth、`users` は webhook 同期コピー(`clerk_id` で紐付け)。`getCurrentUser`(`lib/auth/ensure-user.ts`)は **claim-first**: JWT `sessionClaims.dbUserId` があれば users SELECT せず fast path、無ければ SECURITY DEFINER `app_bootstrap_user_from_clerk(clerkId)`(RLS 迂回)で内部 id を解決 → `withTenantTx(resolvedId, …)` で `users` を `id=? AND deleted_at IS NULL` 読み。**`React.cache` memoize**(request-scoped dedupe = layout + page で SELECT 1 回・load-bearing 明記)。`getAuthContext` は JWT のみ読む軽量版(DB 不要)。scrub 済 / 60s JWT window の ghost は app-WHERE `deleted_at IS NULL` で 0 行 → null 契約 → write 側 `!user` guard が ghost 書込を弾く。
- **SECURITY DEFINER 3 関数**(C4・`0025_rls_p2_functions.sql`): ①`app_bootstrap_user_from_clerk`(claim なし fallback / 退会 resolve・SETOF users)②`app_resolve_user_for_stripe`(id/clerkId/stripeCustomerId/scheduleId の 4 arm・退会済も返す)③`app_scrub_deleted_user`(scrub UPDATE)。**DEFINER である理由** = ① は tenant context 確立**前**に内部 id を引く(RLS 迂回が構造的に必要)、②③ は scrub 済(clerk_id NULL)行を引く / 書く必要。DEFINER の危険性は **scrub の自衛検査**(`p_user_id <> app_current_user_id()` で RAISE P0RLS)+ REVOKE PUBLIC + GRANT recallmint_app のみ、で封じる。`app_current_user_id()`(SECURITY INVOKER)は GUC 未設定で **P0RLS loud raise**(静かな 0 行にしない)。
- **withTenantTx / GUC / P0RLS 契約**(C5): RLS 対象表への全アクセスは `withTenantTx(userId, fn)` 内(tx 冒頭 `set_config('app.user_id', uuid, true)` = SET LOCAL)。policy USING/WITH CHECK が `(SELECT app_current_user_id())` で読む。`getDb` 直呼びは ① lint ban(① A1)。
- **trust-boundary**(C6): userId は常に auth 由来(request body / outbox / query param 由来の userId を `WHERE user_id` に使う経路は無い・client 供給は row ID のみ)。RLS は「app WHERE を信頼しない最終境界」(`rls-single-defense` が最強証明)。**例外的性質 3 件**(COVERAGE trust-boundary): ① RSC 4 page が JWT claim `dbUserId`(server 署名)を tenant key に使用(body 非由来・理論上のみ)② OCR 2 write が id-only(現在 dual-enforced)③ webhook は署名を別 trust anchor とする。
- **非 RLS 5 表**(C7): `ai_usage`/`stripe_events`/`clerk_events`(global・user_id 無)+ `contact_messages`(匿名)+ `integration_failures`(audit)は RLS を張らず **command GRANT のみ**(行隔離を与えない = blast radius 受容)。contact は退会 `DELETE WHERE user_id` が user_id を読むため **SELECT 保持必須**(PG17 規則・OT 批准)。
- **proxy**(C8): `clerkMiddleware` が `/app(.*)` を `auth.protect()`。webhook は matcher lookahead でなく callback 内 `isWebhookBypass` early-return で構造保証(path-to-regexp が capturing group/lookahead 不可 = build 時のみ表面化した T-A4 教訓)。CSP は Clerk auto CSP(connect/img/worker)+ next.config の frame-ancestors の二重防御。

### D. GDPR / 削除契約

正本 = `lib/clerk/handle-clerk-event.ts`(現物確認)。

- **退会契約**(D1): `user.deleted` webhook → ① Stripe sub cancel ループ(customerId あれば・tx 外・失敗は integration_failures 記録)② DB tx で **users soft-delete**(`app_scrub_deleted_user` = `deleted_at=now(), email=NULL, clerk_id=NULL`・**stripe_customer_id は correlation key として保持**)+ **Group I 明示 DELETE**(10 表)+ **assets のみ soft-delete**(`status='deleting'`・R2 object_key 保全で GC reconciler の優先 sweep に委譲)。tx は最大 3 retry(transient のみ)・冪等。
- **消える表 / 残る表**(D2):
  - **明示 DELETE(Group I・11 件)**: exams / study_days / contact_messages / ai_usage_users / upload_records / user_settings / study_sessions / tombstones / entity_mutations / tag_categories + assets(唯一の soft-delete 例外)。
  - **cascade 連鎖(Group II)**: cards / source_documents(exams cascade)/ reviews / answer_events(cards cascade)/ tag_options(tag_categories cascade)/ card_tags(card/option cascade)。**二重に書かない**。
  - **残る**: users 行(soft-delete・audit/correlation)/ global 表(ai_usage・stripe_events・clerk_events は user_id 無で対象外)/ 匿名 contact_messages(user_id null 行)。
  - 網羅性は route invariant test(Group I 集合 = handler 明示 DELETE 集合)が保証。新 user_id direct FK 表を足すと test が落ちて気づく。
- **cascade の位置づけ**(D3・claude.ai 前提「cascade=hygiene」の検証): **現物は「hygiene」でなく server 行削除の correctness 機構**。users は soft-delete で users.id FK cascade は**発火しない**ため Group I は明示 DELETE 必須。Group II は exams/tag_categories の明示 DELETE に FK cascade で連鎖(= handler がそれに依存 = load-bearing)。ただし **cascade は client 伝播を担わない**: cascade で消えた行は SELECT 増分に出ないため、他端末 mirror 掃除は別途 tombstone(B2)/ client 側導出 purge が担う。→ 「cascade= server 状態の correctness / client 伝播 = tombstone」の二層(§5 で前提訂正)。
- **匿名データ**(D4): contact_messages は匿名送信(user_id null)を許す。退会 scrub は `DELETE WHERE user_id=` ゆえ **匿名行は消えない**(tenant 非紐付)。

### E. レンダリング / Next 方針(現物確認・記憶で断定せず)

- **ISR / SSG / dynamic**(E1): `export const revalidate` / `generateStaticParams` / `export const dynamic` は **repo 全体でゼロ**(grep 実測)。→ **「ISR 不使用」は現物で確認**。認証 page は Clerk `auth()` の呼出が dynamic rendering を誘発する(App Router 既定)。ただし **「dynamic を選ぶ」明示 marker も decision 行も未発見** = 実装は全 dynamic だが決定の記録が無い(§3 暗黙 / H-1 で理由確定対象)。`docs/02-tech-spec.md` に記述がある可能性は**未確認**(本タスクでは未読)。
- **prefetch**(E2・記憶「prefetch={false}」の検証): **多数の Link で `prefetch={false}` を現物確認**(app-header 全 nav / dashboard-actions / exam list / settings / upload / pricing 等)。理由は明示記録あり = `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md`(dynamic page の並列 prefetch が server SSR を N 件並列で走らせ負荷増幅)。= 決定 + 理由記録あり。
- **runtime**(E3): 全 API route が `export const runtime = 'nodejs'`(pg driver / node crypto 依存)。
- **next.config**(E4): security headers(HSTS/X-Frame-Options DENY/X-Content-Type-Options/Referrer-Policy/CSP frame-ancestors none/Permissions-Policy 23 directive)+ serverActions `bodySizeLimit: '4.5mb'`(upload 上限の正本は app-level constants、platform 4.5MB と margin 内)+ reactStrictMode。
- **server/client 境界**(E5): RSC 前提。client-only module は `getClientDb()` が server で throw する設計を guard に使う(`'use client'` の代わりに banner + getClientDb throw で防御・optimistic-mutation.ts 等)。

### F. 画像

- **assetId 保存 / URL 非保存**(F1): card は assetId(key)を保存し URL を保存しない。表示時に `resolveAssetUrls` で **presigned GET** を発行。R2 は **非公開 bucket**(spec §8)で presigned PUT(browser 直 PUT)/ GET のみ(`lib/storage/r2.ts`・aws4fetch・presigned TTL 10 分)。presigned DELETE は不採用(server 直 DELETE 専用)。
- **Cache API / blob**(F2): 表示は Cache API に blob を格納し objectURL で `<img>`。同一 key の resolve は in-flight 合流(重複 presigned 発行 + download を防ぐ・`get-asset.ts`)。
- **GC v2 契約**(F3/F4): asset 状態機械 **reserved→ready→deleting→deleted**(pure domain `asset-state.ts` が語彙 SSoT・DB CHECK 無し)。参照は `card_asset_refs`(正規化)。**状態ベース遅延 GC** = mark(参照ゼロ + reserved|ready + 未マーク → `unreferenced_at=now()`)→ grace 経過(strict older)→ promote(deleting)→ collect(R2 削除 + 行 DELETE)。self-heal = 再参照で `unreferenced_at` NULL 戻し(deleting→ready は別途)。**新規参照は ready のみ許可**(`allowsNewReference`)。reconciler(`scripts/gc-image-assets.ts`)は owner(admin)script・deploy 後のみ実行(運用不変条件・memory `project_image_gc_v2`)。
- **表示側の契約**(モーダル/畳み/4 欄): 個別 UI 値は対象外。契約と言えるもの = 表示専用で sync/DB 不変(memory `project_image_display_ux_sprint`)。詳細不変条件は memory / session doc に既述ゆえ本 doc では再掲しない。
- **cross-user dedup 永久除外(one-way door)**: 記憶にある「cross-user dedup 永久除外」の**明示記録場所は本調査で特定できず**(grep で該当 doc 断定不能)→ **未確認**(§5)。

### G. billing

正本 = `docs/audit/2026-07-10-stripe-downgrade-reservation-clear-bug.md`(現物確認)+ `lib/stripe/`。

- **downgrade 予約契約**(G1): `subscriptionSchedules.create({from_subscription})` + `end_behavior:'release'` + phases 2 本(phase0=現行 price/請求期間・phase1=開放端 target)。DB は `scheduledDowngradeScheduleId` / `scheduledTargetPriceId` / `scheduledChangeEffectiveAt` の 3 列で予約を保持。
- **orphan decouple + webhook 順序非保証の二方向 fix**(G2): 元バグ = 予約 clear が Stripe `release` 成功に gate され、release throw で clear 未実行 → orphan 恒久化(開放端 phase1 は `subscription_schedule.released` が発火せず自然回収も inert)。fix 方向 = **clear を release 成功から decouple**(price==target を満たしたら冪等条件付き UPDATE で無条件 clear)+ active-release は **best-effort**(失敗が clear を阻害しない)。clear site が **複数**(`released` event / `clear_direct`(sub.schedule==null)/ `delegate`(price==target))存在し、各々冪等ゆえ **webhook 到達順の非保証を吸収**(どの経路が先でも予約が残らない)。
- **検証資産**(G3): Test Clock 検証ツール(`scripts/stripe-test-clock-verify.ts` + runbook)が downgrade→期日到来→予約 clear の回帰を実走証明(CC=setup/observe/advance/cleanup・人力=UI upgrade→downgrade/取消)。
- **apiVersion 非 pin**(G4): `new Stripe(key, {maxNetworkRetries:2, timeout:10000})` で apiVersion 未指定 = SDK が pinned 版(22.3.2 → `2026-06-24.dahlia`)を送信。**明示 pin しない決定**(全 direct exact ゆえ送信版が決定的・明示 pin は SDK 実装との二重管理 drift 源・matrix v2 §6・2026-07-25)。webhook 検証は送信版非依存。

### H. ドメイン設計(薄い DDD)

正本 = `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md`(意図の正本)+ `CLAUDE.md`「設計方針(DDD)」。

- **層責務**(H1): ドメイン規則(不変条件・判定・状態遷移)= `lib/<context>/domain/` の **pure 関数**(I/O なし・test 厚く・lint domain-purity で infra/framework runtime import 禁止)。書込 = repository / apply 層(TenantTx 受領)。orchestration = usecase / action / handler。外部 I/O = infra(`lib/storage/` 等)。導入基準 = **「不変条件が実在するから」**(YAGNI と両立・教科書 DDD 全部盛りはしない)。確立 = P0〜P4 + F1〜F3 + 画像 GC G2(asset-state)。
- **client は repository を持たない**(H2・意図的): client 側は aggregate の pure 関数で不変条件を計算 → 既存 `runOptimistic*` で書く(local-first 優先)。client/server の共有 invariant は pure 関数 1 定義を両側 import(二重実装しない)。

### I. scripts / 運用

- **script 用途一覧**(1 行):
  - `seed-perf-exam.ts` — perf 計測用 [PERF-SEED] exam の seed / --cleanup(owner・DB 直 DELETE・tombstone 立てず)。
  - `gc-image-assets.ts` — 画像 GC reconciler(owner・mark/promote/collect・deploy 後実行)。
  - `backfill-card-asset-refs.ts` — card_asset_refs 正規化 backfill(owner)。
  - `backfill-clerk-metadata.ts` — Clerk publicMetadata backfill(owner)。
  - `stripe-test-clock-verify.ts` — Test Clock 回帰検証(setup/observe/advance/cleanup)。
  - `audit-gate.mjs` / `check-audit-config.mjs` — ① B3(audit gate wrapper / tripwire)。
  - `ai/*.sh` — ① E2/E3(Codex review / plan-review / detector / count-findings)。
- **owner vs app 経路**(I1): `getDb()` → `DATABASE_URL_APP`(app role `recallmint_app`・NOBYPASSRLS・RLS 対象)。`getAdminDb()` → `DATABASE_URL_ADMIN`(owner・RLS bypass・script 専用: seed/gc/backfill/integration-failures)。`getNonTenantDb()` = `getDb()`(app role だが tenant context 非設定・bootstrap / global 表用・tx-local GUC ゆえ pool 越し漏洩なし)。env は `.env.example` に `DATABASE_URL_APP=postgresql://...` / `DATABASE_URL_ADMIN=`(空値・後埋め)。
- **L2 guard 不信規律**(I2): 破壊 script の内部 guard は stg/prod を判別しない(seed L2 は password 誤 match / GC は URL チェック無し)。実効境界 = **env 目視 + --user scope + dry-run 先行**(GC smoke は referenced>0 gate 必須)。memory `feedback_destructive_script_guards`。
- **テストユーザー台帳**(現在値): **単一の正本台帳 doc は本調査で発見できず**。test user(例 `test1`)は smoke session doc + memory `reference_stg`(stg = stg.recallmint.nekotest.net / Dexie 'recallmint')に散在。stg には実カード A/B が無く PERF-SEED 300 のみ(mirror 直注入で検証)。**canonical 台帳の不在 = §5 未確認**(prod のテストユーザー値も未確認)。

### J. OCR(現契約のみ・中身の改善提案はしない)

- **呼び出し経路 / 責務**(J1): `lib/ai/ocr.ts` = OCR pipeline(Flash → HTTP retry → JSON parse → zod validate)。外部 SDK は直接触らず `lib/ai/clients/gemini.ts` の `callGemini` 経由(test は完全 mock)。prompt = `lib/ai/prompts/ocr-extract.ts`(= 記憶の「ocr-extract.ts」は**この prompt builder**であって pipeline 本体は `ocr.ts`・§5)。schema = `lib/ai/schemas/ocr-response.ts`。契約 = **Flash のみ(Pro fallback なし)**・transient は exp backoff で最大 2 retry・JSON parse 失敗/cards=0/retry 尽きで即 throw・**429 は即 throw(retry も Pro fallback もしない)**・overall deadline 720s(Vercel 800s hard 手前で自前停止)。CLAUDE.md「AI API」= 無料枠のみ・日次上限 `GEMINI_DAILY_LIMIT` + `ai_usage`・ユーザー明示トリガーのみ・test は mock 必須。
- **不可触の記録**(J2): @google/genai **1.x 維持(2.x は将来 OCR sprint 同梱・現状触らない)** = matrix v2 §4。OCR 中身の改善は次 sprint 領域(本 doc では扱わない)。

### K. ① への追補(2 点)

- **K1 pnpm lifecycle script**: `.npmrc` は**存在しない**(実測)。pnpm 10 の既定は **依存 package の lifecycle script(postinstall 等)を実行しない**。`pnpm-workspace.yaml` の `onlyBuiltDependencies`(`bufferutil` / `utf-8-validate`)が **明示許可リスト**(この 2 つの native build のみ実行)。→ **既定 block = supply-chain 面の防御**(① の「機械/構成」層に追補可能)。project 自身の `prepare: lefthook install`(root package script)は install 時に常に走る(依存 lifecycle ではない)。
- **K2 egress 無制限は意図的決定**(決定行): **コンテナからの外向き通信に制限を設けない(意図的)。理由 = 調査 / curl / パッケージ install / context7 整合性チェック / push に必要。ホスト隔離はコンテナが担保。CC の逸脱は permission deny list とレビューで防ぐ。決定 2026-07-26。**(① §C「network 制約の実態」= CC permission 層の egress CLI ban のみ・コンテナ firewall 無し、と整合)。

---

## 3. 分類(証明あり / 決定のみ / 暗黙)

### 証明あり(検証テストが存在)

A2 pull id-upsert(`pull.test.ts`)/ A3 6-stream inclusive cursor(`pull.contract` / `pull-delta.test`)/ A4 bulk transport(`entity-mutations-bulk.contract`)/ A6 多重送信防止(pull/flush unit)/ C1 Clerk sync(`webhook-clerk.contract`)/ C2 id 解決(`ensure-user.test` + iso `lifecycle-null-contract`)/ C4 DEFINER 関数(`rls-functions.test`)/ C5 GUC/P0RLS(`rls-context`/`rls-per-command`)/ C6 RLS 最終境界(`rls-single-defense`)/ C7 grant narrowing(`grant-narrowing.test`)/ C8 webhook bypass(`proxy.test`)/ D1・D2 退会 delete-set(`webhook-clerk.contract` + route invariant + iso GDPR)/ F1 assetId/presigned(`get-asset.test`/`r2.test`)/ F3・F4 GC 状態機械(`asset-state.test`/`gc-image-assets.test`)/ G1 schedule(`subscription.test`)/ G2 clear decouple(`subscription-changes.test`)/ J1 OCR 契約(`ocr.test`)。

### 決定のみ(明示決定・テストで守られない / 記録あり)

A5 competing 解決 = server 権威 reconcile(案 a・コメント記録)/ A7 pure 関数 1 定義(DDD + lint)/ B1 tombstone GC 無し(FF §3)/ B2 exam+子 tombstone(FF §2)/ B3 正規 vs script(FF §4)/ B4 将来 GC セット条件(FF §3)/ C3 getCurrentUser cache load-bearing(コメント)/ E2 prefetch=false(lessons 記録)/ E3 runtime=nodejs / E4 next.config header・bodySizeLimit / G3 Test Clock 資産 / G4 apiVersion 非 pin(matrix v2 §6)/ H1・H2 薄い DDD(intent doc + CLAUDE.md)/ I1 owner/app 分離(RLS-P1)/ I2 L2 guard 不信(feedback memory)/ J2 genai 1.x hold(matrix v2 §4)/ K1 pnpm lifecycle block(workspace 設定)/ K2 egress 無制限(2026-07-26 決定)。

### 暗黙(実装はそうだが決定として記録されていない = 誰も守る約束をしていない)【主収穫】

- **E1 レンダリングモード(全 dynamic / ISR・SSG 不使用)**: 実装は全 dynamic(revalidate/generateStaticParams ゼロ)だが「dynamic を選ぶ / ISR を使わない」明示 decision 行が未発見。`auth()` の副作用に暗黙依存。
- **A5 の cross-device 競合の厳密規則(server-side per-field LWW)**: 「次 pull が reconcile」までは記録あるが、「同時編集で最後の server apply が勝つ」という cross-device 競合規則自体を明示決定した doc は未発見(coalesce = outbox 内 latest、server apply = update_field 上書き、から**emergent**)。
- **D3 cascade の責務境界(server 行削除 vs client 伝播)**: FK cascade が Group II の削除に load-bearing で依存されている事実は handler コメントにあるが、「cascade は correctness / 伝播は tombstone」という**責務分離を 1 箇所で宣言した設計 doc は未発見**(delete-exam / handle-clerk / pull.ts に分散)。
- **A1 書込経路の非対称(card/tag=outbox / exam・review・settings=別経路)**: 3 系統併存は各 sprint で個別に決まったもので、「なぜ exam は outbox を通さないか」を横断的に決定した記録は未発見。
- **D4 匿名 contact_messages が退会で残る**: 実装挙動(WHERE user_id で匿名行は消えない)だが、匿名データの保持を意図決定した記録は未発見(GDPR 上の意図か実装の副産物か不明)。
- **F 表示側 UI 契約と個別値の境界**: どこまでが「契約」でどこからが「個別 UI 値」かの線引きが memory/session doc に分散し、architecture 級の宣言が無い。
- **I テストユーザー台帳の不在**: canonical な test-user 台帳 doc が無く、smoke doc に散在(prod 値は未確認)。運用上の暗黙知。

### 分類できず(未確認)

F cross-user dedup one-way door の記録場所 / E1 の理由が docs/02-tech-spec.md 等にあるか / I prod テストユーザー値。

---

## 4. 証明の空白(risk・対策は提案しない)

「壊れたら重い」のに証明テストが弱い / 無い不変条件:

1. **B2 exam+子 card tombstone**(重): これを欠くと子 card が他端末に永久残留(2026-07-24 事象の本体)。server 側 delete-exam の tombstone INSERT は unit で守られるが、**「正規 UI 削除が実際に別端末へ伝わる」end-to-end 実機証跡は未取得**(FF §5 が明記)。多デバイス伝播は自動 test の射程外。
2. **E1 レンダリングモード**(中): 誰かが誤って `export const dynamic='force-static'` / ISR を入れると認証 page が別ユーザーにキャッシュされうる(RLS より前段の漏洩)。だが「全 dynamic」を守る test / lint は無い(暗黙)。
3. **A5 cross-device 競合の収束**(中): 同時編集の最終収束(pull reconcile 後に全端末一致)を multi-device で検証する test は無い(単一 client の optimistic/rollback は unit あり)。
4. **B1 tombstone 無期限蓄積**(中・将来): 現状正しいが、誰かが GC を B4 のセット条件なしで入れると長期オフライン端末が削除を永久取りこぼす。GC を弾く仕組みは無い(規律のみ)。
5. **D3 cascade 依存**(中): Group II が exams/tag_categories の cascade に暗黙依存。FK 定義を誰かが `ON DELETE SET NULL` 等に変えると退会削除が漏れる。route invariant test は Group I 集合を守るが **Group II の cascade 経路自体**を守る test は薄い。
6. **G2 webhook 順序非保証**(中・決済): clear site 複数で吸収する設計だが、実 Stripe の全到達順パターンを網羅する test は無い(Test Clock 手動 smoke が補完)。
7. **I2 破壊 script の実効境界**(中・運用): env 目視 + dry-run という人手境界。stg/prod 誤爆を機械で止める層は無い(feedback memory が繰り返し警告)。

---

## 5. 矛盾・不明・要 OT 判断

### claude.ai 前提 vs 実態(明示列挙)

1. **「① のサマリ表に C2 が無い」= 誤(C2 は存在)**: ①doc(`2026-07-26-h0-part1-harness-inventory.md`)§1 の **行 34 = 「C2 | `git commit --no-verify`/`-n` の機械封鎖」** が現存。欠番でない。報告時の整形でも落ちていない(chat 報告にも C2 あり)。→ **前提誤り・doc 変更不要**。
2. **「ISR 不使用」= 現物で確認(前提正しい)**: `revalidate` / `generateStaticParams` / `export const dynamic` は repo 全体ゼロ(grep 実測)。ただし「ISR を使わない」明示 decision 行は未発見 = 実装は正しいが**理由未記録**(§3 暗黙・H-1 対象)。
3. **「cascade = hygiene」= 不正確**: 現物では FK cascade は **server 行削除の correctness 機構**で、退会 Group II 削除が cascade に load-bearing 依存(handle-clerk-event コメント)。「hygiene」的なのは「client 伝播を担わない」点のみ(伝播は tombstone)。→ **前提を「cascade=server 行 correctness / client 伝播=tombstone の二層」に訂正**(§2 D3)。
4. **「prefetch={false}」= 現物で確認(前提正しい)+ 理由記録あり**: 多数 Link で使用・理由 = lessons 2026-05-25(prefetch 並列 SSR の負荷増幅)。
5. **「ocr-extract.ts の責務」= ファイル名の実態訂正**: OCR pipeline 本体は `lib/ai/ocr.ts`。`prompts/ocr-extract.ts` は **prompt builder**。「ocr-extract.ts に pipeline 責務」は不正確(責務は ocr.ts、prompt が ocr-extract)。
6. **「② OCR sprint まで不可触」の記録場所**: 「不可触」を verbatim で述べる現行 doc は未発見。実質の記録 = @google/genai **1.x 維持(2.x は OCR sprint 同梱)** = matrix v2 §4、現契約 = CLAUDE.md「AI API」。

### docs 間 / docs とコードの矛盾

- **①からの継承(未解消・要 OT)**: `uuid: ^14.0.0` override 形骸化の疑い / matrix v2 doc の「CLAUDE.md stale」注記が既に解消済で取り残し(詳細 = ①doc §5・本 doc では再掲のみ)。
- 本 ② の調査範囲では **docs とコードの新規矛盾は検出せず**(delete-exam / handle-clerk / pull / RLS / stripe いずれも参照 doc と実体一致)。

### 未確認(埋めず残す)

- **F cross-user dedup 永久除外(one-way door)の記録場所**: grep で該当 doc を断定できず。設計として実在するか(記憶の混線か)を含め **未確認**。
- **E1 レンダリング決定の理由記録**: `docs/02-tech-spec.md` 等に「dynamic/ISR 方針」があるかは本タスクで未読 = **未確認**(H-1 で確定対象)。
- **I テストユーザー台帳(canonical)**: 単一正本 doc が無く smoke doc に散在。prod のテストユーザー値は **未確認**。
- **A5 cross-device 競合の厳密規則**: server-side per-field 上書きの emergent 挙動は掴めたが、registry apply の全 op の上書き semantics を全数確認したわけではない(update_field 系のみ確認)= **一部未確認**。

---

## 6. 実測エビデンス(要点)

現物 Read / grep で裏取り。既存 docs を正本として使う場合は出典明記、現物と食い違えば §5 に矛盾として記録。

| 領域 | 手段 | 要点 |
|---|---|---|
| A sync | Read `lib/sync/{pull,optimistic-mutation,entity-mutations}.ts` + `app/api/entity-mutations/bulk/route.ts` + grep pull/flush triggers | id-upsert / tombstone 唯一削除 / bulk max 1000 / 案 a reconcile / 3 系統書込 |
| B tombstone | Read `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md`(全読)| GC 無し(意図的)/ exam+子 tombstone / script 直 DELETE 残留 |
| C auth/tenant | Read `lib/db/tenant-tx.ts` / `lib/auth/ensure-user.ts` / `drizzle/migrations/0025` / `proxy.ts` | claim-first + DEFINER fallback / GUC+P0RLS / scrub 自衛 / webhook early-return |
| D GDPR | Read `lib/clerk/handle-clerk-event.ts`(全読)| soft-delete+scrub / Group I 11 明示 / assets 例外 / cascade=correctness |
| E rendering | Read `next.config.ts` + grep `dynamic/revalidate/generateStaticParams/prefetch/runtime` | revalidate/SSG ゼロ(ISR 不使用確認)/ prefetch=false 多数 + lessons / runtime=nodejs |
| F images | Read `lib/media/domain/asset-state.ts` + grep r2/get-asset/gc | assetId 保存 / presigned / 状態機械 / one-way door は未確認 |
| G billing | Read `docs/audit/2026-07-10-stripe-downgrade-reservation-clear-bug.md`(結論部)+ ls `lib/stripe` | schedule 予約 / clear decouple / apiVersion 非 pin |
| H DDD | `CLAUDE.md`「設計方針(DDD)」+ intent doc パス参照 | 薄い DDD 層責務 / client repository 無 |
| I scripts | Read `lib/db/index.ts` + grep getAdminDb / DATABASE_URL / ① script list | APP=app role / ADMIN=owner / getNonTenantDb=getDb / test-user 台帳 不在 |
| J OCR | Read `lib/ai/ocr.ts`(冒頭)+ ls `lib/ai` | ocr.ts=pipeline / prompts/ocr-extract.ts=prompt / Flash only / 429 即 throw |
| K 追補 | 実測 `.npmrc` 不在 + `pnpm-workspace.yaml` onlyBuiltDependencies | lifecycle 既定 block + 2 native 許可 / egress 無制限 = 意図決定 |

---

## 完了範囲

A〜K **全領域を現物確認で完了**(薄く流さず。A〜D 最厚)。未確認として残したのは §5 の 4 点(one-way door 記録 / tech-spec の rendering 理由 / prod test-user 値 / registry 全 op の LWW semantics)。これらは埋めず「未確認」で明示。architecture.md(③以降)へは §3 の「暗黙」7 項が主入力。
