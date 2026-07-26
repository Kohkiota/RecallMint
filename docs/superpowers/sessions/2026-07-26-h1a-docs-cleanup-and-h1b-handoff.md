# H-1a docs 整理 実行 + H-1b 申し送り

- **作成日**: 2026-07-26 / 種別: session(実行記録 + 次段ハンドオフ)
- **前段**: H-0 ①②③(`docs/audit/2026-07-26-h0-part{1,2,3}-*.md`)。本 session = H-1a(パスが動く作業 = 削除/新設/移管)。
- **次段**: H-1b(`docs/harness.md` / `docs/architecture.md` の作成)。**本 session の §2〜§4 が H-1b の台帳行 candidate**。
- **本タスクで harness.md / architecture.md は作らない。**

---

## 1. H-1a で動かしたパス(実行結果)

- **削除(git rm)**: `docs/architecture-guide.md`(P1)/ `docs/next-sprints-priority.md`(P2)/ `docs/recallmint-billing-reference.md`(P3)。有効部は本 session §2〜§3 に抽出済(丸コピーせず台帳行粒度)。
- **新設**: `docs/ops/connections-and-env.md` / `docs/ops/scripts-and-seed.md` / `docs/ops/test-accounts.md`(H-0③ §8 の受け皿)。
- **据え置き**: `docs/setup-notes.md`(P4・OT 未承認ゆえ削除せず・§5 に報告)/ `docs/todo-v47-integrated-status.md`(record・§4 の設計不変条件のみ抽出)/ `docs/recallmint-idb-sync-bestpractice-comparison.md`・`docs/recallmint-incremental-pull-steps.md`(P5 不採用・移動せず)。
- **uuid override**: `pnpm-workspace.yaml` にコメント追加(値不変・lockfile 不変)。

---

## 2. architecture-guide.md からの抽出(architecture.md 行 candidate)

削除した `architecture-guide.md` のうち **pivot 後も構造的に有効**な記述(現物で app RG/chrome/proxy 実在を確認済)。vocab 特化 path(words/review/quiz/gemini/fsrs)は抽出しない(消滅済)。

- **Route Group 3 層構造**: `app/(marketing)`(未認証 chrome)/ `app/(auth)`(認証 chrome)/ `app/(app)`(認証必須 `/app(.*)` protect)。**URL 不変保証** = Route Group `(name)` は URL に出ない(`app/(app)/app/page.tsx` → `/app`)。ゆえに URL ベース API(`redirect('/app')` / `router.push` / middleware matcher)は RG 透過で不変。→ 3 dir 実在確認済。
- **chrome 3 layer**: marketing = `MarketingHeader` + `MarketingFooter` / auth = `AuthHeader`(Logo only)/ app = `AppHeader`。→ `components/marketing/{marketing-header,marketing-footer}.tsx` / `components/auth/auth-header.tsx` / `app/(app)/app/_components/app-header.tsx` 実在確認済。
- **proxy 設計判断**: `proxy.ts` は **thin に保ち DB 接続を持たない**(Node runtime だが DB 由来判定 `deletedAt` 等は layout/page で 1 段判定)。webhook endpoint は matcher 通過するが `/app(.*)` 不一致で `auth.protect()` 非適用 + handler 側で署名検証(Svix/Stripe)。→ ② C8 と一致。
- **Redirect 経路マップ(pivot 後も有効な entry のみ)**: signed-in が `(marketing)/page.tsx` → `/app` / `deleted_at` set で `(app)/app/layout.tsx` → `/sign-out-deleted`(zombie net)/ upgrade 既 pro → `/app` / Checkout success `/app?checkout=success` / Portal return `/app/settings` / 削除完了は `window.location.replace('/sign-out-deleted')`(hard navigation で Router Cache bypass)。→ vocab route(`/app/words/*`)の redirect は抽出しない(消滅)。

