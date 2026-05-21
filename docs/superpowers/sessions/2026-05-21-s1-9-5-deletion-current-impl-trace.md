# S1.9.5 設計確定前の追加調査 — retry / Stripe / Clerk 削除の実装 trace

- 日付: 2026-05-21
- 種別: 追加調査 (既存実装の trace のみ、 設計選択肢 / 修正方針なし、 実装変更 0、 doc 1 file)
- branch: `develop` (前回事前調査 `31c436a` の続き)
- 関連: `docs/superpowers/sessions/2026-05-21-s1-9-5-user-deletion-physical-cascade-investigation.md` (前回、 全体構造)

本 doc は **既存実装の挙動 trace のみ**。 設計判断・修正方針は claude.ai + OT が後段で決定する。

---

## 0. サマリ (調査項目への即答)

| # | 確認事項 | 結論 |
|---|---|---|
| 1 | `cancelWithRetry` 詳細 | `lib/stripe.ts:80-88`。 HTTP 429 のみ 1 秒固定 sleep + 1 retry。 backoff なし、 明示 timeout なし。 test 3 件あり。 |
| 2 | DB transaction の retry | **皆無**。 codebase に DB transient error の retry は一切ない。 `handleUserDeleted` の `UPDATE` は transaction にすら入っていない。 |
| 3 | Clerk 削除の時系列 | client `user.delete()` 成功時点で Clerk user は削除済。 webhook は **その後** 非同期発火。 client 失敗時は通常 Clerk user 未削除。 |
| 4 | webhook 二重配信 / retry | Clerk = Svix。 Svix は非 2xx で 8 回 retry (~32h)。 RecallMint handler は **常に 200** を返すため Svix retry は実質起きない。 冪等性は `clerk_events` PK。 |
| 5 | Stripe / DB の順序 | `UPDATE deleted_at` (単文 auto-commit) → Stripe loop。 **同一 transaction ではない**。 Stripe 失敗で `UPDATE` は rollback されない = forward-only。 |
| 6 | `recordFailure` / Discord | `route.ts:202-229`。 DB INSERT → `notifyOps`。 `notifyOps` は **絶対に throw しない** (失敗は `logger.warn` のみ)。 |
| 7 | deletion-status polling | `completed` = `deleted_at` set かつ `subscription_status` ∉ {active, past_due}。 30 回 (30s) で来なければ UI は強制 navigate。 |
| 8 | 既存 test | clerk webhook 7 件 / cancelWithRetry 3 件。 子削除 / transaction 内 DELETE の test は無し。 流用パターンは process.test.ts の tx mock。 |

---

## 1. Stripe `cancelWithRetry` の実装詳細

### 1.1 該当コード (`lib/stripe.ts:71-88`)

```ts
// L71 — SDK client
export const stripe = new Stripe(key, { maxNetworkRetries: 2 })

// L78
const RATE_LIMIT_RETRY_DELAY_MS = 1000

// L80-88
export async function cancelWithRetry(subId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subId)
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeRateLimitError)) throw err
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS))
    await stripe.subscriptions.cancel(subId)
  }
}
```

### 1.2 retry は 2 層構造

- **SDK 層** (`lib/stripe.ts:71`): `maxNetworkRetries: 2`。 stripe-node v22 の
  `RequestSender._shouldRetry` が retry 対象とするのは **network error / HTTP 409 /
  5xx のみ** (`lib/stripe.ts:61-62` コメント)。 **HTTP 429 は SDK 対象外**。
  Idempotency-Key 自動付与で cancel の retry は安全。
- **application 層** (`cancelWithRetry`, L80-88): **HTTP 429 (`StripeRateLimitError`)
  のみ** を catch。 `RATE_LIMIT_RETRY_DELAY_MS = 1000` の **固定 1 秒 sleep** 後に
  1 回だけ再 cancel。 指数 backoff ではない (`lib/stripe.ts:74` コメント:
  「指数バックオフは webhook handler の Vercel function timeout を圧迫するため不採用」)。

### 1.3 判定 condition / permanent 失敗扱い

