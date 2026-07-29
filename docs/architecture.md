# architecture — 設計不変条件の索引

**本書は索引。正 = 各行のポインタ先**(コード / test / 決定記録)。how は書かない。件数・数値・版番号は書かない(正本を見る)。

「証明」= それを検証するテストのパス。「決定」= 決定日 + 理由(テストで守られないもの)。

素材 = `docs/audit/2026-07-26-h0-part2-architecture-invariants.md`(② 設計不変条件)+ `docs/superpowers/sessions/2026-07-26-h1a-docs-cleanup-and-h1b-handoff.md`(H-1a 抽出)。

**「今回明文化」表記**: ② で「暗黙(実装はそうだが決定記録なし)」と判定した行は、遡って「昔から決めていた」ように書かない。**実装 = 現物確認済 / 理由 = 今回明文化(or 理由未確定)/ 決定日 = 2026-07-26** の形で示す。

---

## 1. sync(local-first)

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| IDB = クライアント正本(mirror)。server 反映は 3 系統(entity_mutations outbox = card/tag / review-events bulk / server action = exam・settings・upload)| local-first・offline 編集 | 証明: sync unit + `tests/contract/*bulk*` | `lib/sync/` / `lib/client-db.ts` |
| pull は id-upsert のみ(`clear()` しない)。mirror 削除の唯一経路 = tombstone bulkDelete | 削除の決定性・部分 pull 安全 | 証明: `lib/sync/pull.test.ts` | `lib/sync/pull.ts` |
| pull = 1 GET・6 stream・cursor は inclusive(`gte`)| 増分整合・取りこぼし防止 | 証明: `tests/contract/pull.contract.test.ts` / `lib/db/pull-delta.test.ts` | `app/api/pull/route.ts` |
| entity-mutation flush = 全 pending 1 bulk POST(上限あり)。多重送信防止 3 重(mutation_id UNIQUE + in-flight set + Web Locks)| transport 単純化・冪等・多タブ安全 | 証明: `tests/contract/entity-mutations-bulk.contract.test.ts` | `lib/sync/entity-mutations.ts` / `app/api/entity-mutations/bulk/route.ts` |
| **競合解決 = server 権威 reconcile-on-pull(cross-device merge なし)** | 実装 = client optimistic + silent catch → 次 pull が server 値で mirror を上書き。cross-device 同時編集は「最後に server apply された field 値が勝ち pull で全端末伝播」。**理由 = 今回明文化**: local-first で複数端末衝突の調停を単純化するため server を唯一の権威に固定する(ローカル FSRS 化を「複数端末衝突を新規に抱える」ゆえ廃案にしたのと同じ判断)。**決定日 = 2026-07-26** | 決定(2026-07-26 明文化)| `lib/sync/optimistic-mutation.ts` |
| **書込経路の非対称(card/tag = outbox / exam・review・settings = 別経路)** | 実装 = 3 系統併存(現物確認済)。**理由 = 理由未確定(2026-07-26 時点)**: 「なぜ exam を outbox に通さないか」を横断決定した記録は無く、各 sprint で個別に決まった。今後 exam を local-first 化する際に要決定 | 決定(理由未確定・2026-07-26)| `lib/sync/` / `app/(app)/app/exams/_actions/` |
| client/server 共有 invariant は pure 関数 1 定義を両側 import(二重実装しない)| drift 防止 | 決定 + lint(harness Domain purity)| `CLAUDE.md`「設計方針(DDD)」 |

## 2. tombstone / 削除伝播

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| tombstones 専用表が削除伝播の唯一信号。時間ベース GC は無い(意図的)| 長期オフライン端末が削除を取りこぼさない(無期限蓄積 + inclusive cursor)| 決定(2026-07-24)| `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md` |
| exam 削除は exam + 配下 card **各々**に tombstone を立てる(client は子を導出しない)| 子 card の他端末 mirror 掃除 | 決定(load-bearing・2026-07-24)| `app/(app)/app/exams/_actions/delete-exam.ts` |
| 正規 UI 削除は tombstone を立てる / script 直 DELETE は立てない | 正規経路のみ伝播保証(script は運用制約 → `docs/ops/scripts-and-seed.md`)| 決定(2026-07-24)| 同上 FF |
| 将来 tombstone GC は「cursor が保持期間より古い端末はフル再 pull」検出とセット必須 | GC 単独導入は削除を永久取りこぼす | 決定(2026-07-24・未実装)| 同上 FF |

### cascade の用語分離(同語で 2 つの別物)

台帳では別語で書く:
- **DB の FK cascade**(server 行削除の correctness): 退会時 Group II(cards/source_documents/reviews/answer_events/tag_options/card_tags)は exams・tag_categories の明示 DELETE に FK cascade で連鎖。**load-bearing に依存**。正本 = `lib/db/schema.ts`(`onDelete: 'cascade'`)。
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
| 削除表分類: Group I(handler 明示 DELETE)/ Group II(FK cascade)| 明示 vs cascade の境界(§2 cascade 用語分離参照)| 証明: route invariant test(Group I 集合一致)| `lib/clerk/handle-clerk-event.ts` |
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

