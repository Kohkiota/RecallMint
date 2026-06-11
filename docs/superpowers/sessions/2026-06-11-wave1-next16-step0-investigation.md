# 波1 (Next 16 核) Step 0 調査レポート

date: 2026-06-11
scope: 調査のみ (実装・commit なし)。 波1 spec を書く前に「何が壊れるか」 を実測棚卸し。
正本: 依存マトリクス v1.3 (`docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md`) §3.1 / §4 / §5
予備: Next 15 → 16 調査 (`docs/superpowers/sessions/2026-06-10-next16-react-upgrade-investigation.md`)

---

## 0. TL;DR

- **codemod は自動コード変換ゼロで終わる**。 `package.json` + `pnpm-lock.yaml` 2 ファイルのみ。 middleware.ts は 0 行も触られず (= `export default clerkMiddleware(...)` は codemod の検出対象外、 手動 rename 必須)。 next.config.ts の webpack block も触られず (Turbopack 互換確認は手作業)。
- **真の手動対応は 5 件**: ①middleware.ts → proxy.ts rename + コメント書換、 ②next.config.ts webpack→turbopack 互換評価、 ③`pnpm.overrides` clobber 問題の解決 (codemod が `pnpm-workspace.yaml overrides` を実効的に消す)、 ④prod CVE 曝露への対応 (現 prod = next 15.5.15 で **13 件中 12 件が未 patch <15.5.16**、 1 件は <15.5.18、 うち high 7 / moderate 4 / low 2)、 ⑤未使用 dep `pg` + `@types/pg` の扱い決め (drizzle-orm/postgres-js 単独使用、 `import 'pg'` 0 件)。
- **red flag 筆頭**: prod 13 CVE 曝露 (約 25 日間)。 Next 16 化 = 単なる「version 上げ」 ではなく **セキュリティ patch 適用**。 rotate 対象 secret 順位は本文 §3 で提案。
- **次の判断材料**: middleware → proxy 化 path (Node runtime 固定)、 `pnpm.overrides` の整合方針 (workspace.yaml に寄せるか / package.json に寄せるか)、 prod rotate 対象。

---

## 1. codemod dry-run の結果

### 1.1 実行

- 調査用 branch `investigation/wave1-codemod-dry-run` を develop から切って `npx @next/codemod@canary upgrade latest` を実行 (実態は @next/codemod@16.3.0-canary.48 を npx 経由 install して走らせる)。
- 終了後、 全変更を `git checkout -- .` で戻し、 branch を `git branch -D` で削除。 develop 上の `git status` は再度 clean。

### 1.2 自動選択された codemod 3 件

```
◉ (v16.0.0-canary.11) remove-experimental-ppr
◉ (v16.0.0-canary.10) remove-unstable-prefix
◉ (v15.6.0-canary.54) middleware-to-proxy
```

各 codemod は jscodeshift で 326 file 走査、 **全て `0 ok / 326 unmodified`** (= ソースコード 1 行も変更されず終了)。

理由:
- `remove-experimental-ppr`: route segment config の `experimental_ppr` を grep → **0 件**
- `remove-unstable-prefix`: 安定化済 experimental prefix → **0 件** (RecallMint の next.config.ts に `experimental` section 不在)
- `middleware-to-proxy`: 期待していた挙動は `export const middleware = ...` / `export function middleware()` / `next/server` から `NextMiddleware` 型 import を rename。 RecallMint の middleware.ts は `export default clerkMiddleware(...)` (匿名 default export of call-result)。 jscodeshift で静的検出できず素通り。

→ **middleware.ts → proxy.ts への rename は手作業必須** (codemod は当てにできない)。

### 1.3 自動変換された file 一覧と diff 要約

#### 1.3.1 `package.json`

```
- "next": "^15.5.15",         → "next": "16.2.9",         (exact)
- "react": "^19.2.5",         → "react": "19.2.7",        (exact, ^ 外れ)
- "react-dom": "^19.2.5",     → "react-dom": "19.2.7",    (exact)
- "@types/react": "^19.2.14", → "@types/react": "19.2.17", (exact)
- "@types/react-dom": "^19.2.3" → "@types/react-dom": "19.2.3", (exact)
- "eslint-config-next": "16.2.4" → "16.2.9"
+ "pnpm": { "overrides": { "@types/react": "19.2.17", "@types/react-dom": "19.2.3" } }   ← 新規追加
```

