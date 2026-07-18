# Architecture Guide (plan00 / nextjs-saas-template)

**最終更新**: 2026-05-07 (Phase 1 I-D で canonical 化、 I-K 構造反映)
**前身**: `docs/superpowers/notes/2026-05-03-template-evaluation-fact.md` (308 行 fact 調査 note、 G-6 close 直後に作成) を Phase 1 I-D で `docs/` 直下に昇格 + 章立て再構成 + I-K 後の最終構造反映

---

## 0. 概要 / 利用シーン

> ★ **重要設計リファレンス（同期サブシステム）**: IDB↔サーバー同期（offline-first / outbox / 増分 pull / 試験詳細 local-first 書込）の設計は以下 2 doc が canonical。同期周りを触る前に必読。
> - [`recallmint-idb-sync-bestpractice-comparison.md`](./recallmint-idb-sync-bestpractice-comparison.md) — 定石との対応表 + 実装状況マトリクス（一次ソース付き設計根拠）
> - [`recallmint-incremental-pull-steps.md`](./recallmint-incremental-pull-steps.md) — 増分 pull step 1-7 + 試験詳細 local-first Stage 1-4 の実装ステップ詳細

本 doc は 2 用途で利用される。

### 用途 1: plan00 自身の architecture self-reference

plan00 開発時に「どの folder が何をやっているか」 「どの path が touch 必須か」 を path indexer として参照。 README §7 (Architecture highlights) は層別 pattern 説明、 本 doc は **path 一覧 + 役割境界** が主軸 (補完関係)。

### 用途 2: Phase 2 (`nextjs-saas-template`) 抽出利用者向け guide

plan00 を base に新規 SaaS を立ち上げる利用者が、 「何を残し、 何を捨て、 何を書換するか」 を path レベルで判断する index。 §2 Touch 必須 / §3 Placeholder 置換 / §4 流用可能 / §6 Setup 手順 を順に読めば、 抽出時の操作が完結する。

---

## 1. アーキテクチャ全体像

### 1.1 Route Group 3 層構造 (Phase 1 I-K で確立)

```
app/
├── (marketing)/                  ← 未認証 chrome
│   ├── layout.tsx                ← MarketingHeader + main + MarketingFooter
│   ├── page.tsx                  ← top hero (Sign in / Sign up CTA)
│   ├── contact/                  ← 認証外 contact form (I-J + I-D で抽出)
│   ├── terms/page.tsx            ← 法務 page (E-4)
│   ├── privacy/page.tsx
│   └── legal/page.tsx
├── (auth)/                       ← 認証 chrome (footer なし)
│   ├── layout.tsx                ← AuthHeader (Logo only) + main center
│   ├── sign-in/[[...rest]]/page.tsx
│   ├── sign-up/[[...rest]]/page.tsx
│   └── sign-out-deleted/page.tsx
├── (app)/                        ← 認証必須 zone (`/app(.*)` middleware protect)
│   └── app/
│       ├── _components/          ← scope 内限定 (route 配下のみ import)
│       ├── layout.tsx            ← AppHeader + main + BFCacheGuard
│       ├── page.tsx (dashboard)
│       ├── error.tsx             ← signed-in zone fallback
│       ├── _actions/revalidate.ts  ← AppPath 型 literal 5 path
│       ├── words/, review/, settings/, upgrade/, quiz/  ← plan00 特化 (Phase 2 で削除候補)
├── api/{me, webhooks/{clerk, stripe}}/route.ts
├── globals.css, global-error.tsx, layout.tsx (root, ClerkProvider)
```

**URL 不変保証**: Route Group `(name)` は URL に出ない。 例 `app/(app)/app/page.tsx` の URL は `/app`、 `app/(marketing)/page.tsx` は `/`。 RG 透過性により URL ベース API (`revalidatePath('/app...')` / `redirect('/app')` / `router.push('/app/...')` / middleware matcher) は完全不変。

### 1.2 chrome 3 layer (Phase 1 I-K で確立)

| layer | header | footer |
|---|---|---|
| marketing | `MarketingHeader` (Logo + Sign in + Sign up button) | `MarketingFooter` (© + Contact / Terms / Privacy / 特商法 横並び) |
| auth | `AuthHeader` (Logo only、 click で `/` 戻り) | なし |
| app | `AppHeader` (5 link onClick revalidate + UserButton) | なし |

