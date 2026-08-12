# architecture — 設計不変条件の索引

**本書は索引。正 = 各行のポインタ先**(コード / test / 決定記録)。how は書かない。件数・数値・版番号は書かない(正本を見る)。

「証明」= それを検証するテストのパス。「決定」= 決定日 + 理由(テストで守られないもの)。

素材 = `docs/audit/2026-07-26-h0-part2-architecture-invariants.md`(② 設計不変条件)+ `docs/superpowers/sessions/2026-07-26-h1a-docs-cleanup-and-h1b-handoff.md`(H-1a 抽出)。

**「今回明文化」表記**: ② で「暗黙(実装はそうだが決定記録なし)」と判定した行は、遡って「昔から決めていた」ように書かない。**実装 = 現物確認済 / 理由 = 今回明文化(or 理由未確定)/ 決定日 = 2026-07-26** の形で示す。

---

## 1. sync(local-first)

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| IDB = クライアント正本(mirror)。server 反映は 3 系統(entity_mutations outbox = card/tag / review-events bulk = 演習回答 / server action = exam・settings・upload)| local-first・offline 編集 | 証明: sync unit + `tests/contract/*bulk*` | `lib/sync/` / `lib/client-db.ts` |
| pull は id-upsert のみ(`clear()` しない)。mirror 削除の唯一経路 = tombstone bulkDelete | 削除の決定性・部分 pull 安全 | 証明: `lib/sync/pull.test.ts` | `lib/sync/pull.ts` |
| pull = 1 GET・6 stream・cursor は inclusive(`gte`)| 増分整合・取りこぼし防止 | 証明: `tests/contract/pull.contract.test.ts` / `lib/db/pull-delta.test.ts` | `app/api/pull/route.ts` |
| entity-mutation flush = 全 pending 1 bulk POST(上限あり)。多重送信防止 3 重(mutation_id UNIQUE + in-flight set + Web Locks)| transport 単純化・冪等・多タブ安全 | 証明: `tests/contract/entity-mutations-bulk.contract.test.ts` | `lib/sync/entity-mutations.ts` / `app/api/entity-mutations/bulk/route.ts` |
| **review-events flush = 自 user の pending を `{ events: [] }` の 1 POST に一本化(session オブジェクトなし・session 単位並列なし)。server は単一 tx で受け、同一 card への FSRS 適用を行ロックで直列化し、時系列を逆行する event を隔離する(applied=false)** | 並列送信を client が調停する形をやめ、順序と直列化の責務を server 1 点に集約する。復習の正本は `answer_events` 1 表 | 証明: `tests/contract/review-events-bulk.contract.test.ts` / `tests/integration/pg/answer-events-serialization.test.ts`。決定 2026-08-11 | `docs/superpowers/specs/2026-08-11-fsrs-consistency-sprint-a-design.md` / `lib/reviews/ingest-review-events.ts` |
| **pending answer_event の終端は synced(200 受理)か failed(送信前検証の形式不正 / 応答 `failed[]` の衝突)の 2 つだけ。時間ベースの drop は無い** | 「分類は permanent・挙動は無限再送」の不整合と、24h 経過で回答を捨てる silent なデータ喪失を同時に断つ。残る pending が transient のみになるため、再送し続けてよい。既知例外: 契約 drift 由来の 400(pending 残置・トリガー再送で server 修正後に自然回復) | 証明: `lib/sync/review-events.test.ts` / `lib/sync/review-flush.test.ts`。決定 2026-08-11 | 同 spec §3 / `lib/sync/review-events.ts` |
| **競合解決 = server 権威 reconcile-on-pull(cross-device merge なし)** | 実装 = client optimistic + silent catch → 次 pull が server 値で mirror を上書き。cross-device 同時編集は「最後に server apply された field 値が勝ち pull で全端末伝播」。**理由 = 今回明文化**: local-first で複数端末衝突の調停を単純化するため server を唯一の権威に固定する(ローカル FSRS 化を「複数端末衝突を新規に抱える」ゆえ廃案にしたのと同じ判断)。**決定日 = 2026-07-26** | 決定(2026-07-26 明文化)| `lib/sync/optimistic-mutation.ts` |
| **書込経路の非対称(card/tag = outbox / exam・review・settings = 別経路)** | 実装 = 3 系統併存(現物確認済)。**理由 = 理由未確定(2026-07-26 時点)**: 「なぜ exam を outbox に通さないか」を横断決定した記録は無く、各 sprint で個別に決まった。今後 exam を local-first 化する際に要決定 | 決定(理由未確定・2026-07-26)| `lib/sync/` / `app/(app)/app/exams/_actions/` |
| client/server 共有 invariant は pure 関数 1 定義を両側 import(二重実装しない)| drift 防止 | 決定 + lint(harness Domain purity)| `CLAUDE.md`「設計方針(DDD)」 |
| **entity_mutations outbox 行の owner(`user_id`)と flush の実行主体は、編集対象 mirror 行の owner ではなく**常に認証主体**の 1 本。分岐させない** | **前提の訂正(2026-08-12・Sprint B で現物確認)**: 「client mirror の読みは全て owner-scoped だから、UI が編集できる行 = 認証主体の行」という前提は**偽**だった — `tag_categories` / `tag_options` の mirror 読みは **全経路が owner 無スコープ**(2026-08-12 実測: 7 file・11 箇所の `toArray()` 直読 — `get-custom-session-cards` / `tag-crud` / `custom-filter-form` / `option-list` / `category-list` / `inline-card-list` / `exam-card-table`)で、**sign-out purge も無い**(共有ブラウザに他 user のタグ行が残り、UI に出る既存 bug。本 sprint 範囲外・claude.ai todo)。ゆえに「行 owner に帰属させる」案は成立しない: 他 user 名義の outbox 行はその user の session まで **pending として持ち越され**、そこでは server の owner check(`WHERE id AND user_id`)を通過して**実適用される** = 認可境界の迂回。認証主体名義に固定すれば、server 側で update は `'failed'`(30 日隔離・データ不変)、delete は `'applied'` の silent no-op に落ち、**どの account のデータも変わらない**。**spec は凍結ゆえ書き換えず、訂正はここが正記録** | 証明: `lib/sync/optimistic-mutation.test.ts`(「outbox owner は常に認証主体」describe = 別 owner の mirror 行を編集しても認証主体名義になる pin)+ server 側 `lib/tags/apply-tag-mutation.ts` の WHERE(id AND user_id)。決定 2026-08-12 | `lib/sync/entity-mutations.ts`(module 冒頭 comment)/ `docs/superpowers/sessions/2026-08-12-sprint-b-db-cleanup.md` |

