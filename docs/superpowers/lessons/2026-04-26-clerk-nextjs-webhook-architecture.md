# Clerk + Next.js Webhook-only Architecture

> **Source**: plan00 Bug 2 / Bug 3 cycle (2026-04-22 〜 2026-04-26) で得た知見の保存。Clerk + Next.js プロジェクトで再利用。

## 1. 背景

plan00（英単語学習アプリ MVP）で本番 deploy 後に表面化した一連の bug が、いずれも「Clerk session JWT の 60 秒短命キャッシュ × `clerkClient.users.getUser()` の lazy upsert」という構造的問題に起因していた。3 度の方針転換を経て、Clerk 公式推奨パターン（webhook-only sync）に振り切ることで根治。本ドキュメントはその知見を Clerk + Next.js プロジェクトの design baseline として保存する。

## 2. Lessons Learned

### 2.1 Clerk + Next.js では webhook を source of truth として使う

Clerk 公式は「Clerk が source of truth、app DB は webhook 同期されるコピー」アーキテクチャを推奨。`currentUser()` / `clerkClient.users.getUser()` は rate limit に加算（dev: 100 req / 10s、prod: 1000 req / 10s）され、request hot path で呼ぶのは避けるべきと公式が明記している。

- 公式: https://clerk.com/blog/webhooks-getting-started
- rate limit 警告: https://clerk.com/docs/nextjs/guides/users/reading

### 2.2 session JWT は短命 cache（60 秒）、cached JWT 404 fallthrough のアプリ側防御が必須

Clerk session token は 60 秒 lifetime の short-lived JWT（公式: https://clerk.com/docs/guides/how-clerk-works/overview）。`clerkClient.users.deleteUser()` で backend の user を削除しても、ブラウザ cookie 内の JWT は exp まで有効に見える。この cache window 中に削除済み user の `userId` が `auth()` から返されるため、`clerkClient.users.getUser(userId)` を呼ぶと 404 が返り throw → app crash の経路ができる。**アプリ側で「user が削除済みでも crash しない」設計が必須**。

### 2.3 lazy upsert pattern は webhook 利用可能なシステムでは antipattern

`getCurrentUser()` で「DB に user 行がなければ insert」する lazy upsert は、webhook が source of truth として機能している場合は不要。webhook の delivery 信頼性は十分高く（Clerk Dashboard で `Succeeded` 連発を観測）、race window は数秒の loading UI で吸収可能。lazy upsert を維持すると `clerkClient.users.getUser()` 呼出しが残り、§2.2 の cached JWT 404 経路が消えない。

### 2.4 「Clerk が source of truth、app DB は同期コピー」を design baseline に

自分の DB に user 情報を書く理由を「**join 用の外部キー**」のみに絞ると、データ整合性問題が大幅に減る。user 属性（email、name 等）は app DB に冗長コピーするのではなく、必要な時だけ Clerk から取得する（hot path では取得しない）。

### 2.5 webhook event delivery は順序保証なし、 handler 冪等性が必須

Clerk (Svix 経由) / Stripe とも at-least-once delivery で、 同じ event が複数回届く可能性 + **順序保証なし** (例: `customer.subscription.deleted` が `customer.subscription.created` より先に届く場合あり)。 順序依存した実装は構造的に破綻する。

冪等性確保 pattern: `event.id` を unique 制約 (PK) で DB 保存、 INSERT 試行 + 制約違反なら既処理 return。 plan00 の `stripe_events` / `clerk_events` テーブルが該当。 `INSERT ... ON CONFLICT DO NOTHING RETURNING` で重複 skip + Stripe / Clerk retry を構造的に吸収。 Stripe のリトライ仕様は最大 3 日 / 指数バックオフ、 Clerk (Svix) も複数回リトライ、 受け側冪等性で safe。

## 3. 推奨アーキテクチャパターン

### 3.1 middleware

`clerkMiddleware()` + `auth.protect()` で保護ルート設定のみ。**DB アクセスは middleware で行わない**（Edge runtime 互換性 + パフォーマンス）。

```ts
// middleware.ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedRoute = createRouteMatcher(['/app(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect()
  }
})
```

### 3.2 `getCurrentUser()` 簡略化

`auth()` の userId + DB SELECT のみ。`clerkClient.users.getUser()` 呼出しは撤去。戻り型は `Promise<User | null>`（null = webhook race の DB 行欠損）。

```ts
// lib/auth/ensure-user.ts
export async function getCurrentUser(): Promise<User | null> {
  const { userId } = await auth()
  if (!userId) throw new UnauthenticatedError()

  const db = getDb()
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1)
  return rows[0] ?? null
}
```

### 3.3 webhook handler

`user.created` で `INSERT ... ON CONFLICT DO NOTHING`（冪等）、`user.deleted` で `deleted_at = now()` セット。Svix 署名検証必須。エラー時も 200 応答（再送ループ防止）。

```ts
// app/api/webhooks/clerk/route.ts (簡略)
async function handleEvent(evt) {
  if (evt.type === 'user.created') {
    await db.insert(users).values({ clerkId, email })
      .onConflictDoNothing({ target: users.clerkId })
  } else if (evt.type === 'user.deleted') {
    await db.update(users).set({ deletedAt: sql`now()` })
      .where(eq(users.clerkId, evt.data.id))
  }
}
```

### 3.4 layout / page で null ハンドリング

`/app/**` layout で `getCurrentUser()` が null を返すケース（webhook race）に inline syncing UI + meta refresh で対応。