Logo は `components/brand/logo.tsx` で marketing / auth 共用 (Phase 2 で image 差し替え 1 箇所で完結)。

### 1.3 components/ 配下 (4 folder + ui primitive)

```
components/
├── ui/             ← shadcn primitive (button / card / input / label / textarea = 5 file)
├── auth/           ← AuthHeader
├── brand/          ← Logo (text、 "RecallMint" hardcode、 2026-05-17 placeholder 撤回)
└── marketing/      ← MarketingHeader / MarketingFooter / ContactForm (I-D)
```

### 1.4 users schema 二段構造化 (Phase 1 F で完了)

`lib/db/schema.ts` で `users.id` (UUID PK) + `clerk_id` (text、 unique、 Clerk connector) を **分離設計**。 全 FK table (5 件) は `users.id` (UUID) 参照に統一。 Auth provider 切替時の影響を Clerk 関連 column のみに局所化。

詳細 (erDiagram + invariant): `README.md §7.6 Users schema 二段構造`。 経緯 (PG FK 自動 switch 不可 / 一時列方式 backfill / 互換性保持型段階移行 / audit table 設計原則 等 7 項目): `docs/superpowers/lessons/2026-04-30-users-schema-decoupling.md`。

### 1.5 proxy (Node 認証)

`proxy.ts` で `clerkMiddleware` + `createRouteMatcher(['/app(.*)'])`。 **URL ベース**で `/app/*` 配下を protect、 RG 構造 (`app/(app)/app/...`) と URL (`/app/...`) は 1:1 対応 (RG 透過)。 詳細: `README.md §3.3`。

**設計判断**: proxy は thin に保ち DB 接続を持たない方針 (旧 middleware の Edge runtime + Neon WebSocket 制約由来の分担、 Next 16 で proxy 化 = Node runtime に切替後も継続)、 DB 由来判定 (`deletedAt` 等) は Node runtime の layout / page で 1 段判定する分担。 webhook endpoint (`/api/webhooks/{clerk,stripe}`) は matcher 通過するが `/app(.*)` 不一致で `auth.protect()` 非適用、 認証 skip しても署名検証 (Svix / Stripe) を handler 側で独自実施で security 担保。

### 1.6 lib/ 配下構成

```
lib/
├── actions/result.ts               ← ActionResult<T> 型のみ
├── auth/{ensure-user, errors, plan-limits}.ts
├── db/{index, schema, streak}.ts
├── validation/{contact, word}.ts
├── ai-usage / clerk / fsrs / gemini / jst / logger / ops / stripe / utils.ts
```

(Sprint A-2: `lib/contact/notifier.ts` 撤去 — Discord 送信 → DB 保存方針、
DB INSERT 実装は Sprint A-3+)

機能別 sub-folder + lib/ root 直下混在、 1 callsite module も単一責任設計の正常 module (over-extraction なし)。 詳細は §4.4 流用可能 lib/ 配下 で path 別判断。

### 1.7 server actions

`app/<route>/actions.ts` pattern、 5 件:
- `app/(app)/app/{review, upgrade, words, settings}/actions.ts` (認証 zone)
- `app/(marketing)/contact/actions.ts` (認証外、 Discord webhook 経由、 I-J)

`lib/actions/result.ts` で `ActionResult<T>` 型を共通化。

### 1.8 Redirect 経路マップ

#### server-side `redirect()` (`next/navigation`)

| 場所 | 遷移先 | 条件 |
|---|---|---|
| `app/(marketing)/page.tsx` | `/app` | サインイン済 (`getCurrentUser() != null` AND `deletedAt == null`) |
| `app/(app)/app/layout.tsx` | `/sign-out-deleted` | `users.deleted_at IS NOT NULL` (zombie net) |
| `app/(app)/app/upgrade/page.tsx` | `/app` | 既に `plan === 'pro'` |
| `app/(app)/app/upgrade/actions.ts` | Stripe Checkout URL (外部) | `createCheckoutSession` 成功 |
| `app/(app)/app/settings/actions.ts` | Stripe Customer Portal URL (外部) | `createBillingPortalSession` 成功 |

#### client-side `router.push`