## 2. tombstone / 削除伝播

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| tombstones 専用表が削除伝播の唯一信号。時間ベース GC は無い(意図的)| 長期オフライン端末が削除を取りこぼさない(無期限蓄積 + inclusive cursor)| 決定(2026-07-24)| `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md` |
| exam 削除は exam + 配下 card **各々**に tombstone を立てる(client は子を導出しない)| 子 card の他端末 mirror 掃除 | 決定(load-bearing・2026-07-24)| `app/(app)/app/exams/_actions/delete-exam.ts` |
| 正規 UI 削除は tombstone を立てる / script 直 DELETE は立てない | 正規経路のみ伝播保証(script は運用制約 → `docs/ops/scripts-and-seed.md`)| 決定(2026-07-24)| 同上 FF |
| 将来 tombstone GC は「cursor が保持期間より古い端末はフル再 pull」検出とセット必須 | GC 単独導入は削除を永久取りこぼす | 決定(2026-07-24・未実装)| 同上 FF |

### cascade の用語分離(同語で 2 つの別物)

台帳では別語で書く:
- **DB の FK cascade**(server 行削除の correctness): 退会時 Group II(cards/source_documents/tag_options/card_tags)は exams・tag_categories の明示 DELETE に FK cascade で連鎖。**load-bearing に依存**。正本 = `lib/db/schema.ts`(`onDelete: 'cascade'`)。
- **`answer_events` は Group II から外れた(2026-08-11・FSRS 整合 Sprint A)**: `card_id` の FK を撤去し、**dangling(参照先 card が存在しない)を正規状態**とした。理由 = **学習履歴は card ではなく user に帰属する** — card / exam を消しても「いつ何に答えたか」は本人の学習実績として残るべきで、card CASCADE はそれを card の寿命に従属させていた(card 削除で `study_days.distinct_card_count` だけが縮む自己矛盾も同源)。**従来の cascade 設計を意図的に override した唯一の表**。帰結として退会時の実削除は FK に任せられず **Group I(handler 明示 DELETE)へ移動**(§4)。`reviews` は表ごと廃止。証明 = `tests/integration/pg/rls-cascade.test.ts`(card 削除で answer_events が**消えない**ことの反転 pin)。正本 = `docs/superpowers/specs/2026-08-11-fsrs-consistency-sprint-a-design.md` §1.1 / §8。
- **`upload_operations` は `source_documents` と生死を共にする(2026-08-12・Sprint B / migration 0036)**: `source_document_id` を **NOT NULL 化**し、FK を `ON DELETE SET NULL` → **`ON DELETE CASCADE`** へ張り替えた。理由 = SET NULL は NOT NULL 列と両立しない(source doc 削除時に SET NULL が発火して NOT NULL 違反になり、退会・exam 削除ごと失敗しうる)。operation は source doc 無しでは意味を持たない。**帰結として、`source_documents` を単独で DELETE する経路を新設する場合は、その operation 行(idempotency ledger)が黙って消えることを再判断する必要がある** — 「単独削除経路はコード上ゼロ」は**現況であって DB 不変条件ではない**。証明 = iso の削除 3 経路 pin(exam 削除 cascade / 退会 handler の `delete(exams)` / `source_documents` 直 DELETE で operation 行が残らずエラーにもならない)。正本 = `docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md` §5.1。
- **client の cascade purge**(hygiene・tags 系由来): tag option/category 削除時に子 card_tags を Dexie mirror から optimistic purge。正本 = `app/(app)/app/tags/_components/{option-list,category-list}.tsx`。
- **1 行で二層を明示**: **client への削除伝播は FK cascade が担わない(担うのは tombstone)** — cascade で消えた行は SELECT 増分に出ないため(`lib/db/schema.ts` の FK cascade は server 行のみ・`lib/sync/pull.ts` の tombstone bulkDelete が client 伝播)。