> 抽出しなかった architecture-guide の内容 = §2(vocab 削除 path)/ §3-4 の words/review/quiz/gemini path 一覧 / §6-8 の Phase 2 template 抽出手順(参照先 3 doc が MISSING)。これらは pivot 前の template 抽出ガイドで現行索引に不適 = 廃止で消える(git 履歴に残る)。**要 OT: Phase 2 nextjs-saas-template 抽出が現目標かは §5 で判断待ち**。

---

## 3. recallmint-billing-reference.md 突合結果 + 抽出(architecture.md 行 candidate)

**P3 突合**: 02-tech-spec §6(課金)と billing-reference を突合した。**§6 に無い実質情報あり** → 全て **設計**内容(architecture.md 行 candidate)ゆえ本 handoff へ抽出(option 2)。billing-reference は削除。

§6 に**無かった**実質情報(② G1/G2 が一部を anchor 済・以下は追補):

- **課金 3 経路**: 新規加入 = Stripe Checkout / paid 在籍のプラン変更 = 自前 `subscriptions.update`(**in-place**)/ 解約 = Customer Portal。in-place 経路を追加した理由 = 「2 本目 subscription 防止」+「期末 downgrade 予約 + 自動 release」。→ **§6 は Checkout/Portal のみ記載・in-place changePlan 経路が欠落**。
- **downgrade 予約 3 列**(② G1/G2 の DB 側詳細): `scheduledDowngradeScheduleId`(subscription_schedule.id)/ `scheduledTargetPriceId`(予約先 price)/ `scheduledChangeEffectiveAt`(UI 表示専用・切替発効日時)。**scheduled 3 列の真実 source = DB 行**(`sub.schedule != null` 単独はブロック条件にしない = Stripe 由来 schedule の混入排除)。→ **§6 に downgrade 予約の記載が一切ない**。
- **users 課金列の invariant**: `plan='free' ⇒ billingInterval=NULL` / `plan IN(standard,pro) ⇒ billingInterval IN(month,year)`(webhook `resolvePlanFromSub` で担保)。`stripeSubscriptionId` UNIQUE = **1 user 1 active sub** invariant。
- **past_due の二重意味**: (a) `plan!=free` = 初回支払失敗の grace(アクセス保持)/ (b) `plan=free` = unpaid/incomplete 由来 downgrade 後。UI は `(plan, status)` 組合せで区別。
- **価格マッピング**: 2 product(Standard/Pro)× 2 price(月/年)= 4 price。env 4 本(`STRIPE_PRICE_{STANDARD,PRO}_{MONTHLY,YEARLY}`)。`lib/stripe/price-mapping.ts` が双方向 map(`resolveFromPriceId` / `priceIdFor`)。→ §6 は price mapping を lib へポインタするのみ・4 price 構成は billing-reference が詳しい。

> **正本推奨(H-1b)**: 上記は architecture.md の billing 行(② G1/G2 の詳細)+ code(`lib/stripe/`)を正本に。具体的価格の数値は書かない(Obsidian 管理・§6 も数値を Obsidian に外出し済)。

---

## 4. todo-v47 §4 公開前 PII バケットからの設計不変条件抽出(architecture.md / harness risk 行 candidate)

todo-v47 は record(触らない)。§4「公開前 PII バケット」に含まれる **設計不変条件**(backlog でなく事実)のみ抽出:

- **integration_failures は退会 scrub の対象外**(user 削除で `clerkId`/`stripeCustomerId`/`context jsonb`/`errorMessage` が残置)= 設計上の PII 残留(② D と関連・公開前判断項目)。
- **contact_messages は app-role が全行 SELECT 可能に留まる**(RLS-P3 hardening で table-level SELECT 保持 = GDPR `DELETE WHERE user_id` が PG の「WHERE 参照列に SELECT」要求ゆえ)。列単位 `SELECT(user_id)` 化で解消可(別トラック)。→ ② C7 と一致。
- **退会 scrub で null 化する列 vs 保持する Stripe ID 等の妥当性**は公開前にまとめて判断(バケット項目)。