| 場所 | 遷移先 | 条件 |
|---|---|---|
| `app/(app)/app/words/new/page.tsx` | `/app/words` | `createWord` 成功後 |
| `app/(app)/app/words/[id]/edit-form.tsx` | `/app/words` | `updateWord` / `deleteWord` (単語 soft delete) 成功後 |

#### Clerk redirect prop / SignOutButton

| 場所 | 値 | 用途 |
|---|---|---|
| `app/layout.tsx` | `signInFallbackRedirectUrl="/app"` | Clerk sign-in 成功時、 `redirect_url` クエリなしで `/app` |
| `app/layout.tsx` | `signUpFallbackRedirectUrl="/app"` | 同上 sign-up |
| `app/(auth)/sign-out-deleted/page.tsx` | `<SignOutButton redirectUrl="/">` | zombie net sign-out → `/` |

#### middleware bounce

- `/app(.*)` 未認証 → Clerk `auth.protect()` → `/sign-in?redirect_url=<original>` (中間 page なし)

#### Stripe success/cancel/return URL

| key | 値 |
|---|---|
| `success_url` | `${base}/app?checkout=success` |
| `cancel_url` | `${base}/app/upgrade` |
| `return_url` | `${base}/app/settings` |

#### 削除フロー hard navigation

- `delete-button.tsx` 完了後 `window.location.replace('/sign-out-deleted')` (router.push でなく hard navigation で Router Cache 完全 bypass、 Phase 1 D-4 で確立)

---

## 2. Touch 必須 path (service-specific 削除 / 書換)

新 SaaS で plan00 を base にする場合、 以下は **削除 or 全面書換** が必要。

### 2.1 vocabulary 特化の folder / file (新 SaaS の domain で全削除推奨)

| path | 行数目安 | 内容 |
|---|---|---|
| `app/(app)/app/words/` | 約 290 行 (page.tsx + actions.ts + new/, [id]/...) | 単語 CRUD UI + server action |
| `app/(app)/app/review/` | 約 700 行 (page.tsx + actions.ts + review-session.tsx 382) | 復習 session (Anki 3-queue + FSRS) |
| `app/(app)/app/quiz/` | 1 file (page.tsx) | 問題演習 placeholder |
| `lib/fsrs.ts` | 31 行 | ts-fsrs wrapper |
| `lib/db/streak.ts` | 89 行 | streak 計算 (review 履歴 ベース) |
| `lib/validation/word.ts` | 9 行 | wordSchema |
| `lib/db/schema.ts` 内 table | 一部 | `words` / `reviews` / `ai_examples` / `ai_usage` / `ai_usage_users` table 削除 |

### 2.2 AI 特化 (用途次第で書換 or 削除)

| path | 内容 | 判断 |
|---|---|---|
| `lib/gemini.ts` (207 行) | vocabulary 前提 systemInstruction (line 27-31) | AI 用途あり = systemInstruction 全面書換 / AI 不要 = file 削除 |
| `lib/ai-usage.ts` (132 行) | daily limit 管理 + plan-aware quota | AI 用途あり = 維持 / AI 不要 = file 削除 |
| `app/(app)/app/words/[id]/ai-panel.tsx` (79 行) | AI 例文生成 panel | vocabulary 削除に伴い削除 |

### 2.3 hardcode の touch 必須 (placeholder 化されていない 2 file)

| path | 行数 | 内容 | 判断 |
|---|---|---|---|
| `lib/auth/plan-limits.ts` | 約 50 行 | plan ごとの上限値 (free/pro 各 words / ai_examples 等) | 新 SaaS の料金プラン設計に合わせ書換 |
| `lib/jst.ts` | 11 行 | JST (UTC+9) hardcode | 対象市場が日本以外なら timezone 書換 |

### 2.4 Stripe price ID (env、 code touch 不要)

`STRIPE_PRICE_PRO_MONTHLY` env で参照、 `app/(app)/app/upgrade/actions.ts` 内で `process.env` 経由。 → env 値の書換のみで code touch 不要。

---

## 3. Placeholder 置換 ({{...}} sed 一括置換 system)

`docs/legal-placeholders.md` の sed 置換 system に乗せた **12 placeholder**
(2026-05-17 SERVICE_NAME 撤回後)。 Phase 1 E-4 で構築、 法務 3 page に絞って
本気運用切替時の fill-in 値 (戸籍名 / 連絡先 / 価格 / 制定日等) に使用。 chrome
callsite (Logo / MarketingFooter / top hero) の brand 名は "RecallMint" hardcode。