## 3. 認証 / RLS(テナント境界)

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| Clerk = source of truth。`users` 表は webhook 同期コピー | 認証境界の一元化 | 証明: `tests/contract/webhook-clerk.contract.test.ts` | `app/api/webhooks/clerk/` |
| 内部 id 解決 = claim-first(JWT `dbUserId`)→ fallback SECURITY DEFINER `app_bootstrap_user_from_clerk`(RLS 迂回)。`getCurrentUser` は request-scoped memoize(load-bearing)| RLS bootstrap 循環回避・60s JWT window 対策 | 証明: `lib/auth/ensure-user.test.ts` + iso `lifecycle-null-contract` | `lib/auth/ensure-user.ts` / `drizzle/migrations/0025_rls_p2_functions.sql` |
| SECURITY DEFINER 3 関数は RLS 迂回が必須な特殊経路のみ。scrub は `p_user_id==app.user_id` 自衛 | context 確立前 / scrub 済行を引く必要 | 証明: `rls-functions.test.ts` | `drizzle/migrations/0025_rls_p2_functions.sql` |
| `withTenantTx` が `app.user_id` GUC を張り policy が読む。未設定 → P0RLS loud raise | 配管ミスを静かな 0 行でなく例外に | 証明: `rls-context` / `rls-per-command` | `lib/db/tenant-tx.ts` / `db/policies/` |
| **RLS = app の WHERE を信頼しない最終境界**(userId は常に auth 由来・client 供給は row ID のみ)| 多層防御の最終段 | 証明: `rls-single-defense.test.ts` | `tests/integration/pg/COVERAGE.md` |
| 非 RLS 5 表は command GRANT のみで防御(行隔離なし)。contact は GDPR DELETE の WHERE 用に SELECT 保持 | 非 tenant / global 表 | 証明: `grant-narrowing.test.ts` | `db/roles/recallmint_app-grants-phase3.sql` |
| proxy は thin(DB 非保持)・`/app(.*)` protect・webhook bypass は callback early-return(matcher lookahead でない)| Node runtime 分担・path-to-regexp 制約(build 時表面化)| 証明: `proxy.test.ts` | `proxy.ts` |
| Route Group 3 層(marketing/auth/app)+ URL 不変保証(RG `(name)` は URL に出ない)| 認証 zone の構造 + URL ベース API の不変 | 決定(構造・現物確認)| `app/(marketing)` / `app/(auth)` / `app/(app)` |

## 4. GDPR 削除契約

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| 退会 = users soft-delete(deleted_at + email/clerk_id scrub・stripe_customer_id 保持)+ Group I 明示 DELETE + assets soft-delete(deleting)| GDPR PII 消去 + audit 相関保持 | 証明: `webhook-clerk.contract` + route invariant + iso GDPR | `lib/clerk/handle-clerk-event.ts` |
| 削除表分類: Group I(handler 明示 DELETE)/ Group II(FK cascade)。**`answer_events` は Group I**(2026-08-11 移動) | 明示 vs cascade の境界(§2 cascade 用語分離参照)。answer_events が Group I なのは、card FK 撤去で cascade 元が無く、users FK の CASCADE も退会が soft-delete なので発火しないため — **明示 DELETE が唯一の消去経路**であり、抜けると PII 相当の学習履歴が残置する | 証明: route invariant test(Group I 集合一致)| `lib/clerk/handle-clerk-event.ts` |
| **匿名 contact_messages(user_id null)は退会 scrub の対象外** | scrub が `WHERE user_id` で引くため構造的に当たらない。非会員からの削除要求は稀であり、手動 1 行 DELETE で適法に対応できると判断(受付窓口はプライバシーポリシーに明記して担保)| 決定 2026-07-22 / 明文化 2026-07-26 | `lib/clerk/handle-clerk-event.ts` |

## 5. レンダリング / Next

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| **ISR / SSG を使わない(`revalidate`/`dynamic`/`generateStaticParams` ゼロ)。認証必須ページは `auth()` 経由で dynamic** | 実装 = 全 dynamic(marketing の静的法務 page は App Router 既定で prerender)。**理由 = 今回明文化**: 認証必須ページを静的化 / ISR 化すると**レンダリング層でユーザー間のキャッシュ漏れ**が起きうる(DB 層で RLS が塞ぐのと同種の漏れが、レンダリング層には無防備で残る)。**決定日 = 2026-07-26**。**機械強制済み**: 認証必須 group(`app/(app)/**`)配下の `revalidate`/`dynamic`/`generateStaticParams` export を lint が fail させる | 証明(lint・決定 2026-07-26): `eslint.config.mjs` Block E1-render | `eslint.config.mjs`(Block E1-render)/ `next.config.ts` |
| nav / dynamic への Link は `prefetch={false}` | prefetch 並列 SSR が server 負荷を増幅 | 決定(記録あり)| `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md` |
| 全 API route は `runtime='nodejs'` / serverActions bodySizeLimit + security headers | pg driver 依存 / upload 上限 app-level 集約 / prod grade header | 決定(各 route + config)| `next.config.ts` / `app/api/**/route.ts` |