```tsx
// app/app/layout.tsx (簡略)
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
  return <main>{children}</main>
}
```

**重要**: Next.js App Router の layout / page は **独立 async RSC として並列 render** される。layout が早期 return しても page body は実行されるため、各 page にも `if (!user) return null` の minimal guard が必要（TS strict 充足 + defense-in-depth）。

### 3.5 Server Actions の null 早期 return

`getCurrentUser()` を呼ぶ Server Action 各箇所で:
- `Promise<ActionResult>` 戻り型: `return { ok: false, error: 'アカウント準備中...' }`
- `Promise<void>` 戻り型（`redirect()` する action）: `throw new Error('USER_NOT_SYNCED')`

### 3.6 `/` (landing) の redirect 条件

「Clerk session AND DB 行 AND `deleted_at IS NULL`」の **3-AND** で `/app` redirect 判定。`if (userId) redirect('/app')` だけだと cached JWT で削除済み user が `/app` に bounce して crash する。

### 3.7 Stripe sub cancel: auto-pagination + `status: "all"`

`user.deleted` webhook 内で Stripe customer の全 sub を cancel する場合:

```typescript
// ❌ 100 件上限で打ち切り、 ページネーション欠如
const subs = await stripe.subscriptions.list({ customer, limit: 100 })
for (const sub of subs.data) await stripe.subscriptions.cancel(sub.id)

// ✅ auto-pagination + status: "all"
for await (const sub of stripe.subscriptions.list({ status: "all", customer })) {
  await stripe.subscriptions.cancel(sub.id)
}
```

落とし穴: `status: "all"` を **指定しない** で active sub を iterate しながら cancel すると、 cancel 後の sub が 1 ループ後の `for await` で次 page fetch 時に消えており `resource_missing` error (stripe-node #2368)。 `status: "all"` で「現状全 sub」 を iterate 対象に固定することで回避。

部分失敗 (個別 cancel が transient error) の場合は: `cancelWithRetry` (429 で 1 sec sleep + 1 retry) + `recordFailure` で `deletion_failures` audit table + Discord notifyOps で OT 手動 recovery 経路。 全部 transaction 内に閉じない (外部 call を transaction 内 await で抱えない)。

## 4. アンチパターン（やってはいけないこと）

- **`getCurrentUser()` で毎リクエスト `clerkClient.users.getUser(userId)` を呼ぶ lazy upsert**
  - 60 秒 cached JWT × 削除済み user で 404 → app crash
  - Clerk Backend rate limit を消費
- **middleware で重い処理（DB クエリ / Clerk Backend 問い合わせ）**
  - Edge runtime 互換性問題
  - 全リクエストにレイテンシを乗せる
- **client `useClerk().signOut()` を deleted user に対して呼ぶ**
  - dev instance × cross-origin × 3P cookie policy で Promise hang（observe 報告あり）
  - account 削除フローでは server-side `redirect('/sign-out-deleted')` 等で代替
- **`<SignOutButton>` を deleted user 着地ページに配置**
  - 内部で `signOut()` を呼ぶため上と同じ hang リスク
  - plain `<Link href="/">` で代替

## 5. plan00 case study への参照

plan00 リポジトリ内の関連 spec/plan:

- **R1** (Bug 2 fix, server-side redirect): `docs/superpowers/specs/2026-04-26-delete-account-server-redirect.md` + 対応 plan
  - 削除フロー: client `useClerk().signOut()` を撤去、Server Action 末尾で `redirect('/sign-out-deleted')`、`/sign-out-deleted` の `<SignOutButton>` も `<Link>` に置換
- **R2** (Bug 3 fix, webhook-only user sync): `docs/superpowers/specs/2026-04-26-webhook-only-user-sync-design.md` + 対応 plan
  - `getCurrentUser()` 簡略化、lazy upsert 撤去、layout に SyncingPage、`/` の 3-AND redirect、Server Actions + pages の null 早期 return

両 spec の supersede chain（試行錯誤の記録）も保存されており、なぜこの設計に到達したかの軌跡が追える。

## 6. 関連リンク

### Clerk 公式 doc
- [Webhooks Getting Started](https://clerk.com/blog/webhooks-getting-started) — webhook source of truth pattern
- [How Clerk Works](https://clerk.com/docs/guides/how-clerk-works/overview) — session JWT 60 秒 lifetime
- [Reading user data](https://clerk.com/docs/nextjs/guides/users/reading) — `currentUser()` rate limit 警告
- [Clerk Backend SDK: deleteUser](https://clerk.com/docs/reference/backend/user/delete-user) — 削除のみで session 処理なし
- [Custom sign-out flow](https://clerk.com/docs/guides/development/custom-flows/authentication/sign-out) — `useClerk().signOut()` パターン
- [Clerk API Response Error types](https://clerk.com/docs/reference/types/clerk-api-response-error) — error shape (`status: number`, `clerkError: true`)
- [Dev instance cookies](https://clerk.com/docs/guides/development/sdk-development/terminology) — `__clerk_db_jwt` / `__client_uat` / `__session` の役割

### Next.js 公式 doc
- [Server Actions: redirect after mutation](https://nextjs.org/docs/app/api-reference/functions/redirect)
- [Middleware](https://nextjs.org/docs/app/api-reference/file-conventions/middleware)

### 関連 GitHub issues
- [clerk/javascript #954](https://github.com/clerk/javascript/issues/954) — signOut hang 関連
- [clerk/javascript #3353](https://github.com/clerk/javascript/issues/3353) — 同上