### 3.1 placeholder 一覧 (12 項目、 詳細は legal-placeholders.md §1)

`{{COMPANY_NAME}}` / `{{OPERATOR_NAME}}` / `{{ADDRESS}}` / `{{PHONE}}` / `{{EMAIL}}` / `{{DOMAIN}}` / `{{PRICE}}` / `{{JURISDICTION}}` / `{{LAST_UPDATED}}` / `{{LAUNCH_DATE}}` / `{{DISCLOSURE_FEE}}` / `{{BUSINESS_HOURS}}`

### 3.2 sed 対象 file (法務 3 page、 SERVICE_NAME 撤回後の縮減)

- `app/(marketing)/terms/page.tsx`
- `app/(marketing)/privacy/page.tsx`
- `app/(marketing)/legal/page.tsx`

(chrome / footer / logo / top hero は brand 名 hardcode のため sed 対象外)

### 3.3 sed 一括置換 (legal-placeholders.md §2.2、 12 placeholder × 3 file = 1 発で完結)

```bash
# values 準備 → export L_COMPANY_NAME='<実名>' 等 (詳細は legal-placeholders.md §2.1)
FILES="app/\(marketing\)/terms/page.tsx app/\(marketing\)/privacy/page.tsx app/\(marketing\)/legal/page.tsx"
sed -i.bak "s|{{COMPANY_NAME}}|${L_COMPANY_NAME}|g" $FILES
# ... 12 placeholder 全部
```

### 3.4 dry run (置換漏れ検出)

```bash
grep -rn '{{[A-Z_]*}}' app/\(marketing\)/
# 出力 0 件 = 全置換成功
```

→ **sed 1 発で法務 3 page 全部の personal value 差し替え完了**。 chrome 系の
brand 表示は別系統 (hardcode) のため本手順とは独立。

---

## 4. 流用可能 path (touch 不要 or 軽微)

新 SaaS でほぼそのまま流用、 設定書換 (env or 1-2 行) で動く。

### 4.1 認証 (Clerk)

| path | 内容 | 判断 |
|---|---|---|
| `lib/clerk.ts` | env validation (`pk_test_` / `sk_test_` prefix、 production は live 系) | env のみ書換、 code touch 不要 |
| `lib/auth/ensure-user.ts` | `getCurrentUser()` (G-5-1 React.cache wrap、 webhook-synced architecture) | 完全流用 |
| `lib/auth/errors.ts` | `UnauthenticatedError` 型 | 完全流用 |
| `app/(auth)/sign-in/[[...rest]]/page.tsx` / `sign-up/[[...rest]]/page.tsx` | Clerk SignIn / SignUp primitive | 完全流用 (ただし Logo placeholder 経由で SaaS 名は §3 で置換) |
| `app/(auth)/sign-out-deleted/page.tsx` | 削除完了 terminal page | 完全流用 |
| `proxy.ts` | Clerk middleware + CSP default + `/app(.*)` protect | 完全流用 (protect path だけ書換可能) |
| `app/api/webhooks/clerk/route.ts` | Clerk webhook idempotency + user sync | 完全流用 |

### 4.2 課金 (Stripe)

| path | 内容 | 判断 |
|---|---|---|
| `lib/stripe.ts` | env validation (VERCEL_ENV-aware: prod = `*_live_*` / それ以外 = `*_test_*`) + Stripe client | env のみ書換 |
| `app/(app)/app/upgrade/` | Stripe Checkout flow (page + actions) | 完全流用 (price ID env 書換のみ) |
| `app/api/webhooks/stripe/route.ts` | Stripe webhook idempotency + subscription 状態同期 | 完全流用 |
| `app/(app)/app/settings/` (一部) | Stripe Customer Portal session 生成 + 解約予約 UI | 完全流用 (削除 flow 部分は §4.3) |

### 4.3 削除フロー (D 系列で完成)