## 6. 画像

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| card は assetId を保存(URL 非保存)。表示時に presigned GET を resolve。R2 private + presigned PUT/GET | URL 失効・非公開 bucket | 証明: `lib/media/get-asset.test.ts` / `lib/storage/r2.test.ts` | `lib/storage/r2.ts` / `lib/media/get-asset.ts` |
| GC v2: 状態機械 reserved→ready→deleting→deleted・card_asset_refs 正規化・状態ベース遅延 GC(mark→grace→promote→collect)。語彙 SSoT = pure domain(DB CHECK なし)| 参照ゼロ検出 + grace 猶予・reconciler は deploy 後実行 | 証明: `asset-state.test.ts` / `gc-image-assets.test.ts` | `lib/media/domain/asset-state.ts` / `docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md` |
| **source(OCR 元画像・PDF)の R2 保持は「処理中のみ」。画像は従来どおり R2 非経由(メモリで受領 → 同一 invocation 内で OCR+crop)。PDF は top-level `src/` prefix(`src/{userId}/{uploadSessionId}/{fileId}.pdf`)に client presigned PUT で一時保存(server は source を PUT しない)し、完了通知 reject と、所有権を保持したまま `runUploadPipeline` を抜けた経路すべて — 所有権喪失 5 経路と pipeline 未到達 2 経路を除く — で明示 DELETE、加えて **submit 前の staging 期間は entry 削除(×)に同期した client 発 best-effort DELETE(`delete-pdf-source` action・②-4b §1・削除主体一意化。unmount / DELETE 失敗 / purge 済 session / finalize hang 中の削除は対象外)**、**退会時は `src/{userId}/` の prefix purge(②-4b §2・webhook の外周 `finally`・予算上限付き。listing は snapshot でないため pagination 中 / LIST 後 DELETE 前の PUT は取り漏らす。打ち切り・失敗は台帳 `r2_deletion_src_*` に記録し §3 sweeper / lifecycle が受け皿)**、**これら本線の取り漏らし全部の受け皿として日次 age-based sweeper(②-4b §3・Vercel Cron `0 18 * * *`・`GET /api/cron/sweep`・cutoff 6h)が `src/` を user 横断で回収する(削除は「key 規約一致 かつ age 超過 かつ その user に live upload operation が無い」の三重条件。判定不能・listing 失敗・age 不明はすべて削除しない側に倒す。打ち切り/失敗は台帳 `r2_sweep_*` に記録)**+ lifecycle(`src/` maxAge 1 日・実効 ≈48h)が最終の保険(**2026-08-09 に実削除を 1 例実測 = 効いている。ただし「典型 24h 以内」は無保証のままで、測れたのは age (23.7h, 36.0h] という 1 例の上下界のみ**)。**sweeper の保持時間は正常時 ≈30h / 前提つき worst ≈55h(前提 = cron が毎日発火・対象が listing 上限 10 page 内で走査される・live skip が連続しない)であって hard upper bound ではない。前提が破れた事実は 72h 超残存を検知する overdue alert(`r2_sweep_overdue`)が毎日鳴らして表面化させるが、その観測範囲も listing 上限内の partial observation に限る**。**画像 asset の R2 実体はこの経路に含まれない**(`assets` は退会時 `status='deleting'` に倒すのみで、実体回収は GC lane が担う — 「退会で R2 が消える」は source PDF についてのみ真)。`source_assets` 表は存在しない(台帳なし・key 規約で辿る)** | 著作物の疑い(恒久保持しない)は維持。経緯: 「最小時間のみ保持 + purge」→「そもそも置かない」(2026-08-04 OT・②-4a)→ **PDF 対応で body cap(4.5MB)を原本が越えるため「処理中のみ置く」へ改訂(2026-08-07 OT・②-4b)** | 証明: `lib/media/source-object-key.test.ts`(key builder unit・非 uuid reject)+ `tests/integration/pg/upload-pipeline.test.ts`(出口 DELETE・成功/terminal/raced/lost 各経路)+ `submit-upload.test.ts` / `upload-pipeline.test.ts` の r2 import 許可 pin(server PUT は crop key のみ・画像経路は R2 非 import のまま)+ `delete-pdf-source.test.ts`(所有権 pin・404 冪等)/ `upload-form.test.tsx`(削除主体一意化・purge 2 経路)+ `route.test.ts`(退会 purge: finally 到達保証 / 予算原点 / 20 行上限 / prefix 二重関門)/ `r2.test.ts`(bounded listing)。決定 2026-08-07(OT)/ spec r5 確定 2026-08-08 / §1 staging DELETE 追加 2026-08-09 / §2 退会 purge 追加 2026-08-09 / **§3 sweeper 追加 2026-08-09**(証明追加: `src-sweep.test.ts` = 選定境界・live 除外の直前性・予算打ち切り・台帳 quota / `app/api/cron/sweep/route.test.ts` = auth 先行・空 secret 401・production override 400)| `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md` |
| dedup は据え置き(未実装)。refs は many-to-many で dedup 布石のみ | YAGNI(現状 dedup 分岐なし)| 決定(spec 明示)| 同 image-gc spec |
| **表示側 UI 契約(モーダル/畳み/4 欄ギャラリー)と個別 UI 値の線引き** | 実装 = 表示専用で sync/DB 不変(現物確認済)。**理由 = 理由未確定(2026-07-26 時点)**: どこまでが「契約」でどこからが「個別 UI 値」かの architecture 級の宣言がなく memory/session doc に分散 | 決定(理由未確定・2026-07-26)| memory `project_image_display_ux_sprint` / session doc |