- `err instanceof StripeRateLimitError` でない error (4xx 確定 / SDK network retry
  枯渇後の network error 等) は **即 throw** (L84) → permanent 失敗扱い。
- 429 が 2 連続 (1 回目 + retry も 429) → 2 回目の `cancel` が throw → 呼び出し側へ。
- application 層の retry budget = **1**。
- throw された error は呼び出し側 `handleUserDeleted` の per-sub catch
  (`route.ts:167-175`) で `recordFailure` に流れる。

### 1.4 timeout

- `cancelWithRetry` 自体に **明示 timeout なし**。
- `stripe` client (`lib/stripe.ts:71`) に `timeout` option を渡していない →
  **stripe-node のデフォルト request timeout** が適用される (ドキュメント上 80,000ms)。
- 観察: この SDK default 80s は webhook の Vercel `maxDuration` 60s
  (`vercel.json`) を上回る。 1 本の hung Stripe call が function budget を
  使い切りうる構造 (trace 上の事実、 修正方針は提示しない)。

### 1.5 既存 test (`lib/stripe.test.ts:116-163`)

`describe('cancelWithRetry')`、 `vi.useFakeTimers()` 使用。 3 件:

- L127-135 `succeeds in 1 call` — 初回 resolve で 1 call。
- L137-147 `retries once on 429 and succeeds on the 2nd call` — 429 → 1s 進める → 2nd で成功。
- L149-162 `throws on 2nd consecutive 429 (retry budget = 1)` — 429 ×2 で `StripeRateLimitError` throw、 call 2 回。

---

## 2. DB transaction の retry 機構の有無

### 2.1 結論: DB transient error の retry は codebase に一切存在しない

### 2.2 `getDb()` の構成 (`lib/db/index.ts:17-27`)

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
// L24 — idle client / re-connect error を「ログするだけ」
pool.on('error', (err: Error) => logger.error({ event: 'db.pool.error', err }))
_db = drizzle(pool, { schema })
```

- Neon serverless driver (`@neondatabase/serverless` の `Pool` + WebSocket) +
  `drizzle-orm/neon-serverless`。 singleton。
- `pool.on('error', ...)` は **logger.error で記録するのみ**。 query / transaction を
  retry しない。
- Neon serverless driver も Drizzle も、 connection reset / deadlock / transient error
  での **自動 query retry を持たない**。

### 2.3 `db.transaction()` 全 call site (retry wrapper の有無)

| call site | retry wrapper |
|---|---|
| `lib/ai-usage-counter.ts:28` | なし (素の `await db.transaction(...)`) |
| `lib/exams/source-doc-status.ts:147` | なし |
| `app/(app)/app/upload/_actions/process.ts:218` (guard tx) | なし |
| `app/(app)/app/upload/_actions/process.ts:522` (完了 tx) | なし |
| `app/(app)/app/upload/_actions/process.ts:604` (markFailed tx) | なし |

すべて `await db.transaction(async (tx) => {...})` の直呼び。 retry loop で囲んだ
ものは皆無。

### 2.4 `handleUserDeleted` は transaction にすら入っていない

`route.ts:130-134` の `UPDATE users SET deleted_at`:

```ts
const updated = await db
  .update(users)
  .set({ deletedAt: sql`now()` })
  .where(eq(users.clerkId, userId))
  .returning({ id: users.id, stripeCustomerId: users.stripeCustomerId })