| path | 内容 | 判断 |
|---|---|---|
| `app/(app)/app/settings/delete-button.tsx` | 4 phase state + Clerk SDK self-delete + polling + Modal | 完全流用 |
| `app/(app)/app/settings/actions.ts` | Stripe subscription auto-cancel + DB soft-delete | 完全流用 |
| `app/api/me/deletion-status/route.ts` | polling endpoint | 完全流用 |
| `app/(app)/app/_components/bfcache-guard.tsx` | BFCache zombie state 回避 | 完全流用 |
| `app/(auth)/sign-out-deleted/page.tsx` | terminal page | 完全流用 |

**設計原則**: Webhook 駆動 + Stripe/Clerk を真実、 アプリ DB はコピー pattern (業界ベストプラクティス整合)。 順序保証なし event 配信 + handler 冪等性確保 (`stripe_events` / `clerk_events` event_id PK + ON CONFLICT DO NOTHING)、 Stripe sub auto-pagination + `status: "all"` で 100 件上限と「active iterate 中 cancel で resource_missing」 落とし穴を回避。

詳細 pattern: lessons の `2026-04-26-clerk-nextjs-webhook-architecture.md` (Webhook source of truth + cached JWT 60 秒 fallback + `getCurrentUser()` 簡略化 + Stripe sub auto-pagination) / `2026-04-29-vercel-domain-confusion.md` (Vercel auto-generated short URL の取り違い防止) 等。

### 4.4 lib/ 配下 (基盤 module)

| path | 行数 | 内容 | 判断 |
|---|---|---|---|
| `lib/db/index.ts` | 約 30 行 | Neon serverless lazy singleton | 完全流用 |
| `lib/db/schema.ts` 内 users / stripe_events / clerk_events / deletion_failures table | (該当部分) | template 必須 4 table | 完全流用 (vocabulary 系 5 table 削除後の残存) |
| `lib/ops.ts` (107 行) | notifyOps / notifyWebhookError (Sentry-swap-ready) | 完全流用 |
| `lib/logger.ts` (79 行) | structured JSON logger (G-6、 Sentry-swap-ready) | 完全流用 |
| ~~`lib/contact/notifier.ts`~~ | ~~Notifier interface + DiscordNotifier~~ | **Sprint A-2 で撤去** (Discord 送信 → DB 保存方針) |
| `lib/validation/contact.ts` | contact zod schema | 完全流用 (form 仕様変更ない限り) |
| `lib/actions/result.ts` | ActionResult<T> 型 | 完全流用 |
| `lib/utils.ts` | `cn` 関数 (Tailwind className merge) | 完全流用 |

### 4.5 chrome (Phase 1 I-K で確立)

| path | 内容 | 判断 |
|---|---|---|
| `components/marketing/marketing-header.tsx` | Logo + Sign in/up button | 完全流用 (Logo は brand/ で差し替え) |
| `components/marketing/marketing-footer.tsx` | © + 4 link 横並び | 完全流用 (brand 名は "RecallMint" hardcode、 別 SaaS では直接書換) |
| `components/auth/auth-header.tsx` | Logo only | 完全流用 |
| `components/brand/logo.tsx` | text logo ("RecallMint" hardcode、 2026-05-17 placeholder 撤回) | image / svg 差し替え時に touch |
| `app/(marketing)/layout.tsx` / `app/(auth)/layout.tsx` | 各 RG layout | 完全流用 |
| `app/(app)/app/_components/app-header.tsx` | AppHeader (5 link onClick revalidate) | link list / label の SaaS 別 customize |
| `app/(app)/app/layout.tsx` | AppLayout (BFCacheGuard + main wrap) | 完全流用 |

### 4.6 法務 page 雛形 (E-4 + I-K placeholder 拡張済)

| path | 内容 | 判断 |
|---|---|---|
| `app/(marketing)/{terms, privacy, legal}/page.tsx` | 利用規約 / プライバシーポリシー / 特商法 各 page | placeholder 12 種を sed 置換するのみで完成 (SERVICE_NAME は hardcode 化済) |
| `docs/legal-placeholders.md` | 12 placeholder mapping + sed 一括手順 + 切替チェックリスト | 完全流用 |

### 4.7 contact form (I-J + I-D で抽出済)

| path | 内容 | 判断 |
|---|---|---|
| `app/(marketing)/contact/page.tsx` | server component (metadata + `<ContactForm />` render) | 完全流用 |
| `components/marketing/contact-form.tsx` | form 本体 (client、 zod + honeypot) | 完全流用 (form UI は無変更) |
| `app/(marketing)/contact/actions.ts` | server action (Sprint A-2: validation-only stub、 DB INSERT は Sprint A-3+) | 縮退 (notifier-factory は Sprint A-2 で撤去) |