## 7. billing

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| 課金 3 経路(新規 = Checkout / paid のプラン変更 = 自前 in-place `subscriptions.update` / 解約 = Portal)| in-place 追加理由 = 2 本目 subscription 防止 + 期末 downgrade 予約 | 証明: `subscription.test.ts`(+ subscription-changes)| `lib/stripe/subscription.ts` |
| downgrade 予約 = subscription schedule(phase0 現行 + phase1 開放端 target)+ scheduled_* 3 列(真実 source = DB 行)| 期末 downgrade | 証明: `subscription.test.ts` | `lib/stripe/subscription.ts` |
| 予約 clear は Stripe release 成功から decouple(price==target で冪等 clear)・release は best-effort。clear site 複数で webhook 順序非保証を吸収 | orphan 恒久化防止 | 証明: `subscription-changes.test.ts` | `docs/audit/2026-07-10-stripe-downgrade-reservation-clear-bug.md` |
| users 課金列の invariant(`plan=free ⇒ interval=NULL` / `plan∈{standard,pro} ⇒ interval∈{month,year}` / stripeSubscriptionId UNIQUE = 1 user 1 active sub / past_due の二重意味)| webhook 由来 plan/status の一貫性 | 決定(webhook resolve で担保)| `lib/stripe/` |
| 価格 = 2 product × 2 price = 4 price。price_id ↔ (plan,interval) は集中管理 | idiomatic | 決定(数値は Obsidian・書かない)| `lib/stripe/price-mapping.ts` |
| Test Clock 検証ツールが downgrade/予約取消 回帰を証明(手動資産)| 時間依存の実走検証 | 決定(回帰資産)| `scripts/stripe-test-clock-verify.ts` / `docs/ops/stripe-test-clock-verify-runbook.md` |
| Stripe apiVersion を明示 pin しない(SDK exact ゆえ送信版が決定的)| 二重管理回避 | 決定(matrix v2 §6)| `docs/superpowers/sessions/2026-07-25-deps-target-versions-matrix-v2.md` |
| **exam に「アーカイブ」状態は存在しない(`exams.archived_at` を列ごと削除・2026-08-12 / migration 0036)。プラン downgrade 時の自動アーカイブを再実装するなら、`archived` を読む分岐 — とりわけ **アーカイブ済 exam への upload を拒否する gate** — も同時に書き直す必要がある** | 書き手(downgrade 自動アーカイブ)は宣言のみで一度も実装されず、常に NULL を読む dead 分岐だけが 一覧 filter / upload gate / UI / client filter に増え続けていた。列と読み手を同時に消したため、**その gate は今は存在しない**。**gate が消えることを受容した上での削除**(OT 承認・spec §8)であって、gate だけを別途残してはいない | 決定 2026-08-12(OT 承認)| `docs/superpowers/specs/2026-08-12-sprint-b-db-cleanup-design.md` §3.1 / `app/(app)/app/upload/_actions/submit-upload.ts` |

## 8. ドメイン設計(薄い DDD)

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| 薄い DDD: domain=pure / repository・apply=書込 / usecase・action・handler=orchestration / infra=I/O | 不変条件が実在するから(YAGNI と両立)| 決定 + lint(harness Domain purity)| `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` / `CLAUDE.md`「設計方針(DDD)」 |
| client は repository を持たない(pure fn + `runOptimistic*`)| local-first 優先 | 決定 | `CLAUDE.md`「設計方針(DDD)」 |
| **同一の業務不変条件を複数経路で強制する場合、同一の executable contract(schema・純関数・共有定数)を再利用する。表現や信頼境界が異なる場合は別 schema を許容するが、変換後の共通契約を定義し、部分的な再実装で模倣しない** | 契約の部分模倣は列挙漏れが構造的に残り silent drift を生む(本 sprint で 3 回: UUIDv5 判定 / handleImages の refs 射影 / ②-4a prepared card 検証)| 決定 2026-07-31 | 本表 + `docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md` §5.4 |
| **複数行ロックの取得順は `cards`(ID 昇順)→ `study_days`(day 昇順)を規約とする。機械的に強制されているのは復習 ingest 経路のみ(それ以外は人の約束)** | ロック順序を tx ごとに決めると deadlock が出る。復習 ingest は「同一 card の直列化」と「同一 day の cross-card 直列化」の 2 種を同一 tx で取るため、順序を規約として固定した(`publish-prepared.ts` の ID 昇順規律と同型)。**新たに複数行ロックを取る tx はこの順序に従う**が、これを検出する汎用の gate は無い — 挙げている証明は ingest 経路の pin であり、別 tx が逆順でロックしてもそれ自体を捕まえる仕組みはない | 証明(ingest 経路のみ): `app/api/review-events/bulk/route.test.ts`(取得 sequence pin)+ `tests/integration/pg/answer-events-serialization.test.ts`(実 PG 2 接続)。決定 2026-08-11 | `lib/reviews/session-repository.ts` / 同 spec §5 |
| **正誤は 2 本立て — 統計・フィルタ = `is_correct`(選択肢一致)/ scheduling = `rating`(1-4)** | 1 列で兼ねると「正解だが Hard」「不正解だが自己申告 Good」のどちらかを必ず歪める。両方を event に保存し読み手ごとに使い分ける(`rating>=2` を正解の代用にしない)| 証明: `lib/cards/replay-card.test.ts` + iso の study_days 集計 pin(2 定義が発散する event で判別)。決定 2026-08-11 | 同 spec §6 |

## 9. 運用境界

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| app 経路 = `DATABASE_URL_APP`(app role・RLS)/ owner 経路 = `DATABASE_URL_ADMIN`(script 専用)。無印 `DATABASE_URL` 全廃 | 最小権限 / owner 分離(RLS-P1)| 証明: `db-url.test`(接続契約)| `lib/db/index.ts` / `docs/ops/connections-and-env.md` |
| 破壊 script の実効境界 = env 目視 + `--user` scope + dry-run 先行(L2 guard を信用しない)| guard は stg/prod を判別しない | 決定(運用)| `docs/ops/scripts-and-seed.md` |
| OCR = Flash のみ(Pro fallback なし)・429 即 throw・deadline あり | 無料枠運用・CLAUDE.md AI 絶対則 | 証明: `ocr.test.ts` | `lib/ai/ocr.ts` / `CLAUDE.md`「AI API」 |
| テストユーザー / 接続 env 使い分け / script 手順 | 運用手順 | ポインタ | `docs/ops/{test-accounts,connections-and-env,scripts-and-seed}.md` |

