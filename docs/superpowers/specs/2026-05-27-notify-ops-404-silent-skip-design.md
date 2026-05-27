# notifyOps 404 silent skip 設計 (design spec)

- 起票日: 2026-05-27
- 種別: design spec (cache-fix roadmap ④-4)
- 関連 roadmap: `docs/cache-fix-roadmap.md` §④-4
- 状態: OT 承認済 (brief + 設計判断 3 点 / test plan / YAGNI 確定)

---

## 1. 結論サマリ

`lib/auth/clerk-metadata.ts` の `syncClerkPublicMetadata` catch 内で Clerk
Backend API の 404 のみ silent skip し、 Discord 通知のノイズを削減する。
404 以外の挙動は無変更。 戻り値は 404 silent skip 時 `ok: true` で、 caller の
semantics を「user 不在 = 同期不要 = success」 に揃える。 console.debug 1 行
で軽量観測性を維持。

---

## 2. 背景

`lib/auth/clerk-metadata.ts:38-51` の try/catch は **error 区別なし** で全て
`ok:false + notifyOps` を fire している。 削除済 user に対する Stripe webhook
後着 (e.g. `customer.subscription.updated` の post-deletion 配信) や user.deleted
webhook 処理中の race で Clerk Backend API が 404 を返すケースが定常的に発生し、
Discord に「異常ではない 404」 が継続通知され、 真の障害通知が埋没する。

caller (= notifyOps fire 元の経路):

- Stripe webhook 3 箇所: `app/api/webhooks/stripe/route.ts:230 / 260 / 294`
- Clerk webhook 1 箇所: `app/api/webhooks/clerk/route.ts:124` (user.created
  conflict path)
- backfill script: `scripts/backfill-clerk-metadata.ts:91` (`result.ok` を OK /
  failed counter に分岐)

---

## 3. Scope

### In

- `lib/auth/clerk-metadata.ts` の catch 内に Clerk 404 判定 + silent return
- 既存 docstring「失敗ポリシ」 section の 404 例外条項追記
- `lib/auth/clerk-metadata.test.ts` に 404 silent skip case 1 件追加

### Out (YAGNI)

- 他 Clerk API 呼出箇所への横展開 (brief 明示「本 task は clerk-metadata.ts のみ」)
- `notifyOps` 自体の改修 (本 task は呼出側 filter のみ)
- Retry / backoff / 401 / 403 / その他 status の handling 変更
- 410 / 422 等「user 不在」 を間接的に示す他 status の silent skip 拡張

---

## 4. 設計判断

| # | 判断項目 | 採用 | 根拠 |
|---|---|---|---|
| 1 | 404 silent skip 時の戻り値 (`ok`) | **`true`** | 「user 不在 = 同期対象不在 = end state 一致 = success」 の semantics。 backfill script の OK counter (`scripts/backfill-clerk-metadata.ts:91`) で「削除済 user」 を OK 側に振る方が実態整合 (= 既に削除済なので backfill 不要 = OK) |
| 2 | 404 時のログ | **`console.debug` 1 行** | 将来「想定外 404 が継続発生していないか」 を Vercel function logs で確認可能にしておく軽量観測性。 Discord 通知抑制の趣旨と矛盾せず、 console.debug は default log level (info+) に出ないため通常運用ノイズにもならない |
| 3 | 404 以外の挙動 | **無変更** | 5xx / network / その他 4xx は従来通り `notifyOps + ok:false`。 brief 明示の「他 status は従来通り」 と整合 |

---

## 5. 実装イメージ

```ts
import { isClerkAPIResponseError } from '@clerk/nextjs/errors'

// ...
  try {
    const client = await clerkClient()
    await client.users.updateUserMetadata(clerkId, { publicMetadata: metadata })
    return { ok: true }
  } catch (err) {
    if (isClerkAPIResponseError(err) && err.status === 404) {
      console.debug('clerk-metadata: user not found, skipped silently', {
        clerkId,
      })
      return { ok: true }
    }
    await notifyOps('clerk publicMetadata sync failed', { /* 既存 payload */ })
    return { ok: false }
  }
```

- `isClerkAPIResponseError` は `@clerk/nextjs/errors` から import (公式 pattern、
  `app/(app)/app/settings/delete-button.tsx:7` で既使用、 Context7 確認済)
- `err.status === 404` は Clerk SDK 標準の `ClerkAPIResponseError.status` (number)
- `console.debug` の payload key は `clerkId` (function 引数の命名と一致)

---

## 6. Test plan

### 既存 5 case を維持 (改修不要)

`lib/auth/clerk-metadata.test.ts`:

1. dbUserId + plan 渡しで updateUserMetadata 1 回呼出、 ok:true
2. plan のみで publicMetadata に plan のみ乗る
3. dbUserId のみで publicMetadata に dbUserId のみ乗る
4. 両方未指定で API 呼ばず ok:true (no-op)
5. Clerk API throw (`new Error('Clerk 5xx')`) → notifyOps fire + ok:false +
   resolve (throw しない)
   → 5xx generic Error は新 404 path に乗らないため、 本変更後も既存挙動を verify

### 新規 1 case を追加

6. **404 silent skip**: `ClerkAPIResponseError` (status=404) を rejected value
   に注入 → notifyOps **呼ばれず** + `ok:true` を返す + console.debug 1 回呼出 (or
   呼出有無の検証は spy 不要なら省略可、 後述)

#### `ClerkAPIResponseError` 構築方法

`@clerk/nextjs/errors` から import した `ClerkAPIResponseError` を test で
直接 instantiate する。 constructor signature (Context7 + repo node_modules 確認):

```
new ClerkAPIResponseError(message, { data, status, clerkTraceId, retryAfter })
```

例:

```ts
import { ClerkAPIResponseError } from '@clerk/nextjs/errors'
const err = new ClerkAPIResponseError('Not Found', {
  data: [],
  status: 404,
  clerkTraceId: 'test-trace',
})
mockUpdateUserMetadata.mockRejectedValueOnce(err)
```

#### 新規 case の assertion (確定)

新規 case は以下 3 点を verify する:

1. `mockNotifyOps` が **呼ばれない** (silent skip の中核)
2. 戻り値が `{ ok: true }`
3. `console.debug` が 1 回呼出され、 第 1 引数に `'user not found'` を含む
   (`vi.spyOn(console, 'debug')` で spy、 将来うっかり console.debug を消した
   regression を防ぐ軽量 guard)

spy は `beforeEach` で setup + `afterEach` で restore する標準パターン。

---

## 7. 完了条件

- `pnpm exec tsc --noEmit` clean
- `pnpm test -- --run` 全 pass (既存 5 case + 新規 1 case = 6 case)
- `superpowers:requesting-code-review` skill canonical 経由 review:
  Critical 0 / Important 0
- commit message に `[reviewed]` tag

---

## 8. 非該当 (将来 task)

- Clerk 401 / 403 (権限 / token) の handling: 別 task。 401 は middleware で
  既に guard されている前提だが、 webhook handler で発生し得るか別途調査要
- 他 Clerk API 呼出箇所 (e.g. `clerkClient.users.deleteUser` / `getUser` /
  `sessions.revokeSession` 等) の 404 handling 整合性: 別 task で棚卸し
- Vercel function logs での 404 発生頻度の dashboard 化: 別 task (本 task は
  console.debug 経由で raw log には残るが、 集計は別途)