---

## 5. 環境依存 (env / domain / dashboard URL)

### 5.1 env 一覧 (`.env.example` source of truth、 README §5 の table も参照)

| env | 用途 | 取得元 |
|---|---|---|
| `DATABASE_URL_APP` | Supabase connection (app runtime・least-privilege `recallmint_app` role・Transaction pooler) | Supabase Dashboard |
| `DATABASE_URL_ADMIN` | Supabase connection (owner・migration/operator script 用。常設 env に置かず実行時 inline 供給。RLS-P1) | Supabase Dashboard |
| `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk credentials | Clerk Dashboard |
| `CLERK_WEBHOOK_SECRET` | Clerk webhook verify | Clerk Dashboard (deploy 後) |
| `STRIPE_SECRET_KEY` | Stripe credentials | Stripe Dashboard |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verify | Stripe CLI (local) / Stripe Dashboard (production) |
| `STRIPE_PRICE_PRO_MONTHLY` | Stripe Price object | Stripe Dashboard |
| `OPS_DISCORD_WEBHOOK_URL` | アプリのエラー通知 (lib/ops.ts notifyOps) | Discord channel webhook |
| `CLAUDE_CODE_DISCORD_WEBHOOK_URL` | Claude Code Stop hook 通知 (.claude/hooks/discord-notify.py、 OPS と別 channel) | Discord channel webhook |
| `GEMINI_API_KEY` | Gemini API (AI 機能あり時) | Google AI Studio |
| `GEMINI_DAILY_LIMIT` | AI daily limit (default 1000) | (env) |

### 5.2 production domain refs

| 場所 | 値 (plan00 default) | 判断 |
|---|---|---|
| `README.md:12` | `https://<your-production-domain>` | 新 SaaS 立ち上げ時に書換 |
| `docs/legal-placeholders.md` (`{{DOMAIN}}` placeholder) | `<your-vercel-app>.vercel.app` (default value) | sed 置換で実 domain に |

### 5.3 Vercel + Clerk + Stripe production 切替 lessons

- Clerk production instance (Secondary application + 5 個 DNS records): `docs/superpowers/lessons/2026-04-30-clerk-production-domain-setup-pitfalls.md`
- Clerk env validation (`VERCEL_ENV` 環境依存): `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md`
- Vercel domain confusion (本番 domain 取り違い): `docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md`

---

## 6. Setup 手順 (template 抽出後の利用者向け)

### Step 0: scaffold + 立ち上げ修正

`pnpm create next-app` 直後、 `docs/setup-notes.md` の 3 点 (bufferutil / watchOptions / .gitignore 追加) を必ず実施 (scaffold default のままでは dev server 無限ループ / Neon 接続失敗が起きる)。

### Step 1: env 整備

`.env.example` を `.env.local` に copy、 §5.1 の env を Dashboard 経由で取得 + 設定。 production deploy 後に Clerk webhook secret / Stripe webhook secret を追加。

### Step 2: placeholder 置換 (sed 1 発)

`docs/legal-placeholders.md §2` の手順で 12 placeholder を実値に sed 置換 (SERVICE_NAME は hardcode 済)。 §3.4 dry run で残置 0 件確認。

### Step 3: service-specific 部分の削除 / 書換

§2.1 (vocabulary 特化 folder 削除) + §2.2 (AI 用途次第) + §2.3 (plan limits / timezone)。 schema (`lib/db/schema.ts`) から vocabulary 系 5 table 削除、 migration 再生成。

### Step 4: AI 用途差し替え (該当時)

`lib/gemini.ts:27-31` systemInstruction を新 domain 用に書換、 もしくは `lib/gemini.ts` + `lib/ai-usage.ts` 削除 + `lib/auth/plan-limits.ts` から AI 関連 quota 削除。

### Step 5: deploy

Vercel + Clerk + Stripe の production 切替は §5.3 lessons 参照。 順序: Vercel deploy → Clerk production instance + DNS records → Stripe live 切替 → webhook secret 追加 → smoke (sign-up / Pro upgrade / 削除 flow / contact form)。