---

## 10. 検証失敗の隔離範囲(OCR / upload・②-4a で実装済み)

**原則**: 検証失敗は、影響を受ける**最小の価値単位**まで隔離する。後続処理の安全性を保証できない場合のみ、その親単位を失敗させる。除外・修復した結果は必ず利用者に明示する(loud failure over silent zero-rows =「落とすな」でなく「黙って落とすな」)。

**適用(型か内容かでなく、依存関係とユーザー価値で決める)**:

| 失敗 | 隔離範囲 |
|---|---|
| JSON 不読 / cards 非配列 / 有効 card 0 件 | **upload 失敗** |
| card の question_text / options が壊れている | その **card だけ除外**(他 card は保存) |
| option が 1 つ壊れている | **card 全体を除外**(選択肢欠落は問題の意味と正答確率を変えるため部分救済しない) |
| image が壊れている | その **image だけ除外**(要素ごと safeParse・親 array 検証で card を巻き込まない) |
| tag が壊れている | その **tag だけ除外**(既存挙動) |

型エラーでも image だけ落とす場合があり、内容エラーでも card 全体を落とす場合がある。旧来の「型崩れ=upload 全滅 / 内容不正=個別 skip」という型/内容ベースの分類は粗く、上記の依存関係ベースへ統一済み(②-4a で実装。証明 = `normalize-prepared.test.ts` の隔離 test 群)。除外件数は result page が束で提示(実装 = `_lib/result-summary-view.ts`・producer/reader の束整合は drift pin)。決定: 2026-07-29(OT・②-4 設計事項)。正本 = `docs/superpowers/specs/2026-07-29-ocr-2-3-5-model-and-answer-group-design.md` §10-C/D + `docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md` §13。

---

## 11. R2 削除の 2 レーン契約(②-4b close・2026-08-10)

R2 の object は **`src/`(source PDF)と 画像 asset の 2 レーン**に属する。両者は削除の駆動原理が違う(時間駆動 / 行駆動)ため機構を統一しない。加えて**絶滅した 3 つ目の prefix**(旧 `users/{userId}/src/…`)があり、下表に含めて数える — **現存する key 形はこの 3 つで尽きる**(実測 = `docs/ops/r2-key-inventory.md`・2026-08-10 に bucket 全 listing で確認)。以下はレーンをまたぐ契約で、各レーンの機構詳細は §6 の該当行と正本 spec を見る(ここには how を書かない)。

**共通不変条件(両レーンが守る)**

| 不変条件 | 証明 or 実装 |
|---|---|
| DELETE 失敗を成功扱いしない(台帳に記録し、次 run で再試行) | `src/` = `r2_sweep_*` / `r2_deletion_src_*` / `r2_staging_delete`(catalog 4 軸)・asset = R2 失敗時は行を `deleting` のまま存置 + `r2_gc_delete`(`scripts/gc-image-assets.ts`) |
| R2 I/O を DB tx の成功条件に混ぜない | asset = `R2 DELETE → success-equivalent 確認 → THEN 行 DELETE` の順序が絶対(逆順は object_key を失い永久 orphan)・`src/` = 出口 DELETE は tx 外の `finally` |
| key に userId を含め、退会が prefix purge 可能な形を保つ | `src/{userId}/…`(`source-object-key.ts`)/ asset key も user scope |
| 各レーンが「一次削除 / 二次回収 / backstop / 期限・滞留の検知」の 4 点を持つ(持てない点は明示する) | 下表 |

**レーン表**

| | `src/`(ephemeral・**時間駆動**) | 画像 asset `users/{uid}/{assetId}.{webp,png,jpg}`(長命・**行駆動**) | 旧 `users/{uid}/src/…`(**絶滅**) |
|---|---|---|---|
| 一次削除 | pipeline 出口 `finally` + entry 削除同期 DELETE(§1)+ 退会 prefix purge(§2) | refs ゼロ → mark → grace → promote → collect(reconciler) | **無い**(生成コードを `80ef3b4`・2026-08-05 で削除 = 新規発生しない) |
| 二次回収 | **日次 sweeper**(§3・cron・age 駆動) | **日次 cron `asset_gc` lane**(mark/promote/collect を per-user 実行・asset レーン整合 sprint 2026-08-10)。`scripts/gc-image-assets.ts` は thin CLI wrapper として存続(dry-run 観測・調査・緊急用) | `scripts/gc-src-prefix.ts`(**手動 one-shot**・既定 dry-run・`--execute` 必須) |
| backstop | **lifecycle**(`src/` maxAge 1 日・**2026-08-09 に実削除を 1 例実測**) | **無い(張れない)** — prefix lifecycle は参照中の正当 object を消すため | **無い(張れなかった)** — asset prefix の**内側**にあり、ListObjectsV2 も lifecycle も `users/*/src/` の wildcard を持たないため user ごとに rule が要る。**これが top-level `src/` へ移した理由** |
| 期限・滞留の検知 | overdue alert(72h・`r2_sweep_overdue`。**観測範囲は listing 上限 10 page 内の partial observation**) | **`asset_orphan_scan` lane**(cron・age 駆動・cutoff 7 日)が三重条件(key 規約 + age + live 無し)+ DELETE 直前の行不在確認で row-less orphan を発見・回収。**観測範囲は listing 上限(10 page)内の partial observation**(`src/` overdue alert と同じ限界。上限到達は `r2_orphan_incomplete` phase `list_truncated` で毎日鳴る)。**この行不在確認は唯一の安全弁であり backstop が無い**(final fix wave・2026-08-10 追記): throw は skip に倒れるが無言の 0 行は削除側に倒れる極性で、`asset_gc` の `checkRefsPopulated` に相当する backstop は無い。緩和 = per-run 削除上限(`ORPHAN_MAX_DELETE_PER_RUN`=50)のみ(spec §13) | 無い(**2026-08-10 の全 listing で 0 件**を実測。生成源が無いため増えない) |