## 8. ドメイン設計(薄い DDD)

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| 薄い DDD: domain=pure / repository・apply=書込 / usecase・action・handler=orchestration / infra=I/O | 不変条件が実在するから(YAGNI と両立)| 決定 + lint(harness Domain purity)| `docs/plans/2026-07-08-full-ddd-intent-and-factfinding.md` / `CLAUDE.md`「設計方針(DDD)」 |
| client は repository を持たない(pure fn + `runOptimistic*`)| local-first 優先 | 決定 | `CLAUDE.md`「設計方針(DDD)」 |

## 9. 運用境界

| 不変条件 / 決定 | 理由 | 証明 or 決定日 | 正本 |
|---|---|---|---|
| app 経路 = `DATABASE_URL_APP`(app role・RLS)/ owner 経路 = `DATABASE_URL_ADMIN`(script 専用)。無印 `DATABASE_URL` 全廃 | 最小権限 / owner 分離(RLS-P1)| 証明: `db-url.test`(接続契約)| `lib/db/index.ts` / `docs/ops/connections-and-env.md` |
| 破壊 script の実効境界 = env 目視 + `--user` scope + dry-run 先行(L2 guard を信用しない)| guard は stg/prod を判別しない | 決定(運用)| `docs/ops/scripts-and-seed.md` |
| OCR = Flash のみ(Pro fallback なし)・429 即 throw・deadline あり | 無料枠運用・CLAUDE.md AI 絶対則 | 証明: `ocr.test.ts` | `lib/ai/ocr.ts` / `CLAUDE.md`「AI API」 |
| テストユーザー / 接続 env 使い分け / script 手順 | 運用手順 | ポインタ | `docs/ops/{test-accounts,connections-and-env,scripts-and-seed}.md` |

---

## 10. 検証失敗の隔離範囲(OCR / upload・②-4 で実装予定の原則)

**原則**: 検証失敗は、影響を受ける**最小の価値単位**まで隔離する。後続処理の安全性を保証できない場合のみ、その親単位を失敗させる。除外・修復した結果は必ず利用者に明示する(loud failure over silent zero-rows =「落とすな」でなく「黙って落とすな」)。

**適用(型か内容かでなく、依存関係とユーザー価値で決める)**:

| 失敗 | 隔離範囲 |
|---|---|
| JSON 不読 / cards 非配列 / 有効 card 0 件 | **upload 失敗** |
| card の question_text / options が壊れている | その **card だけ除外**(他 card は保存) |
| option が 1 つ壊れている | **card 全体を除外**(選択肢欠落は問題の意味と正答確率を変えるため部分救済しない) |
| image が壊れている | その **image だけ除外**(要素ごと safeParse・親 array 検証で card を巻き込まない) |
| tag が壊れている | その **tag だけ除外**(既存挙動) |

型エラーでも image だけ落とす場合があり、内容エラーでも card 全体を落とす場合がある。**現在の「型崩れ=upload 全滅 / 内容不正=個別 skip」という型/内容ベースの分類は粗い**ため、上記の依存関係ベースに統一する(②-4 で実装)。除外件数は利用者に提示(「カード N 件作成 / M 件作成できず / K 件の図版取り込めず」)。決定: 2026-07-29(OT・②-4 設計事項)。正本 = `docs/superpowers/specs/2026-07-29-ocr-2-3-5-model-and-answer-group-design.md` §10-C/D。

---

## 証明の空白(証明テストが無い不変条件・取り繕わない)

「壊れたら重い」のに証明 test/lint が弱い / 無いもの:

| 空白 | 重さの所見 |
|---|---|
| **exam+子 card tombstone の end-to-end 多デバイス伝播**(§2)| 重。欠くと子 card が他端末に永久残留。server 側 tombstone INSERT は unit で守るが多デバイス伝播は自動 test の射程外。**手当て = OT の実機 2 端末 smoke(PC で試験作成→削除→モバイルで消失確認)で担保予定**(実端末 2 台の IDB 状態が要るため自動 test 射程外)。背景 = `docs/audit/2026-07-24-deleted-exam-mobile-residue-factfinding.md` |
| **cross-device 競合の収束**(§1 A5)| 中。単一 client の optimistic/rollback は unit あり・multi-device 収束 test なし |
| **cascade 依存(Group II)**(§2/§4)| 中。FK を `SET NULL` 等に変えると退会削除が漏れうる。route invariant test は Group I 集合を守るが Group II cascade 経路自体は薄い |
| **webhook 順序非保証の全パターン**(§7)| 中(決済)。clear site 複数で吸収する設計だが全到達順の網羅 test なし(Test Clock 手動 smoke が補完)|
| **破壊 script の機械境界**(§9)| 中(運用)。env 目視 + dry-run の人手境界のみ・機械停止層なし |

## 残余リスク(公開前 PII 判断・記録のみ)

todo-v47 §4「公開前 PII バケット」由来の設計事実(移管でなく抜粋):
- **integration_failures は退会 scrub の対象外**(user 削除で clerkId/stripeCustomerId/context/errorMessage 残置)。
- **contact_messages は app-role が全行 SELECT 可能に留まる**(GDPR `DELETE WHERE user_id` が PG の「WHERE 参照列に SELECT」要求ゆえ table SELECT 保持。列単位 `SELECT(user_id)` 化で解消可)。
- **退会 scrub で null 化する列 vs 保持する Stripe ID 等の妥当性**は公開前にまとめて判断。