詳細: `README.md §6 Deployment`、 `docs/superpowers/lessons/2026-04-30-clerk-production-domain-setup-pitfalls.md`。

---

## 7. 既知の制約

### 7.1 shadcn primitive は部分採用 (`components/ui/` 整備済、 5 file)

`components/ui/{button, card, input, label, textarea}.tsx` 配備済、 `<button>` 直書きは **0 件** (全 page で `<Button>` shadcn primitive 流用)。 残 primitive (Dialog / DropdownMenu / Form / Tooltip 等) は **Phase 2 で必要に応じ追加**、 plan00 では現状 5 primitive で充足。

### 7.2 plan00 特化部分の集中 (Phase 2 で削除)

`app/(app)/app/{words, review, quiz}/` + `lib/{fsrs, gemini, ai-usage}.ts` + `lib/db/streak.ts` + `lib/validation/word.ts` に集中。 §2.1 で削除手順 path 一覧、 schema 削除 (vocabulary 系 5 table) も含む。

### 7.3 JST + plan-limits の 2 file hardcode (新 SaaS で touch 必須)

`lib/jst.ts` (11 行、 UTC+9 hardcode) + `lib/auth/plan-limits.ts` (約 50 行、 free/pro 上限値)。 §2.3 で touch 必須化済。

### 7.4 review-session.tsx (382 行) / delete-button.tsx (170 行) の split は Phase 2 範囲

- `review-session.tsx`: Anki 3-queue reducer + selectCurrent + UI 統合 (I-1.8a で意図的 1 unit)、 split は機能境界の再判断伴う、 Phase 2 で「FSRS 削除 → template skeleton」 として再設計するか vocab specific 削除かが決まってから
- `delete-button.tsx`: 削除 flow 全体 1 component (4 phase state + polling + modal + button × 5)、 Phase 2 で template 抽出時に modal 抽出 + reuse 可能性検討

### 7.5 N-baseline 6 件 (Phase 1 G で skip 確定、 Phase 2 後検討)

DB Pool config / client polling fetch timeout / loading.tsx / vercel.json route cache header / PWA 実装 / next.config.ts images。 詳細 + 着手手順: `docs/superpowers/research/2026-05-02-baseline-engineering-audit.md`。

---

## 8. References

### 8.1 plan00 内 doc

- `README.md` 10 章 (§1 Production / §3 Quick start / §5 Env vars / §6 Deployment / §7 Architecture highlights / §10 References)
- `docs/legal-placeholders.md` (placeholder mapping + sed 一括手順 + 切替チェックリスト)
- `docs/setup-notes.md` (scaffold 直後 3 点修正)
- `docs/TODO.md` (Phase 1 / Phase 2 sprint 順序、 決着済 record、 スキップ判断、 技術負債)
- `CLAUDE.md` (project root、 Stripe / Clerk / AI 絶対ルール、 Plan / Review / Commit 規約)

### 8.2 superpowers/ 配下

- **specs/** (19 file): 各 sprint の確定方針、 直近 = `2026-05-06-phase1-i-k-marketing-auth-app-route-groups.md`
- **plans/** (18 file): 実装手順、 直近 = `2026-05-06-phase1-i-k-marketing-auth-app-route-groups.md`
- **lessons/** (12 file): 長期 知見、 詳細索引は `README.md §References`。 直近 = `2026-05-08-pnpm-overrides-rationale.md` / `2026-05-08-clerk-auto-csp-overwrites-next-config.md` (Phase 2 整備 sprint で追加)
- **notes/** (12 file → 11 file = 本 doc を docs/ 直下に昇格): 一時調査 / 状況記録
- **sessions/** (6 file): sprint クローズ session log、 直近 = `2026-05-06-phase1-i-k-close.md`
- **research/** (3 file): 大規模 audit 結果、 例 = `2026-05-01-phase-1-completion-audit.md`

### 8.3 Phase 2 関連

- `docs/TODO.md §Phase 2`: 6 ブロック (Clerk / Stripe / DB / 削除 flow / 法務 page / Discord notify) + lessons 蒸溜 list (12 項目) + template 化先判断
- 候補先 repo: `github.com/<your-github-handle>/devcontainer-template` (環境)、 新規 `nextjs-saas-template` (app skeleton、 Phase 2 着手時に作成判断)

---

(end of architecture-guide)