```

- `db.transaction()` ではなく **単文 `await db.update(...)`** = 暗黙 auto-commit。
- Stripe loop (`route.ts:157-176`) も transaction 外。
- → `handleUserDeleted` 内に DB transaction は **1 つも存在しない**。 transient DB
  error はそのまま throw され、 POST の outer catch (`route.ts:89-100`) →
  `notifyWebhookError` → 200。 retry なし。

### 2.5 codebase の retry pattern は外部 API 専用 2 種のみ

- `cancelWithRetry` (§1、 Stripe 429)。
- `callWithRetry` (`lib/ai/ocr.ts:82-108`、 Gemini HTTP transient error、
  指数 backoff `500 * 2^attempt` = 500/1000/2000ms、 最大 2 回)。

いずれも **外部 API call の retry**。 DB 操作の retry は無い。

---

## 3. Clerk user 削除のクライアント → webhook 到達 時系列

### 3.1 client `user.delete()` (`app/(app)/app/settings/delete-button.tsx`)

- L37 `const deleteAccount = useReverification(() => user?.delete())`。
- L39-69 `onConfirmDelete`: `user.id` memorize → phase `deleting` →
  `await deleteAccount()` → 成功で phase `polling`。

### 3.2 `useReverification` の役割 (lesson `2026-05-19-clerk-self-delete-requires-reverification.md`)

- Clerk は account 削除を **sensitive action** に分類、 直近再認証済の session で
  しか実行を許さない。 古い session の生 `user.delete()` は API が 403
  `session_reverification_required` を返す。
- `useReverification(fetcher)` は fetcher を wrap し: ① backend が reverification
  要求 → Clerk が **自動で modal 表示** → ② user 再認証完了 → **元 request を自動
  retry** → ③ user が modal キャンセル → 専用 error で reject。

### 3.3 reverification 失敗時の挙動 (`delete-button.tsx:50-68`)

- `isClerkRuntimeError(err) && isReverificationCancelledError(err)` (L51) →
  **「中断」** 扱い: `memoizedUserId` クリア + phase を `confirm` に戻す、
  error message **出さない** (L52-56)。
- それ以外の reject (`ClerkAPIResponseError` / network 等) → **「失敗」** 扱い:
  `console.error` (L59) + phase `error` + error message 表示
  (staging は `err.message` 露出、 prod は汎用文言、 L60-67)。

### 3.4 `user.delete()` が Clerk 側で実行すること

- Clerk client SDK が `POST <frontend-api>.clerk.accounts.dev/v1/me?_method=DELETE`
  を発行 (lesson §1 の DevTools trace で確定)。
- API success = **その時点で Clerk 側 user は削除済**。

### 3.5 Clerk 削除完了 と webhook 配信 の時間差

- `user.delete()` の Promise が resolve した時点で Clerk user は既に削除済。
- `user.deleted` webhook は **その後に非同期で発火** (Svix 経由)。 Clerk 公式:
  「配信は通常速いが、 即時 / 必ず配信される保証はない」。
- client は webhook を待たず、 代わりに `/api/me/deletion-status` を polling
  (§7) して DB 伝播を確認する。
- → 時系列: `user.delete()` resolve (Clerk user 削除済) → [非同期・遅延] →
  Svix が `user.deleted` を webhook endpoint に配信 → `handleUserDeleted` 実行 →
  `UPDATE users SET deleted_at`。

### 3.6 client で `user.delete()` が失敗した場合の Clerk user 状態

- **reverification キャンセル**: delete request はそもそも完了せず → Clerk user
  **未削除**。
- **403 `session_reverification_required` (再認証前)**: 削除は実行されず 403 が
  返るだけ → Clerk user **未削除** (`useReverification` が modal で再認証 → retry)。
- **API error (4xx/5xx) が削除前に発生**: Clerk user **未削除**。
- 唯一の曖昧ケース: Clerk 側で削除が走った後に response が network で失われた場合 →
  Clerk user は削除済だが client は失敗を見る。 一般には **client 失敗 ≒ Clerk user
  未削除 (= webhook 未発火)**。

---

## 4. webhook 二重配信 / Clerk からの自動 retry

### 4.1 Clerk = Svix、 Svix の retry 仕様 (Clerk / Svix 公式)

- Clerk は webhook 配信に **Svix** を使用。「Svix が所定スケジュールで失敗 webhook を
  retry」。
- Svix デフォルト retry スケジュール (8 回、 約 32 時間):
  1. 即時 / 2. 5 秒 / 3. 5 分 / 4. 30 分 / 5. 2 時間 / 6. 5 時間 / 7. 10 時間 /
  8. 10 時間。
- **成功 = 15 秒以内に 2xx (200-299)**。 それ以外 (3xx redirect 含む) / timeout は
  **失敗 → retry**。
- 8 回枯渇 → message は `Failed` 化、 `message.attempt.exhausted` 運用 webhook 発火。
  さらに失敗が 5 日継続すると endpoint が自動 disable。
- 手動 recovery: Clerk Dashboard から失敗 message を replay 可能。

### 4.2 RecallMint handler の応答コード (`app/api/webhooks/clerk/route.ts`)

| 経路 | status | 行 |
|---|---|---|
| `CLERK_WEBHOOK_SECRET` 未設定 (prod) | 500 | L43 |
| `CLERK_WEBHOOK_SECRET` 未設定 (dev) | 200 | L45 |
| svix headers 欠落 | 400 | L52 |
| 署名検証失敗 | 400 | L66 |
| 重複 svix-id (idempotency skip) | **200** | L79 |
| handler 正常完了 | **200** | L88 |
| handler 内 throw (outer catch) | **200** | L99 |

→ 署名 / header が正当な webhook は **どんな処理結果でも 200**。

### 4.3 「常に 200」 が retry に与える影響

- Svix は非 2xx でしか retry しない。 RecallMint handler は処理が成功しても失敗
  (handler 内 throw) しても **200 を返す** (`route.ts:89-100` の outer catch が
  error を 200 に握り潰す)。 → **正常配信された message を Svix が retry することは
  実質ない**。
- これは意図的設計。 `route.ts:10` コメント:「200 強制 return (Clerk リトライ抑止、
  recovery は deletion_failures + 手動)」。 → handler エラーの recovery は Svix retry
  ではなく **app 内部 (`deletion_failures` + 手動 / 後段の retry 機構)** が担う。
- Svix retry が起きうる残存ケース:
  - handler が **15 秒超過** (Svix の success window)。 Vercel は 60s まで実行を
    続けるが、 Svix は 15s で timeout = 失敗扱い → retry。 → **大きい cascade
    DELETE + Stripe loop で 15s を超えると Svix が二重配信しうる**。
  - function が 200 を返す前に 500 / crash。
  - 400 (署名 / header 不正) — ただし retry しても直らない。

### 4.4 `clerk_events` による冪等性 (`route.ts:73-80`)

```ts
const inserted = await db
  .insert(clerkEvents)
  .values({ eventId: svixId, type: evt.type })
  .onConflictDoNothing({ target: clerkEvents.eventId })
  .returning({ id: clerkEvents.eventId })
