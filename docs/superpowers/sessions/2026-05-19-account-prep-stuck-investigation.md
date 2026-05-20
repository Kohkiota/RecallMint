# Sign-up 後「アカウントを準備しています…」 で永遠に止まる問題の調査

> 作成: 2026-05-19 (S1.7 完了後の staging cleanup 後再現)
> 状態: 調査のみ、 実装変更なし

OT が staging Neon truncate + Clerk users 全削除 + Stripe customers 全削除後に
新規アカウント登録すると、 sign-up は通るが `/app` で「アカウントを準備しています…
数秒お待ちください」 が消えない症状。

---

## TL;DR (結論先出し)

- 「アカウントを準備しています…」 は `app/(app)/app/layout.tsx:9-21` の `SyncingPage`
  で表示される transitional UI。 **JavaScript polling ではなく `<meta http-equiv=
  "refresh" content="2">` で 2 秒ごと full page reload** する設計
- reload 後の判定 = `getCurrentUser()` で `users` table に `clerkId = auth().userId`
  の row があるか SELECT するだけ
- **永遠に固まる = `users` table に row が INSERT されていない**。 中間の polling 不全
  ではなく、 webhook → INSERT 経路の根本停止
- 最有力仮説: **Clerk Dev instance の Webhooks endpoint URL が staging URL を指して
  いない / `CLERK_WEBHOOK_SECRET` が新しい webhook と一致していない**

---

## 1. Clerk webhook handler の実装確認

`app/api/webhooks/clerk/route.ts` (237 行) の現状:

### 1.1 Svix 検証経路 (line 38-67)

- `CLERK_WEBHOOK_SECRET` 必須 (未設定時、 production は 500、 non-production は 200
  で「未設定」 を return)
- header 3 種 (`svix-id` / `svix-timestamp` / `svix-signature`) 全 required
- `new Webhook(secret).verify(payload, headers)` で署名検証、 fail は 400

### 1.2 Idempotency (line 71-80)

- `clerk_events` table に `eventId: svixId, type: evt.type` を INSERT
- `ON CONFLICT DO NOTHING RETURNING` で duplicate → 200 即 return
- 同じ webhook 再送に対し冪等

### 1.3 `user.created` handler (line 105-112)

```typescript
if (evt.type === 'user.created') {
  const data = evt.data as { id: string; email_addresses?: { email_address: string }[] }
  const email = data.email_addresses?.[0]?.email_address ?? 'unknown@example.com'
  await db
    .insert(users)
    .values({ clerkId: data.id, email })
    .onConflictDoNothing({ target: users.clerkId })
  return
}
```

**schema との整合** (`lib/db/schema.ts:60-107`):

| schema 列 | webhook INSERT | 取扱い |
|---|---|---|
| id (uuid PK) | 未指定 | `defaultRandom()` で auto |
| clerk_id | `data.id` | OK |
| email | `data.email_addresses?.[0]?.email_address ?? 'unknown@example.com'` | OK |
| stripe_customer_id | 未指定 | nullable で NULL |
| plan | 未指定 | default 'free' |
| subscription_status | 未指定 | nullable で NULL |
| current_period_end | 未指定 | nullable で NULL |
| cancel_at | 未指定 | nullable で NULL |
| billing_interval | 未指定 | nullable で NULL |
| created_at / updated_at | 未指定 | defaultNow() |
| deleted_at | 未指定 | nullable で NULL |

→ **INSERT 自体は schema と完全整合**、 INSERT が成功すれば SyncingPage は次の
   reload で抜ける。 INSERT に到達していない側を疑うべき。

### 1.4 outer try/catch + notifyOps (line 86-100)

- handler throw 時 → `notifyWebhookError({ handler: 'clerk', eventId, eventType,
  err, userId })` で Discord 通知 → 200 swallow (Clerk 再送ループ防止)
- INSERT 失敗 (DB 接続切れ / schema mismatch 等) なら **Discord に通知が来ているはず**

### 1.5 過去 lesson との整合

`docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` §3.3
の「lazy upsert 撤去、 webhook-only sync 一本化」 と整合。 `getCurrentUser()`
(`lib/auth/ensure-user.ts:31-44`) も lazy upsert なし、 pure DB SELECT のみ。
__→ コード設計は過去 lesson に従って正しく書かれている__。

---

## 2. Polling endpoint の実装確認

### 2.1 「アカウントを準備しています」 画面は polling していない

`app/(app)/app/layout.tsx`:

```tsx
function SyncingPage() {
  return (
    <>
      <meta httpEquiv="refresh" content="2" />
      <main>
        <h1>アカウントを準備しています…</h1>
        <p>数秒お待ちください。</p>
      </main>
    </>
  )
}

export default async function AppLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return <SyncingPage />
  if (user.deletedAt) redirect('/sign-out-deleted')
  return /* normal layout */
}
```

- **2 秒ごと full page reload** (browser-native `<meta http-equiv="refresh">`)
- reload 後、 Server Component `AppLayout` が再実行 → `getCurrentUser()` 呼び出し
- `users.clerkId = auth().userId` で row が見つかれば SyncingPage 抜けて normal layout

### 2.2 `/api/me/deletion-status` は sign-up 用ではない

唯一の `/api/me/` endpoint = `deletion-status/route.ts`、 **アカウント削除完了の
polling 専用**。 `app/(app)/app/settings/delete-button.tsx:41-87` が削除 button
クリック後に 1 秒間隔で叩く endpoint。 sign-up race とは **無関係**。

### 2.3 終了条件

SyncingPage の脱出条件 = `users` table の SELECT が row を返すこと。 他に判定は無い
(`deletedAt` チェックは row 存在後の zombie net、 別 path)。

---

## 3. Sign-up 後の遷移 flow

### 3.1 Clerk SignUp primitive

`app/(auth)/sign-up/[[...rest]]/page.tsx` は `<SignUp />` 直書きのみ。 Clerk 内部で
sign-up flow を完了させる。

### 3.2 Redirect 設定

`app/layout.tsx:79-80`:

```tsx
<ClerkProvider
  signInFallbackRedirectUrl="/app"
  signUpFallbackRedirectUrl="/app"
>
```

→ sign-up 完了後、 Clerk が `/app` に redirect。 `redirect_url` query param が無い
   とき (modal 経由等) の fallback。

### 3.3 `/app` 遷移時の判定

1. middleware (`middleware.ts:14-16`) が `/app(.*)` で `auth.protect()`、 session 無し
   なら sign-in redirect
2. `app/(app)/app/layout.tsx:28` が `getCurrentUser()` 呼ぶ
3. row 無 (= webhook が未到達) → SyncingPage → 2 秒後 reload → step 2 から再
4. row 有 → normal layout

### 3.4 失敗 path

webhook が到達しなければ step 3 の SyncingPage がループ。 user 体感「永遠に固まる」。
これが本症状の正体。

---

## 4. 環境変数 / Clerk 設定との整合

### 4.1 `.env.example` 関連変数

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
CLERK_WEBHOOK_SECRET=whsec_...
```

### 4.2 staging で必要な Vercel env (Preview + Development scope)

| env | 期待値 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_*` (Clerk Dev instance) | client SDK |
| `CLERK_SECRET_KEY` | `sk_test_*` (Clerk Dev instance) | server SDK |
| `CLERK_WEBHOOK_SECRET` | `whsec_*` (Clerk Dev instance の Webhooks endpoint 用) | Svix 署名検証 |
| `DATABASE_URL` | staging Neon (ep-long-fog-aox51k1u-pooler) | DB |
| `NEXT_PUBLIC_APP_URL` | `https://stg.recallmint.nekotest.net` | redirect base |
| `OPS_DISCORD_WEBHOOK_URL` | (任意) | webhook 失敗時の Discord 通知 |

### 4.3 Clerk Dashboard 側で OT が確認すべき事項 (Code 側で想定する URL pattern)

`app/api/webhooks/clerk/route.ts` は **`POST /api/webhooks/clerk`** で待ち受け。
middleware matcher は `/app(.*)` のみ protect、 `/api/*` は通過しつつ署名検証で
独自保護。