- 5 つの version pin が `^` を失い exact 化 → 後続の patch 自動追随が止まる (= 上げ運用は明示に変わる)。
- **新規追加された `pnpm.overrides` block が問題**: 後述 §1.5。

#### 1.3.2 `pnpm-lock.yaml` (`+872 / -860` 行)

主要 resolve 変化:
- `next@15.5.15(...)` → `next@16.2.9(...)`
- `react@19.2.5` → `react@19.2.7`、 `react-dom@19.2.5(...)` → `react-dom@19.2.7(...)`
- `eslint-config-next@16.2.4` → `16.2.9` (transitive `@next/eslint-plugin-next` も 16.2.9 に追従)
- `@clerk/nextjs@7.2.9` の peer 解決が次の括弧内で `next@15.5.15` → `next@16.2.9` に置換 (Clerk 自身は 7.2.9 のまま、 peer 互換 OK)
- `radix-ui@1.4.3` / `@dnd-kit/*` / `lucide-react` 等の peer 解決も react@19.2.7 へ追随
- 直接 dep の他項目 (stripe / svix / drizzle-orm / postgres / dexie / svix / 等) は **変更なし** (= codemod は Next/React チェーンのみ触る)

#### 1.3.3 `middleware.ts` / `next.config.ts` / その他のソース

- **0 byte 変更**。 codemod 出力ログ通り。

### 1.4 自動変換不可で「手動対応要」 と報告された項目

codemod は明示的な warning を出さない (jscodeshift は「unmodified」 と言うだけ)。 ただし**実態として codemod の sweep 範囲を超えており、 手作業が必要**な項目:

| # | 手動対応 | 難度 | 根拠 |
|---|---|---|---|
| M-1 | `middleware.ts` → `proxy.ts` への file rename + 関数 export 形の見直し | 中 | codemod は `export default clerkMiddleware(...)` を検出しない (jscodeshift 検出パターンは `export function middleware()` / `export const middleware = ...` / `NextMiddleware` 型のみ)。 file system level の rename + 内部コメント書換 (`Edge runtime` → `Node runtime`) が必要 |
| M-2 | `next.config.ts` の webpack block を Turbopack 互換に倒すか `--webpack` opt-out で残すか判断 | 低 | 現状は dev watchOptions の ignored array のみ (`**/node_modules/**` 等)。 Turbopack 互換 `turbopack` config への翻訳または「dev 起動時 watch 余分起こる代わりに何もしない」 で十分 (このパスは性能気にしない場所) |
| M-3 | `pnpm-workspace.yaml` overrides と codemod 追加の `package.json` `pnpm.overrides` の重複/上書き整合 | **高** | lock 確認で `pnpm-workspace.yaml` の `uuid` / `postcss` overrides が effective に消失。 §1.5 参照 |
| M-4 | `lib/clerk.ts` のコメント (`Edge runtime` 言及) の文言更新 | 低 | side-effect import を `proxy.ts` (Node) と `lib/auth/ensure-user.ts` (Node) の 2 経路に整理 (現状 comment は「Edge と Node の dual-runtime fail-fast」 を謳う) |
| M-5 | `package.json` の `pg` / `@types/pg` 扱い決め (§4 #3 で詳細) | 低 | runtime 未使用 dead weight。 削除 or devDep 降格、 OT 判断 |

### 1.5 `pnpm.overrides` clobber 問題 (red flag 中)

**症状**: codemod が `package.json` に `pnpm.overrides` block を追加 → `pnpm install` 時に **pnpm-workspace.yaml の overrides が無視され、 lockfile の effective overrides が package.json 側に置換される**。

実測 diff:

```yaml
# pnpm-lock.yaml の overrides セクション (HEAD と codemod 後の比較)
 overrides:
-  uuid: ^14.0.0          ← workspace.yaml で pin、 lock 上で消える
-  postcss: ^8.5.10       ← 同上
+  '@types/react': 19.2.17    ← package.json 経由で新規 in
+  '@types/react-dom': 19.2.3
```

`pnpm-workspace.yaml` は disk 上 untouched で `uuid: ^14.0.0` / `postcss: ^8.5.10` を保持しているが、 `package.json` `pnpm.overrides` が存在すると pnpm はそちらを priority 高に扱う (pnpm 10.33.0 挙動)。

**選択肢**:
- (A) **codemod 追加 block を `pnpm-workspace.yaml` に統合**して package.json から削除。 1 ソース化、 後続変更は workspace.yaml だけ見れば良い。
- (B) `pnpm-workspace.yaml` の `uuid` / `postcss` を `package.json.pnpm.overrides` に移して workspace.yaml から overrides セクションを削除。 codemod 流に寄せる。
- (C) 両方残して挙動を再確認 (= pnpm doc 上 priority がどう merge されるかを実測)。 lock を git diff で確認しながら installs。

推奨 **(A)**: RecallMint は単一 package (mono-repo ではない) なので workspace.yaml に集約が一貫。 codemod 追加分 2 行を workspace.yaml へ移植、 package.json `pnpm.overrides` block は削除。

### 1.6 codemod が触らないが Next 16 breaking に該当する箇所の grep 棚卸し

| # | 観点 | grep 結果 | 影響 |
|---|---|---|---|
| G-1 | 同期 `cookies()` / `headers()` 残存 (Next 15 から async 化) | `next/headers` import **0 件**。 `cookies()` / `headers()` 直接呼出 **0 件**。 `next.config.ts` 内 `async headers()` のみ (= config callback、 別物) | なし |
| G-2 | `revalidateTag` 単引数 (Next 16 で署名変更可能性) | `revalidateTag(` 呼出 **0 件**。 `revalidatePath` のみ (`create-exam.ts:37`, `delete-exam.ts:34`, `process.ts:129-130` の 4 callsite) | なし |
| G-3 | `legacyBehavior` (`<Link legacyBehavior>` ) | **0 件** | なし |
| G-4 | `next/image` 利用箇所 (Next 16 default 変更影響) | `import` **0 件**、 `<Image>` JSX **0 件**、 `next-env.d.ts` の type reference 1 行のみ。 `upload-form.tsx:638` に TODO コメント (波1 で `next/image` 化予定) | **影響なし** (現状未利用)。 波1 spec 内で `next/image` 化を**含めない方が安全** (Next 16 default 変更と機能追加が混ざる) |
| G-5 | カスタム webpack config (Turbopack default 化影響) | `next.config.ts:25-36` に `webpack: (config, { dev }) => { ... watchOptions: ignored: [...] }` の 1 block | **中影響**。 dev 限定の watch ignored を Turbopack に翻訳する公式 path は次のいずれか: (a) `turbopack: { ... }` config に置換、 (b) Next 16 default で Turbopack に切替時に該当 watch 設定不要なら削除、 (c) `--webpack` flag で dev も webpack 継続。 設定 1 block (5 path) のみで影響軽微なので、 **削除して Turbopack default に倒す**のが最短 |
| G-6 | `next/server` から `NextMiddleware` / `MiddlewareConfig` type import (codemod がこの型 import を再 name するロジック) | `from 'next/server'` import **0 件** | なし |
| G-7 | `export const runtime = 'edge'` (Next 16 で proxy.ts と並んで Node 固定推奨) | 全 API route で `runtime = 'nodejs'` 明示 (`app/api/{me,study-days,entity-mutations,review-events,dashboard,pull,exams,webhooks/*}/route.ts`)。 edge runtime 使用 **0 件** | なし (= edge runtime 利用ゼロのため Node 化への移行コストなし) |
| G-8 | `experimental_ppr` / `unstable_*` route segment config | **0 件** | なし |
| G-9 | `next/font` 利用 | `app/layout.tsx:4` に `Geist` を `next/font/google` から import (1 callsite)。 Next 16 でも継続サポート、 default 値変更なし | なし |

→ **手動 fix が要る breaking 該当箇所は G-5 (webpack config の処遇) のみ**。 他は 0 件で素通り。

---

## 2. マトリクス §4 未確定事項の消化

### 2.1 #1 — CVE 曝露の精緻化

#### 2.1.1 Prod の Next バージョン履歴

- `package.json` の `next:` line は **initial commit (236a189, 2026-05-15)** 時点で `^15.5.15`、 以降変更なし。
- 本番初回 deploy: `2026-05-17` 周辺 (`docs/superpowers/sessions/2026-05-17-env-separation-and-prod-deploy-handoff.md` 起点)
- **prod 稼働期間**: 2026-05-17 〜 2026-06-11 = **約 25 日間**。 この期間ずっと `next@15.5.15` resolve。
- `pnpm-lock.yaml` の `next@15.5.15:` entry も install 時点から不変。

#### 2.1.2 `pnpm audit` 結果 (develop branch、 2026-06-11 時点)

**全 advisories**: 37 件 (うち Next 13、 protobufjs 8、 hono 7、 fast-uri 2、 esbuild 1、 ip-address 1、 js-cookie 1、 brace-expansion 1、 @protobufjs/utf8 1、 qs 1、 ws 1)。

**Next.js 関連 13 件 (全て直接 dep の `.>next`)**:

| severity | range | 件数 | 代表的 title |
|---|---|---|---|
| **high** | `<15.5.16` | 6 | (a) Vulnerable to DoS with Server Components / (b) Cache Components 経由 DoS (connection exhaustion) / (c) WebSocket 経由 SSRF / (d) Middleware/Proxy bypass via dynamic route parameter injection / (e) Middleware/Proxy bypass in Pages Router via i18n / (f) Middleware/Proxy bypass in App Router via segment-prefetch |
| **high** | `<15.5.18` | 1 | (g) Middleware/Proxy bypass in App Router via segment-prefetch — Incomplete Fix Follow-Up |
| moderate | `<15.5.16` | 4 | (h) XSS in App Router CSP nonces / (i) XSS in beforeInteractive scripts / (j) RSC cache poisoning / (k) Image Optimization DoS |
| low | `<15.5.16` | 2 | (l) Middleware/Proxy redirects cache-poisoning / (m) RSC cache-busting collision cache poisoning |

→ **prod (next 15.5.15) は (a)-(m) の 13 件全てに曝露中**。 (g) は更に <15.5.18 までの range なので 15.5.16 / 15.5.17 でも残る (= patch line で完全に解消するには 16.x or 15.5.18+ 必須)。

#### 2.1.3 外部入力可能な RSC endpoint / server action

- **server action ファイル数**: 8 (`grep "use server"` で確認、 `app/(app)/app/{settings/actions,exams/_actions,settings/_actions,upgrade/actions,upload/_actions}/*.ts` + `app/(marketing)/contact/actions.ts`)
- **API route**: 9 (`app/api/{dashboard,entity-mutations,exams,me,pull,review-events,study-days,webhooks}` 配下に `route.ts`)
- **middleware**: 1 (`middleware.ts` = Clerk auth gate + CSP default)

→ (d)(e)(f)(g)(l) の middleware bypass 系は **Clerk auth gate を回避され得る** (= 認証してない attacker が `/app/*` を叩ける窓)、 (j)(m) の RSC cache poisoning は **server action / RSC response の cross-user 混線** リスク、 (c) の WebSocket SSRF は **server 側の outbound 経路から内部 env / secret を probe** 可能。

#### 2.1.4 rotate 対象 secret の優先順位 (実 rotate は OT)

| 優先 | secret | 根拠 (該当 CVE) | 影響範囲 |
|---|---|---|---|
| **P0** | **Clerk session 系** (`CLERK_SECRET_KEY` 含む)、 active session 全 sign-out | (d)(e)(f)(g)(l) middleware bypass + (j)(m) RSC cache poisoning → auth gate を通らずに `/app/*` 突破 + 他 user の RSC payload 混線 → session 真偽 / 他 user データ漏洩経路あり | 高: 全 user の session 強制再ログイン |
| P1 | **Stripe Webhook signing secret** (`STRIPE_WEBHOOK_SECRET`) | (c) SSRF → 内部 endpoint の URL / 環境変数を probe → webhook signing key を server response に乗せて漏れる経路あり (理論上) | 中: webhook 受信が一時的に不可 → Stripe dashboard 側で再発行 + Vercel env 更新で復旧 |
| P2 | **Gemini API key** (`GEMINI_API_KEY`) | (c) SSRF + (h)(i) XSS 経由で `process.env` を sniff される経路。 ただし Gemini key は free-tier (CC 紐付けなし、 CLAUDE.md §AI-1)、 漏洩しても課金被害は 0、 limit に達するまで他者利用される可能性のみ | 低: AI 機能が一時的に圏外、 再発行は Google Cloud console で 1 分 |
| P3 | **DATABASE_URL** (Supabase Transaction pooler) | 直接 leak path は薄いが env 全 dump 系の attack で連鎖、 rotate コストも低 | 低: Supabase dashboard で password rotate |
| skip | Clerk `WEBHOOK_SECRET` (svix) | leak path 細い + 漏洩しても webhook 偽造には clerk infra 側の制御も必要 | 不要 (rotate しても影響軽微、 後回し可) |

**現実的初動**:
1. **Next 16.2.9 への upgrade を波1 で実行 = 13 CVE 全てを同時に塞ぐ** (rotate 議論はその後 OT 判断)
2. rotate を厳密にやるなら P0 (Clerk session) のみ波1 sprint と同時、 P1-P3 は後続 sprint で順次

実害が出ているという証跡は本調査範囲では不可視 (Vercel access log や Sentry イベントを見ないと判断不可)。 「曝露しただけ」 と「侵害された」 は別問題。

### 2.2 #2 — radix 実 import 形

grep `from\s+['"]radix-ui['"]` (umbrella) と `@radix-ui/react-` (個別) を `app` + `components` 配下で実走:

| import 形 | 件数 | 該当 file |
|---|---|---|
| **umbrella `radix-ui`** | **5 件** | `components/ui/{button,tabs,label,popover,dropdown-menu}.tsx` |
| 個別 `@radix-ui/react-*` direct | **0 件** | — |

→ **全て umbrella 経由**。 matrix v1.3 §1.1 #18 推奨の `radix-ui ^1.5.0` への bump で 5 file 全てが連動 (個別 sub-package を `package.json` に追加する必要なし)。

確認した 5 file の使い方は `import { Slot } from "radix-ui"` / `import { Tabs as TabsPrimitive } from "radix-ui"` 等の **named import**。 1.4.3 → 1.5.0 で API surface 削除なし (matrix v1.3 でも minor bump 扱い) のため、 spec タスクは「`radix-ui ^1.4.3 → ^1.5.0` の bump + tsc + 各 UI component の smoke」 のみで足りる。

### 2.3 #3 — pg / postgres 責務

#### 2.3.1 app runtime での usage

- `from 'postgres'`: **1 file** (`lib/db/index.ts:7`、 `import postgres from 'postgres'` → `drizzle(postgres(DATABASE_URL, { prepare: false }), { schema })`)
- `from 'pg'`: **0 file** (リポジトリ全域 grep、 node_modules / pnpm-lock 除外)
- `drizzle-orm/postgres-js` import: **1 file** (`lib/db/index.ts:6`)
- `drizzle-orm/node-postgres` import: **0 件**

→ **app runtime は postgres-js (`postgres` package) 単独**。 `pg` package は app code から触られない。

#### 2.3.2 なぜ `pg` が `dependencies` にいるか

`pnpm why pg`:
```
pg@8.20.0
├─┬ drizzle-orm@0.45.2  (optional peer)
└── recall-mint@0.1.0 (dependencies)  ← 直接記載
```

drizzle-orm の `optional peer` を満たすために install されているが、 我々は `drizzle-orm/node-postgres` adapter を import していないので、 **drizzle-orm の view から見ても pg は load されない** (peer は型補完用)。

#### 2.3.3 drizzle-kit (migration) は pg を必要とするか

`node_modules/drizzle-kit/package.json` の dependencies は `@drizzle-team/brocli` / `@esbuild-kit/esm-loader` / `esbuild` / `tsx` の 4 つのみ。 `pg` は drizzle-kit の **devDependencies** にのみ列挙 (= drizzle-kit 自身は内蔵していない)。 RecallMint の `drizzle.config.ts` は `dialect: 'postgresql'` で接続するが、 drizzle-kit は内部で動的に driver を選び、 `pg` でなく `postgres-js` でも migration を実行できる。

→ **`pg` + `@types/pg` は完全に dead weight**。 削除可能。

#### 2.3.4 client bundle に DB driver 漏れていないか

- `lib/db/index.ts` 冒頭に `import 'server-only'` 配備 (`fix(db): server-only import を追加してClient bundleへの混入を防ぐ` commit `df163e2` で対策済)
- client component (`'use client'` directive ありの 49 file) のうち `@/lib/db/*` を import している 4 file は **全て `import type { ... }`** (`schema` の型のみ、 値 import なし)。 該当箇所:
  - `app/(app)/app/exams/[id]/_components/inline-option-row.tsx`
  - `app/(app)/app/exams/[id]/_components/inline-card-list.tsx`
  - `app/(app)/app/settings/delete-button.tsx`
  - `app/(app)/app/study/smart/_components/{study-session-host,session-runner}.tsx`
- client component から `@clerk/nextjs/server` / `@clerk/backend` import: **0 件**
- client component から `from 'pg'` / `from 'postgres'`: **0 件**

→ **client bundle に DB driver は混入していない**。 `server-only` guard が機能している。

#### 2.3.5 推奨

- spec の小さい chore: `pg ^8.20.0` と `@types/pg ^8.20.0` を `package.json` から削除。 lib/db は postgres-js 単独で動作継続、 tsc / vitest / build に影響なし (`pg` を import している場所がゼロのため)。
- Next 16 化と同 commit でやるか、 別 chore commit にするかは OT 判断 (本提案では別 chore [no-review] commit で扱うのが綺麗)。

### 2.4 #4 — Turbopack 境界 grep (client → server-only deps の漏出)

`'use client'` ファイル 49 件 を対象に下記 grep:

| pattern | 件数 | 評価 |
|---|---|---|
| `from "@/lib/db"` / `@/lib/db/...` | 4 件 (全て `import type`) | 安全 (型 erasure) |
| `from "@/lib/stripe"` (= `lib/stripe.ts` 直接 import) | **0 件** | 安全 |
| `from "@/lib/stripe/price-mapping"` | 2 件 (`pricing-table.tsx`、 `upgrade-plans.tsx`、 両方 `import type { Plan, BillingInterval }`) | **要注意だが安全**。 `price-mapping.ts` は module load 時 env を読んで throw する side-effect 持ち。 `import type` は erasure するため client bundle には残らない (= 実害なし)。 ただし「うっかり value import に書き換える」 PR で client にも leak → throw する罠が残る (波1 範囲外、 別議論) |
| `from "@/lib/auth/*"` (= server util) | 2 件 (`pricing-table.tsx`、 `upgrade-plans.tsx`、 両方 `import type { Plan }` from `@/lib/auth/plan-limits`) | 安全 |
| `from "@clerk/nextjs/server"` / `@clerk/backend` | **0 件** | 安全 |
| `from 'pg'` / `from 'postgres'` | **0 件** | 安全 |

→ **Turbopack default 化で boundary が壊れる箇所は本調査範囲で 0 件**。 Next 16 で webpack → Turbopack default に変わっても、 client component の build が server-only module を引きずり込むパスは現状コードに存在しない (`server-only` guard + type-only import で 2 重防護)。

### 2.5 #7 — `@types/node` 最新 24 系 patch

registry 確認 (`pnpm info @types/node versions --json` を Python フィルタ):

- 24.x 系 release 数: **65 patch**
- **最新 24.x**: `24.13.2`
- top 5: `24.12.3 / 24.12.4 / 24.13.0 / 24.13.1 / 24.13.2`

devcontainer 上の Node は `v24.13.0` (`node --version`)。 `@types/node` も 24 系で揃えると一貫: matrix v1.3 §1.2 #46 の推奨 `^24.7.0` は patch-level の保守的提案だが、 **`^24.13.2` exact 確定**で問題なし (現 install `^25.6.0` を 24 系に戻す形)。

採用: **`@types/node ^24.13.2`** (or `^24.13.0` 厳密な node binary 整合) を波1 spec に明記。 caret `^24.13.2` なら以後 24.13.x / 24.x の patch 自動追随。

---

## 3. 環境系

### 3.1 `post-create.sh:23` の pnpm install を corepack 化 / version 明示 (案 1 件)

現状:
```bash
# .devcontainer/post-create.sh:22-24
echo "==> [2/8] pnpm"
npm install -g pnpm                                  # ← latest を taking
pnpm config set store-dir ~/.local/share/pnpm-store
```

`package.json` 側は `"packageManager": "pnpm@10.33.0"` を declare ([1 source]。 corepack や `engines.pnpm` は未利用)。 → post-create は latest pnpm を取り、 packageManager declaration と version drift が起き得る。

**変更案** (1 案、 実装しない):

```bash
echo "==> [2/8] pnpm (via corepack、 packageManager field 準拠)"
corepack enable                                       # Node 24 同梱で initial cost ゼロ
corepack prepare pnpm@10.33.0 --activate              # packageManager field と整合
pnpm config set store-dir ~/.local/share/pnpm-store
```

利点:
- `package.json` の `packageManager` field が single source-of-truth、 post-create の version を「上げ忘れる」 drift がなくなる
- corepack は Node 16.10+ 同梱 (= Node 24 devcontainer で追加 install ゼロ)
- 既存 `pnpm config set store-dir` はそのまま

留意:
- corepack の初回起動で signed package のダウンロードが発生 (playwright base image の network 制限下で挙動確認は要)
- pnpm version を上げる際は `package.json` の `packageManager` field を更新 → 再 `postCreateCommand` 実行 (devcontainer rebuild) で反映

### 3.2 devcontainer Node が 24.13.0 であること

`node --version` 実走で **v24.13.0** を確認。 matrix v1.3 §3.1 の「devcontainer 実 Node = v24.13.0」 と一致。 Node 24 active LTS (2025-10〜) + Next 16 minimum Node 20.9 を満たす。

### 3.3 Vercel 側 Node 設定確認は OT 項目

- `vercel.json` の現状:
```json
{
  "regions": ["hnd1"],
  "functions": { "...stripe/route.ts": { "maxDuration": 60 }, "...clerk/route.ts": { "maxDuration": 60 } }
}
```
- `runtime` 指定なし → **Vercel の deploy default Node version 任せ** (2026-06 時点で Node 22 LTS が default、 24 系も選択可)。
- package.json `engines.node` も未設定 (matrix v1.3 §3.1 で `engines.node = ">=22.0.0"` 明示を推奨済)。

**OT 確認項目** (Claude Code が触れない領域):
- (i) Vercel project settings → General → Node.js Version の現状値 (22.x / 24.x)
- (ii) Next 16 を deploy する前に Vercel Project Settings で Node 24 系に切替済か (Node 22 でも Next 16 は動くが、 devcontainer と production の Node major が乖離していると issue 切り分け面倒)
- (iii) `package.json` に `engines.node` を明示するか (Vercel build 時の guard、 + pnpm install の warn)

---

## 4. 波1 spec に入れるべき task 候補 (難度順)

「波1 spec を書くときの task 草稿」。 各項目は spec 起草時に再構成。

| # | task | 推定難度 | 根拠 / sprint scope |
|---|---|---|---|
| 1 | **CVE 即応**: Next `^15.5.15` → `16.2.9` (exact)、 react/react-dom `^19.2.5` → `19.2.7` (exact)、 @types/react `^19.2.14` → `19.2.17`、 eslint-config-next `16.2.4` → `16.2.9` | 低 (codemod 自動) | §1.3.1。 同 commit で 13 CVE 解消。 codemod 経由なので diff 自体は決定的 |
| 2 | **`middleware.ts` → `proxy.ts` rename** + 中身は `clerkMiddleware(...)` default export のまま (runtime コメント Edge → Node 書換) | 中 | §1.2、 M-1。 codemod 不発、 手動必須。 lib/clerk.ts 側コメントも更新 (M-4) |
| 3 | **`pnpm.overrides` 整合**: codemod 追加分 (`@types/react` / `@types/react-dom`) を `pnpm-workspace.yaml` に統合、 `package.json` の `pnpm` block を削除 | 中 | §1.5。 一度通ったら永続、 install 完走 + `pnpm-lock.yaml` の overrides 反映を git diff で再確認 |
| 4 | **`next.config.ts` webpack block の処遇**: dev watch ignored 5 path は Turbopack default で不要 → block ごと削除 (一案) | 低 | §1.6 G-5。 dev 起動時の watch CPU を下げる目的の microopt なので削除 → 影響軽微 |
| 5 | **`@clerk/nextjs` bump (7.2.9 → 7.4.3)** ※matrix v1.3 §2.1 推奨、 Next 16 + proxy.ts 公式 base 整合 | 低 | red flag §6.5、 §1.3.2 lock diff で 7.2.9 のままでも動くが proxy.ts 公式例 base にするなら同 sprint で上げるのが綺麗 |
| 6 | **`@types/node` を `^25.6.0` → `^24.13.2` 系に落とす** (devcontainer Node 24 LTS と整合) | 低 | §2.5。 type-only、 build / test 影響軽微 |
| 7 | **`pg` + `@types/pg` の dead weight 削除** | 低 | §2.3.5、 M-5。 別 chore commit が綺麗 (波1 と同 sprint でも別 commit でも OK) |
| 8 | **`pnpm audit` で残る 24 件の transitive 高 / 中 severity の扱い決め** (next bump 後の再 audit で何件残るかを実測 → 残存分は別 spec) | 低 | §2.1.2、 P1-P3 secret rotate と並んで「波1 範囲では Next 直接対応のみ、 transitive は次 sprint」 で切り分け |
| 9 | **smoke**: Vercel preview で sign-in / sign-up / protected route gate / API route 3 種 (pull / entity-mutations / webhooks/stripe) を確認 | 中 (手作業 + OT 専権領域あり) | spec 完了条件の最終 gate。 Stripe webhook smoke は OT 課金実機要 |
| 10 | (option) `engines.node = ">=22.0.0"` を package.json に明示 + Vercel Project Settings Node 24 化 (OT 項目) | 低 | §3.3。 spec に「OT 確認」 として記載のみ、 Claude Code は触らない |

「波1 = Next 16 化 + Clerk + 周辺整合」 を 1 sprint に compose し、 `pg` 削除 / pnpm audit 残存対応は別 sprint へ。 sprint plan 行数は 150-200 行 (CLAUDE.md の 250 行 cap 内、 余裕あり)。

---

## 5. red flag 一覧 (筆頭順)

| level | 内容 | 対応 |
|---|---|---|
| **特高** | prod が `next 15.5.15` で 25 日間稼働中。 `<15.5.16` 範囲の **13 CVE 全曝露** (high 6 + moderate 4 + low 2 + high <15.5.18 1)。 中でも middleware bypass 5 件は Clerk auth gate 経由の保護を回避させる範囲 | 波1 sprint で 16.2.9 へ upgrade = 13 件同時解消。 secret rotate は P0 (Clerk session) のみ同時、 P1-P3 は別 sprint で順次 OT 判断 |
| 高 | codemod 追加の `package.json` `pnpm.overrides` block が `pnpm-workspace.yaml` overrides を effective に clobber。 lockfile が `uuid` / `postcss` overrides を失う | 波1 spec の task #3 で必ず明示対応。 install 後の `pnpm-lock.yaml` の overrides セクションを必ず diff 確認 |
| 中 | `middleware.ts` の `export default clerkMiddleware(...)` を codemod は検出しないため、 file rename + runtime コメント書換が手作業必須 | spec task #2 として実装 step を明示 (rename だけでなく lib/clerk.ts のコメントまで含めて 1 commit に) |
| 中 | `next.config.ts` の webpack block は Turbopack default 化に伴い「無効化される or 動かなくなる」 可能性。 dev watchOptions の ignored が効かなくなると CPU 上がる軽微 incident のみ | spec task #4 で削除 → 影響軽微で吸収 |
| 中 | @clerk/nextjs 7.2.9 のままでも動くが、 Next 16 + proxy.ts 公式例 base は 7.4.3。 上げない判断ありなら spec 明示 | spec task #5 で 7.4.3 へ bump、 OT 判断あれば 7.2.9 維持 |
| 低 | pg / @types/pg は dead weight だが、 削除を波1 と混ぜると blast radius が増える | 別 chore commit で扱う ([no-review] 可) |
| 低 | corepack 化 (§3.1) は post-create.sh だけ触る別 issue。 波1 sprint に混ぜない | spec 範囲外、 別 chore sprint (任意) |

---

## 6. 次の判断材料 (spec 起草 OT 承認時の問い)

1. **波1 sprint scope に rotate 議論を含めるか / 別 sprint か**: 含めるなら P0 (Clerk session) のみ同時、 P1-P3 は順送り。 含めないなら CVE patch (Next bump) だけ波1、 rotate は波1 完了後の別議論。
2. **`pnpm.overrides` 整合方針**: workspace.yaml に集約 (推奨) vs package.json に集約。
3. **`pg` / `@types/pg` 削除を波1 同 sprint vs 別 sprint**: 同 sprint なら 1 commit 追加で完結、 別 sprint なら波1 を「Next 16 化のみ」 にできて scope 狭い。
4. **`@clerk/nextjs` 7.4.3 への bump を波1 含めるか**: 推奨は含める (proxy.ts 公式 base 整合)、 ただし 7.2.9 維持でも Next 16 動作する。
5. **Vercel Project Settings の Node version 確認**: OT 専権、 波1 deploy 前に Vercel dashboard で current node version 確認 + 必要なら Node 24 系に変更。