if (inserted.length === 0) {
  return new Response('duplicate', { status: 200 })
}
```

- `clerk_events.event_id` (= svix-id) を PK とし `INSERT ... ON CONFLICT DO NOTHING
  RETURNING`。 同一 svix message の再配信 (= 同一 svix-id) は 0 行 returning →
  200 `"duplicate"`、 `handleEvent` 不到達。
- → §4.3 の「15s 超過で Svix が二重配信」 が起きても、 2 通目は同一 svix-id ゆえ
  ON CONFLICT で skip され、 `handleUserDeleted` は 1 回しか走らない。
- 並行到達 (1 通目処理中に retry 到達) でも、 `clerk_events` の PK unique 制約が
  INSERT を直列化し片方のみ成功 → DB レベルで dedup。
- 註: idempotency は **svix-id 単位**。 Clerk が同一 user に *別 svix-id* の
  `user.deleted` を 2 通出す病的ケースは gate されないが、 そもそも Clerk は通常
  それをしない + 操作自体が冪等 (前回調査 §1.6)。

---

## 5. Stripe 側の削除と DB の現状順序

### 5.1 `handleUserDeleted` の DB / Stripe 実行順 (`route.ts:122-191`)

1. **L130-134**: `UPDATE users SET deleted_at = now() ... RETURNING {id,
   stripeCustomerId}` — **単文 `await db.update(...)`、 transaction 外、 暗黙
   auto-commit**。
2. L142-149: `internalUserId` 不在 → `notifyOps` して return。
3. L150: `customerId` 不在 → return (Stripe loop に入らない)。
4. **L157-176**: `for await (sub of stripe.subscriptions.list({customer,
   status:'all'}))` → `CANCEL_TARGETS` のみ `cancelWithRetry(sub.id)`。

### 5.2 1 transaction か別 transaction か

- `UPDATE deleted_at` と Stripe loop は **同一 transaction ではない**。
  そもそも `handleUserDeleted` 内に `db.transaction()` は無い (§2.4)。
- `UPDATE` は実行時点で即 commit。 各 `cancelWithRetry` は独立した Stripe API call。

### 5.3 Stripe cancel 失敗時に `UPDATE deleted_at` は rollback されるか

- **されない**。 `UPDATE deleted_at` は Stripe loop 開始**前**に既に commit 済。
- per-sub cancel 失敗 → `recordFailure({kind:'cancel'})` (`route.ts:167-175`)、
  loop は継続。
- list 全体失敗 → `recordFailure({kind:'list'|'customer_missing'})`
  (`route.ts:177-190`)。
- どちらも `deleted_at` には触れない。

### 5.4 現状は forward-only + record-failure か

- **そう**。 `deleted_at` は set されたまま、 Stripe 失敗は `deletion_failures` に
  記録 + `notifyOps` で通知、 rollback / 取り消しは一切なし。 `route.ts:10` コメント
  「recovery は deletion_failures + 手動」 と一致。

---

## 6. `deletion_failures` への記録経路と Discord 通知

### 6.1 `recordFailure` (`route.ts:202-229`)

```ts
async function recordFailure(args: {
  internalUserId: string; clerkUserId: string; subId: string | null
  kind: 'list' | 'cancel' | 'customer_missing'; errorMessage: string
}): Promise<void> {
  const db = getDb()
  await db.insert(deletionFailures).values({          // L210-216 — DB audit 先
    userId: args.internalUserId, clerkId: args.clerkUserId,
    subId: args.subId, failureKind: args.kind, errorMessage: args.errorMessage,
  })
  await notifyOps('stripe sub cancel failure during deletion', {  // L220-228
    userId: args.internalUserId, clerkId: args.clerkUserId, subId: args.subId,
    kind: args.kind, error: args.errorMessage,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    timestamp: new Date().toISOString(),
  })
}
```

- 順序: **DB INSERT (audit = 真実) → notifyOps (人通知 = best-effort)**
  (`route.ts:194-196` コメント)。

### 6.2 記録される error context (kind 別)

| kind | sub_id | error_message の内容 | 行 |
|---|---|---|---|
| `cancel` | 当該 sub.id | `String(err)` (個別 cancel の例外) | L167-174 |
| `list` | `null` | `page fetch failed at offset N: <err>. Canceled before failure: [sub_a, ...]` | L179-182 |
| `customer_missing` | `null` | `String(err)` | L178-184 |

`list` の error_message は **失敗前に cancel 済の sub id 一覧** を含む
(admin が Stripe Dashboard で残 sub を grep するため、 `route.ts:153-155` コメント)。

### 6.3 Discord 通知の content フォーマット (`lib/ops.ts:18-58`)

- `notifyOps(subject, context)`。 content 組み立て (`lib/ops.ts:34`):
  ```
  **<subject>**
  ```json
  <JSON.stringify(context, replacer, 2)>
  ```
  ```
  (bold subject + JSON コードブロック、 2-space indent)。
- `makeReplacer` (`lib/ops.ts:95-107`): `Error` → `{name, message, stack}` に展開、
  循環参照 → `[Circular]`。
- 2000 char 制限対策で **1900 char で truncate** + `...[truncated]` (`lib/ops.ts:16,
  36-38`)。
- POST 先 = `OPS_DISCORD_WEBHOOK_URL`。 **未設定なら即 return (no-op)**
  (`lib/ops.ts:22-23`) — local / preview。

### 6.4 通知失敗時の挙動 — throw するか swallow するか

- **swallow する。 `notifyOps` は決して throw しない**。
  - fetch を try/catch で囲み、 失敗時は `logger.warn({event:'ops.notify.
    fetch_failed', err})` のみ (`lib/ops.ts:55-57`)。
  - Discord が非 2xx (204 以外) を返しても escalate しない (`lib/ops.ts:53-54`
    コメント:「notifyOps 自身の失敗が呼び出し元を巻き込んではならない」)。
  - `AbortSignal.timeout(3000)` で 3 秒上限 (`lib/ops.ts:45-51`)。 hang しても
    AbortError が上記 catch に落ちるだけ。
- → `recordFailure` 内で throw しうるのは `db.insert(deletionFailures)` のみ。
  その INSERT が throw した場合は `handleUserDeleted` → POST outer catch
  (`route.ts:89-100`) → `notifyWebhookError` → 200。

---

## 7. settings → deletion-status polling の挙動

### 7.1 `/api/me/deletion-status` route (`app/api/me/deletion-status/route.ts`)

- GET (L19-40): query param `userId`。 `USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/`
  (L15) に不一致 / 欠落 → **400 `{error:'invalid'}`** (L29-31)。
- `SELECT * FROM users WHERE clerk_id = userId` (L33-36) → `computeStatus(rows[0])`
  → 200 `{status}`。
- `Cache-Control: no-store` を 400 / 200 両方に付与 (L26)。 public endpoint
  (`auth()` 呼び出しなし、 L2 コメント)。

### 7.2 `computeStatus` の 4 分岐 (`route.ts:49-59`)

```ts
function computeStatus(row: User | undefined): DeletionStatus {
  if (!row) return 'not_found'
  if (row.deletedAt == null) return 'pending'
  if (row.subscriptionStatus === 'active' ||
      row.subscriptionStatus === 'past_due') return 'clerk_synced'
  return 'completed'
}
```

| status | 条件 |
|---|---|
| `not_found` | users 行なし |
| `pending` | `deleted_at IS NULL` (Clerk webhook 未着) |
| `clerk_synced` | `deleted_at` set かつ `subscription_status` ∈ {active, past_due} |
| `completed` | `deleted_at` set かつ `subscription_status` ∈ {canceled, NULL} |

### 7.3 `completed` を返す条件の含意

- `completed` = `deleted_at` set **かつ** Stripe sub が active/past_due でない。
- free user (`stripeCustomerId` なし → Stripe loop skip、 §5) は
  `subscription_status` が NULL のまま → `deleted_at` set 直後に即 `completed`。
- 課金 user: clerk webhook の `cancelWithRetry` が Stripe cancel を起動 → Stripe が
  別途 `customer.subscription.deleted` webhook を発火 → **Stripe webhook handler が
  `subscription_status='canceled'` に更新** して初めて `completed` になる。
  → `completed` 到達には Stripe webhook の往復が必要。
- **Stripe cancel が失敗** (`deletion_failures` に記録) した場合、
  `subscription_status` は active/past_due のまま → status は `clerk_synced` に
  **張り付く** (手動 recovery まで `completed` にならない) — trace 上の事実。

### 7.4 `not_found` の条件

- users 行が存在しない場合のみ。 RecallMint は users を **hard delete しない**
  (soft delete) ため、 一度作られた users 行は削除後も残る。 → 通常の削除フローでは
  `not_found` は出ず、 `pending → clerk_synced/completed` と遷移する。
- `not_found` が出るのは「users 行が一度も作られていない」 (user.created webhook
  race 等) ケース (`route.ts:43` コメント)。

### 7.5 polling と 30 回 fallback (`delete-button.tsx:74-117`)

- `POLL_INTERVAL_MS = 1000` / `POLL_MAX_ATTEMPTS = 30` (L13-14)。
- 1 秒間隔で `/api/me/deletion-status?userId=<clerkId>` を fetch (L96-99)。
- `status === 'completed' || 'not_found'` → `clearInterval` +
  `window.location.replace('/sign-out-deleted')` (L102-105)。
- **30 回経過しても `completed` 未到達** → L89-93: `clearInterval` +
  `window.location.replace('/sign-out-deleted')` を **強制実行**
  (コメント「zombie net で吸収」)。 → UI は最大 30 秒で必ず遷移、 stuck しない。
  遷移先で `/app` layout の `if (user.deletedAt) redirect('/sign-out-deleted')`
  (`app/(app)/app/layout.tsx:36`) が zombie net として機能。
- polling 中の非 ok HTTP response → skip して次 interval で再試行 (L100)。
  unmount 時は `controller.abort()` + flag で setState 抑止 (L111-116)。

### 7.6 test

- `/api/me/deletion-status` の route **test file は存在しない** (`ls
  app/api/me/deletion-status/` は `route.ts` のみ)。

---

## 8. 関連する既存 test

### 8.1 `app/api/webhooks/clerk/route.test.ts` (280 行、 7 ケース)

`describe('Clerk webhook user.deleted (Webhook 駆動再設計)')`:

| # | ケース | 行 |
|---|---|---|
| 1 | 正常系: clerk_events INSERT → deletedAt set → Stripe cancel ×N → 200 | L97 |
| 2 | users 未同期 (UPDATE 0 row): notifyOps + Stripe loop 不到達 + 200 | L123 |
| 3 | 重複 svix-id (idempotency skip): 200 "duplicate" | L147 |
| 4 | 個別 cancel 失敗: deletion_failures + notifyOps を per-sub で呼び loop 継続 | L161 |
| 5 | list 失敗 (customer_missing): kind=customer_missing で recordFailure | L188 |
| 6 | outer catch (handler 内 throw): notifyWebhookError + 200 swallow | L213 |
| 7 | page-level partial 失敗: canceledIds + offset を error_message に詰める | L255 |

### 8.2 既存カバレッジ (調査項目 8 への即答)

- **Stripe cancel 失敗**: ✓ カバー済 (ケース 4 個別 / 5 customer_missing / 7
  page-level)。 `cancelWithRetry` 単体も `lib/stripe.test.ts:116-163` で 3 件。
- **DB error**: △ 部分的。 ケース 6 が「`db.insert` が throw」 (users INSERT) で
  **outer catch 経路**を検証。 ただし `UPDATE users SET deletedAt` 自体の throw、
  `deletion_failures` INSERT の throw を直接検証する test は **無い**。
- **Clerk webhook 二重配信**: ✓ カバー済 (ケース 3、 idempotency skip)。
- **子データ削除**: ✗ 無し (機能未実装のため当然)。

### 8.3 子削除 transaction の test を書く際の流用パターン

- **clerk webhook test の mock 構造** (`route.test.ts:1-93`):
  - `vi.hoisted` で svix verify / db insert / db update / stripe iterator /
    cancelWithRetry / notifyOps / notifyWebhookError を mock。
  - `getDb()` mock は現状 **`{insert, update}` のみ** (`route.test.ts:29-34`)。
    子削除を入れるなら `delete` (および transaction を使うなら `transaction`) の
    追加が要る。
  - `chain()` helper (`route.test.ts:60-70`): Drizzle fluent chain を return-this で
    模倣、 `.values/.onConflictDoNothing/.returning/.set/.where` + `.then` 対応。
    DELETE は `db.delete(table).where(...)` なので `.where` は既にあるが、
    `getDb()` mock に `delete` method 追加が必要。
  - `mockReturnValueOnce` で insert/update の戻り値を呼び出し順に sequence。
  - `asyncIterFrom` (`route.test.ts:92-94`) で Stripe auto-pagination iterator を模倣。
- **transaction mock の流用パターン** (`process.test.ts:165-177`): `getDb()` mock が
  `transaction` を持ち、 渡された fn に tx (= db と同 API の object) を適用して
  実行する。 呼び出し順カウンタ (`localTxCallCount`) で「1 回目 = guard tx」 等を
  区別 (`process.test.ts:91, 173-177`)。 → 子削除を `db.transaction()` で囲む設計に
  なった場合、 この pattern が最も近い流用元。

以上。 本 doc は trace のみ。 設計判断・修正方針は claude.ai + OT が後段で決定する。