**回収レートは soft**: `asset_gc` lane の collect は `COLLECT_LIMIT_PER_USER`(user あたり 20 object/run)で bound される — 「日次で消える」ではなく「日次で最大 20 件ずつ消える」。退会 user の R2 実体削除は ⌈残件数/20⌉ 日かかる(hard SLA ではない)。この上限を外さない理由・具体的な滞留規模の見積りは spec §3.3a / §7 を見る。

**やってはいけない 2 つ**

1. **asset prefix に lifecycle を張らない** — 参照中の正当データを消す(asset は「古い」ことが削除理由にならない)
2. **`src/` を行駆動化しない** — 台帳の再来。②-4b は台帳なしを選んでいる(下記「非要件」)

**非対称の理由(統一しない根拠・v58 原理)**: **記録がある側は遅延してよく、記録がない側は即時性が要る**。asset は `status='deleting'` 行が durable な削除意図として残るため、回収が遅れても意図は失われない。`src/` は台帳を持たないため、削除意図を保持する場所が無く、時間そのものを判定に使う。**判定原理はレーンの性質に従わせ、統一するのは入口(cron runner)と観測(台帳 4 軸・Discord)のみ**。将来この 2 レーンを「一貫性のため」1 機構へ統合する変更は、この非対称の理由を読み落としている — 統合するなら先に `src/` 側へ durable な削除意図の記録を導入する必要がある。

**非要件(②-4b が保証しないもの・確定)**: ②-4b が保証するのは source object の**期限内削除**であり、**削除後の個体履歴・元 filename・content identity の監査保存ではない**。個体追跡を公開要件にする場合は、別 sprint で台帳を導入する。台帳を採らなかった根拠 = ① filename は PII になりうる ② 台帳を作っても object 自体は消えない(削除保証は別機構が要る)③ 期限切れ reserve の回収 lane・RLS・policy・migration が丸ごと増える(親 spec §3 の分岐決定)。**再検討トリガー = 法務・監査・サポート要件の具体化**で、**公開前 gate で再判定する項目**。

**asset レーンの旧未解決事項(②-4b close 時点の 4 件・「asset レーン整合 sprint」2026-08-10 で解消)**: ① reconciler が手動実行のまま → **解決**(日次 cron `asset_gc` lane 化。`scripts/gc-image-assets.ts` は thin wrapper として存続)② 退会由来 asset の grace 30 日の要否未確定 → **解決**(grace は付与しない — cron が日次で走ること自体が回収頻度の答え。退会で直接 `deleting` に倒れた行は従来どおり grace を経ず collect 対象)③ refs↔GC の smoke 未実施 → **iso で恒久 pin 済**(下記「証明の空白」参照。stg 実機 smoke は別途・未実施)④ zero-ref の滞留 → **cron(`asset_gc`)が回収を開始**(ただし上記「回収レートは soft」のとおり無制限ではない)。

正本: `src/` = `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md`(親・凍結)+ §1〜§3 spec / asset の状態機械・GC v2 設計 = `docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md` / asset の cron lane 化(`asset_gc` / `asset_orphan_scan`)= `docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md`(凍結)。close 記録 = `docs/superpowers/sessions/2026-08-10-ocr-2-4b-close.md`。**prefix × 作る/読む/消す の運用表と実 bucket 実測 = `docs/ops/r2-key-inventory.md`**(key 生成経路を増減させたら同時に更新する)。

---

## 証明の空白(証明テストが無い不変条件・取り繕わない)

「壊れたら重い」のに証明 test/lint が弱い / 無いもの:

| 空白 | 重さの所見 |
|---|---|
| **exam+子 card tombstone の end-to-end 多デバイス伝播**(§2)| 重。欠くと子 card が他端末に永久残留。server 側 tombstone INSERT は unit で守るが多デバイス伝播は自動 test の射程外。**手当て = OT の実機 2 端末 smoke(PC で試験作成→削除→モバイルで消失確認)で担保予定**(実端末 2 台の IDB 状態が要るため自動 test 射程外)。背景 = `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md` |
| **cross-device 競合の収束**(§1 A5)| 中。単一 client の optimistic/rollback は unit あり・multi-device 収束 test なし |
| **cascade 依存(Group II)**(§2/§4)| 中。FK を `SET NULL` 等に変えると退会削除が漏れうる。route invariant test は Group I 集合を守るが Group II cascade 経路自体は薄い。**2026-08-11 に `answer_events` が Group II を抜けた**ため空白の射程は cards/source_documents/tag_options/card_tags に縮んだ(answer_events 側は逆に「card 削除で消えないこと」を `rls-cascade.test.ts` が pin する)|
| **同一 card への並走 flush の lost update / 時系列を逆行する event の適用**(§1)| 重。欠くと復習回数と FSRS 状態が黙って失われる(lost update)か、遅着した古い event が最新状態を巻き戻す。どちらも silent で、利用者からは「復習したのに反映されない」としか見えない。**手当て = 2026-08-11「FSRS 整合 Sprint A」で埋めた** — `tests/integration/pg/answer-events-serialization.test.ts` が実 PG・同一 user の 2 接続同時実行で、直列化(`cards.reps` が両方分進む)・順序ガード 5 形・study_days の cross-card 競合を pin し、`cards` / `study_days` の `FOR UPDATE` を**個別に**外す変異で各 pin が単独 red になることを実証済み(**変異注入位置は repo に残らないため再現手順は `docs/superpowers/sessions/2026-08-12-fsrs-consistency-sprint-a.md` §6.2 が唯一の記録**)。**残る空白** = 3 接続以上 / 同時刻 cross-request の適用順(spec §2.4 が明示的に非決定と受容)/ stg 実機での並走 smoke |
| **Dexie の実 IndexedDB upgrade path**(§1)| 重(新規・2026-08-11 / **2026-08-12 に射程が縮んだ**)。失敗すると `getClientDb().open()` が reject し local-first 機能が全停止する(blast radius = 演習・カード編集・pull の全部)。**当初の空白** = 「unit は `fake-indexeddb` で毎回空の DB を新規作成するため、既存 DB に対する upgrade が構造的に走らない」。**手当て(Sprint B・2026-08-12)= 自動 test 新設**(`lib/client-db.upgrade.test.ts` — 素の Dexie で旧 version の DB を組んで close → `new ClientDb()` で再 open し upgrade を実走。store 集合 / index 集合 / 無関係 store のデータ残存を pin)。**残る空白** = ① 実ブラウザの IndexedDB 実装 ② **他タブが旧 version の接続を保持した状態の調停**(Dexie 既定の `versionchange` 自動 close)— どちらも fake-indexeddb では再現しない。**手当て = stg smoke の必須項目**(v8→v10 = `docs/ops/fsrs-sprint-a-stg-migration-runbook.md` §4.1 / v10→v12 = `docs/ops/sprint-b-db-cleanup-runbook.md` §6.2(a)。**後者は v10 の seed を deploy 前に済ませないと恒久的に実施不能**)|
| **webhook 順序非保証の全パターン**(§7)| 中(決済)。clear site 複数で吸収する設計だが全到達順の網羅 test なし(Test Clock 手動 smoke が補完)|
| **破壊 script の機械境界**(§9)| 中(運用)。env 目視 + dry-run の人手境界のみ・機械停止層なし |
| **upload pipeline の「発火しない系」機構の実機発火(予期しない throw の integration_failures 台帳書込 / EXIF≠1 検知)**(§6/§10)| 中。どちらも UI から誘発できない(前者は正常経路に throw が無く、後者は client の canvas 再エンコードが EXIF を剥がす)ため、iso の注入 test(throw 注入 / 実 EXIF JPEG)が唯一の証明。client を経由しない投入経路(②-4b の PDF / API 直叩き)が現れた時に実機発火の確認を足す |
| **実環境(stg/prod)の RLS 状態が repo の enable SQL と一致していること** | 重。判定自体は機械化済(`scripts/verify-rls-state.ts` = app role 専用・read-only・カタログ突合 + 実効検証)だが、**起動が人手**のまま(定期実行なし)。drift test は local 固定ゆえ実環境には届かない。実際に、新表の policy 適用が丸ごと漏れたまま ledger には「適用済み」と記録されていた事例がある(2026-08-04)。**手当て = 新表追加時に runbook §13 の手順で適用+実効検証し、生出力を証跡に残す** |
| **画像 asset の refs↔GC 整合(A/B 2 card が同一 asset を共有する時の mark 判定)**(§11) | 中。片方の card から ref を外しただけでは mark してはならず、両方外れて初めて mark→promote→collect が進むべきだが、既存 unit(`gc-image-assets.test.ts`)は全 DI mock で実 SQL を一度も通していなかった。**手当て = iso で恒久 pin 済**(`tests/integration/pg/asset-gc.test.ts`・2026-08-10「asset レーン整合 sprint」— 片方削除で mark 保留 / 両方削除で mark→promote→collect が実 SQL で完走することを regression として pin)。**残る空白 = 実環境(stg)での実機 smoke は未実施**(OT 指示後に CC が実施予定)。正本 = `docs/superpowers/specs/2026-08-10-asset-lane-gc-design.md` §9 |

## 残余リスク(公開前 PII 判断・記録のみ)

公開前にまとめて判断する PII 関連の設計事実(判断そのものは claude.ai 側 todo が持つ):
- **integration_failures は退会 scrub の対象外**(user 削除で clerkId/stripeCustomerId/context/errorMessage 残置)。
- **contact_messages は app-role が全行 SELECT 可能に留まる**(GDPR `DELETE WHERE user_id` が PG の「WHERE 参照列に SELECT」要求ゆえ table SELECT 保持。列単位 `SELECT(user_id)` 化で解消可)。
- **退会 scrub で null 化する列 vs 保持する Stripe ID 等の妥当性**は公開前にまとめて判断。
- **共有ブラウザで他 user のタグが表示される**(tag mirror の読みが owner 無スコープ + sign-out purge 不在 — §1 の outbox owner 不変条件の行に実測詳細)。書込側は Sprint B の owner 統一で防御済みだが、表示自体は未修正の既存 bug(claude.ai todo)。