> これらは harness/architecture 台帳の「証明の空白 / 残余リスク」行 candidate。**移管でなく抜粋**(backlog 部分は claude.ai 側 todo が正)。

---

## 5. 新たに判明した事項 / 要 OT(H-1b 前に効く)

- **02-tech-spec §6 の削除フローが stale**: §6 は「物理 DELETE = exams/study_days/contact_messages」「保持 = upload_records/ai_usage_users」「`deletion_failures` 記録」と記すが、**現行 `handle-clerk-event.ts` は Group I 11 表を削除**(upload_records/ai_usage_users/user_settings/study_sessions/tombstones/entity_mutations/tag_categories も削除・assets soft-delete)+ **`integration_failures`**(deletion_failures は廃止吸収)。→ ② D1/D2 が正。**§6 は H-1b で architecture.md が supersede する対象**(本 H-1a では §6 を書き換えない = scope 外)。
- **要 OT**: architecture-guide の「Phase 2 nextjs-saas-template 抽出」が現目標か(廃止でこの抽出ガイドが消える。別 repo `Kohkiota/devcontainer-template` へ移す選択肢は OT 判断)。

---

## 6. claude.ai 供給値の repo 現物検証(食い違い記録)

移管に使った claude.ai todo「運用」節の値を repo 現物で検証。**実質的な矛盾(repo が別値を持つ)は無し**。tracked repo に**現物が無く cross-verify 不能**な識別子は下記(食い違いでなく「未検証」):

| 値 | 検証結果 |
|---|---|
| `DATABASE_URL_APP`(recallmint_app・pooler 6543)| **一致**(.env.example L16 / lib/db/index.ts)|
| 無印 `DATABASE_URL` 全廃 | **一致**(grep で参照ゼロ)|
| `DATABASE_URL_ADMIN` inline 供給(常設に置かない)| **一致**(.env.example L21 空値 / getAdminDb fail-fast)|
| script 実行形 `node --env-file=... --conditions=react-server --import tsx` | **一致**(gc/seed procedure doc L16/L14 と exact 一致)|
| seed `--cleanup` は tombstone 立てず | **一致**(2026-07-24 FF)|
| Stripe app key = `rk_test_`(prod `rk_live_`/`sk_live_`)/ TEST_CLOCK = `sk_test_` | **一致**(.env.example L34/36 / stripe client.ts VERCEL_ENV)|
| test clock 固定アカウント `komail9server+clerk_testclock@gmail.com` + reset は課金列のみ | **一致**(stripe-test-clock-verify-runbook L24/L80)|
| stg/prod project ref(`oxmbnzll...` / `wrxruoob...`)| **cross-verify 不能**(tracked repo に不在 = .env.local / Supabase dashboard のみ。識別子ゆえ記載可)|
| test clock users.id(`bb68971d-...`)| **cross-verify 不能・設計上 CC 探索不可**(runbook L23「app-role では CC が自力探索できない」明記。OT/claude.ai 供給)|
| stg emails `+clerk_test` / `+clerk_test1` / `+clerk_test3` | **cross-verify 不能**(runbook は `+clerk_testclock` のみ記載・他は claude.ai 供給)|
| prod email `+001` | **cross-verify 不能**(tracked repo 不在・claude.ai 供給)|
| owner direct port 5432 | **部分一致**(devcontainer test:iso PG は 5432・pg-setup.sh。Supabase owner の 5432 direct は標準慣行・tracked 現物なし)|
| Stripe CLI が `~/.config/stripe/config.toml` の CLI key を使う | **標準 CLI 挙動**(tracked 現物なし・`.devcontainer/README` の `stripe login` と整合)|

→ **実質矛盾ゼロ**。unverifiable な識別子は各 ops doc に「claude.ai 供給・Supabase/Clerk dashboard が正本」と注記して記載。