OT が Clerk Dashboard で確認する項目:

1. **Webhooks endpoint URL** が `https://stg.recallmint.nekotest.net/api/webhooks/clerk`
   を指しているか (Clerk Dev instance、 staging 用)
2. **Subscribed events** に `user.created` が含まれているか (`user.deleted` も削除フロー用に必要)
3. **Webhook の Signing secret** が Vercel Preview scope の `CLERK_WEBHOOK_SECRET`
   と一致しているか (Dashboard で再生成 = 旧 secret 失効、 Vercel 側も同時更新要)
4. **Recent Deliveries** (Clerk Dashboard) で最近の試行が「Succeeded」 か「Failed」 か
   - Failed なら response code (401 = secret 不一致 / 500 = handler 例外 /
     404 = endpoint URL 違い)
5. Clerk Dashboard で staging cleanup で削除した Clerk user が確実に removed されているか
   (残っていると新 sign-up が「Already exists」 で hang する case あり)

### 4.4 Code 側で完全に想定外な状況の確認 path

OT 側で確認する Vercel / Clerk 設定を待たずに、 staging Neon 直接 SQL で webhook 経路の
切り分け可能:

```sql
-- 直近 24 時間の clerk_events を確認 (idempotency table = webhook 受信記録)
SELECT event_id, type, processed_at
  FROM clerk_events
  ORDER BY processed_at DESC
  LIMIT 10;
```

- 結果 0 件 = webhook が一度も到達していない (Clerk 設定 or Vercel routing 問題)
- 結果に `user.created` がある = webhook は受信、 INSERT 失敗 (handler 例外 or
  ON CONFLICT で skip)。 後者なら `users` table に row があるはずなので、
  確認:

```sql
SELECT id, clerk_id, email, created_at FROM users ORDER BY created_at DESC LIMIT 5;
```

---

## 5. 原因仮説 + 切り分け方法

### H1: Clerk Dashboard の Webhooks endpoint URL が古い / 削除済

**根拠**: staging cleanup で Clerk users を delete した時、 仕様変更で endpoint URL も
誤って消した可能性。 Clerk Dev instance は staging deploy ごとに endpoint 確認必要。

**切り分け**:
- Clerk Dashboard → Webhooks → endpoints 一覧
- URL が `https://stg.recallmint.nekotest.net/api/webhooks/clerk` を指しているか
- Recent Deliveries 0 件 = endpoint 設定削除済

**確度**: **高**。 直前の cleanup 操作で誤って削除した最も可能性大。

### H2: `CLERK_WEBHOOK_SECRET` が Vercel Preview scope と Clerk Dashboard で不一致

**根拠**: cleanup の流れで Clerk Webhook を再作成すると新しい `whsec_*` が発行される。
Vercel 側 env を update し忘れると 401 (`invalid signature`) で全 webhook 失敗。

**切り分け**:
- Vercel Dashboard → Settings → Environment Variables → Preview scope の
  `CLERK_WEBHOOK_SECRET` を確認
- Clerk Dashboard → Webhooks → Signing Secret を「Reveal」 して比較
- 不一致なら Recent Deliveries の response が 400 (`invalid signature`)

**確度**: **中-高**。 cleanup 関連 operations の副作用として頻発する error pattern。

### H3: Vercel function が build エラー / deploy 失敗で `/api/webhooks/clerk` が 404 / 500

**根拠**: 直前 commit (S1.7 7 commit) で push 漏れ or build エラー、 staging で
old build が動いている / deploy 中。

**切り分け**:
- `curl -X POST https://stg.recallmint.nekotest.net/api/webhooks/clerk` で 400
  (= 「missing svix headers」 = endpoint 生きている) を期待。 404 / 500 なら deploy 問題
- Vercel Dashboard → Deployments → 最新 staging build の status

**確度**: **低-中**。 S1.7 commits は本 session 終了時に未 push 状態だったため、 OT
push 後の deploy 完了タイミングと sign-up 試行のタイミング次第。

### H4: Clerk Dashboard で対象 user が削除されておらず重複 sign-up

**根拠**: staging cleanup で Clerk users を Dashboard 経由で個別 delete したつもりが
完了していなかった。 同 email で sign-up すると Clerk が hang する pattern あり。

**切り分け**:
- Clerk Dashboard → Users → 対象 email 検索
- 残っていれば Dashboard で改めて delete

**確度**: **中**。 OT が一括 delete 操作した記述があるが、 個別残存可能性あり。

### H5: handler 内で例外が出て INSERT 失敗、 Discord 通知も来ていない

**根拠**: notifyOps の OPS_DISCORD_WEBHOOK_URL が staging で未設定なら silent skip。

**切り分け**:
- Vercel Logs (staging deployment) → `/api/webhooks/clerk` の 200 / 4xx / 5xx 比率
- 500 (handler error swallowed) が出ているなら logs に stack あり
- OPS_DISCORD_WEBHOOK_URL が staging で空なら handler 例外 → notify 試行 → silent
  (lib/ops.ts:22-23、 未設定で no-op)

**確度**: **低**。 schema integrity / handler 設計は健全、 例外が出る pattern は
schema 不一致 (S1.7 で billing_interval / cards.tags 列追加済、 production DB migration
未 apply で 500 出る可能性は ある) のみ。 ただし `user.created` handler は users
table のみ touch、 billing_interval / cards.tags は別 table のため影響なし。

---

## 切り分け順序の推奨

OT が次に取るべき action:

1. **Clerk Dashboard → Webhooks → Recent Deliveries を見る** (5 秒)
   - 全 fail → H1 (URL) or H2 (secret) を確定
   - Succeeded ばかり → DB 側 (H5 or webhook 別問題)
   - 0 件 (試行記録なし) → H1 確定 (endpoint 不在 or sign-up が user.created を
     triggered していない)
2. **staging Neon に直接 SQL** で `SELECT * FROM clerk_events WHERE processed_at >
   now() - interval '1 hour'` (15 秒)
   - 結果あり = webhook 到達済、 H5 (handler error) 経路
   - 結果なし = webhook 未到達、 H1 / H2 / H3 確定
3. **`curl -i -X POST https://stg.recallmint.nekotest.net/api/webhooks/clerk`**
   - 400 「missing svix headers」 = endpoint 生きている
   - 404 / 500 = H3
4. 上記 3 step で原因 80% は切り分く想定

---

## 設計上の追加検討事項 (本症状とは独立、 S2 系)

- 現状 SyncingPage は **無限 retry**。 30 秒以上止まったら「Clerk webhook が機能して
  いない、 管理者に連絡」 等の文言に切り替える UX 改善余地あり
  (Phase 1 lesson は「数秒で resolve」 前提だったが、 cleanup 直後 race window が
  longer になる可能性あり)
- staging で `OPS_DISCORD_WEBHOOK_URL` を必ず設定する運用 (handler 例外を Discord で
  即時検知)

---

## 関連 file

- `app/api/webhooks/clerk/route.ts` (webhook handler)
- `app/api/me/deletion-status/route.ts` (sign-up 用ではない、 削除 polling 専用)
- `app/(app)/app/layout.tsx` (`SyncingPage` + meta refresh)
- `lib/auth/ensure-user.ts` (`getCurrentUser`、 lazy upsert なし)
- `app/(auth)/sign-up/[[...rest]]/page.tsx` (Clerk `<SignUp />` 直書き)
- `app/layout.tsx` (`<ClerkProvider signUpFallbackRedirectUrl="/app">`)
- `middleware.ts` (`/app(.*)` 保護、 `/api/*` 通過)
- `lib/db/schema.ts:60-107` (users 列定義)
- `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` (過去
  plan00 で同問題を根治した lesson)
- `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md`
  (Clerk env-aware validation)
- `docs/superpowers/lessons/2026-04-30-clerk-production-domain-setup-pitfalls.md`
  (Clerk production / Dev instance 切替の落とし穴)
