# Clerk JWT template setup (dev / prod 両方) — 2026-05-26

- 設定日: 2026-05-26
- 設定者: OT (komail9server@gmail.com、 RecallMint 所有者)
- 適用 environment: development (`recall-mint-dev`) + production (`recall-mint`)
- 関連 commit: `f02de92` 以降 (= Clerk publicMetadata sync 配線 + JWT 読込基盤、 後続 C2 commit で page.tsx 経由 read 開始)
- 関連 file: `lib/auth/clerk-metadata.ts` / `types/clerk.d.ts` / `lib/auth/ensure-user.ts` (C2 で `getAuthContext()` 追加予定)

## 目的

`/app` 配下の全 navigation で発生していた `getCurrentUser()` 経由の `users` SELECT (Neon、 cold 時 +2s) を撤去するため、 user の identity / 課金状態を Clerk JWT に乗せて server SELECT 不要化する。 cold start 多発の stg で観測した 「`/app` doc stream 1.7s + post-doc 並走 API 各 2s」 問題の構造的対策。

詳細計測: `docs/superpowers/sessions/2026-05-26-stg-perf-measurement-pre-local-first.md` §A2 / §A〜D

## Clerk Dashboard 設定場所

- URL: `https://dashboard.clerk.com/`
- Path: 該当 application を選択 → **Configure** → **Sessions** → **Customize session token** (= "session" という名前の default template の編集経路)
- 注意: Clerk v6 では default session token は dashboard 上 「Customize session token」 UI から編集する。 別 template (例: 名前付き JWT template) を作っても `auth().sessionClaims` には反映されず、 `getToken({ template: 'name' })` 呼出時のみ使われる。 本 setup は **session token 自体を customize** している前提

## 設定した claim 一覧

| Claim key | 値 (Clerk template DSL) | 型 (RecallMint 側) | 用途 |
|---|---|---|---|
| `dbUserId` | `"{{user.public_metadata.dbUserId}}"` | `string` (UUID) | `users.id` 参照。 page.tsx / API route で server SELECT を skip して owner-scoped query に直接使う |
| `plan` | `"{{user.public_metadata.plan}}"` | `'free' \| 'standard' \| 'pro'` | plan-based authz (`limitsFor(plan)` 等)、 dashboard CTA 切替 |

### JWT に乗せない field (= 当面 server SELECT 残置)

| Field | 用途 | 影響 page |
|---|---|---|
| `billingInterval` | 「Pro 年額」 等の最上位判定 | `/app/page.tsx` (upgrade CTA hide) / `/app/settings` / `/app/upgrade` |
| `cancelAt` | 解約予約バナー / settings 「解約予約中」 ラベル | `/app/settings` |
| `subscriptionStatus` | settings ステータス表示 | `/app/settings` |

これらが必要な page は本 sprint では `getCurrentUser()` 経由で users 行を直接読む既存経路を維持する (= layout / settings / upgrade / `/app` 本体は SELECT 残置)。 sprint で switch 対象になるのは「user.id だけ」 か「user.id + plan だけ」 を使う page (`/app/exams` / `/app/exams/[id]` / `/app/study/smart` / `/app/upload` / `/app/cards/[id]`)。

将来 billingInterval / cancelAt も JWT 経由化したい場合は § 「将来フィールドを追加する手順」 を参照。

## 書込み path (server → Clerk publicMetadata)

`lib/auth/clerk-metadata.ts` の `syncClerkPublicMetadata()` 経由で以下の場面で書込:

1. **`user.created` webhook** (`app/api/webhooks/clerk/route.ts`): 新規 INSERT 成立時 → `{dbUserId, plan: 'free'}`
2. **Stripe `checkout.session.completed`** (`app/api/webhooks/stripe/route.ts`): Step 2 UPDATE matched 時 → `{plan}`
3. **Stripe `customer.subscription.created/.updated`**: UPDATE matched 時 → `{plan}`
4. **Stripe `customer.subscription.deleted`**: UPDATE matched 時 → `{plan: 'free'}`

`dbUserId` は user.created で 1 度だけ書込み、 以降は Clerk top-level merge 仕様 (PATCH semantic) で plan のみ送る webhook では温存される。

書込み失敗時 (Clerk API 5xx 等) は `notifyOps` で観測性確保のみ、 throw しない (webhook の「常に 200」 不変条件と整合)。 stale な JWT plan は次回 sync event で reconcile。

## 読込 path (client / server → JWT)

C2 commit で追加予定の `getAuthContext()` 経由 (`lib/auth/ensure-user.ts`):

```ts
const { userId, sessionClaims } = await auth()
const dbUserId = sessionClaims?.dbUserId       // → users.id (UUID)
const plan = sessionClaims?.plan               // → 'free' | 'standard' | 'pro'
```

undefined 時 (= JWT template 未浸透 / 旧セッション / 設定漏れ) は `getCurrentUser()` への fallback で degrade。

## 反映タイミング (動作上の注意)

- **Clerk publicMetadata update から JWT への反映**: 既存セッションの JWT は **token refresh まで stale**。 Clerk の token refresh interval は通常 60 秒、 `clerk.session.touch()` 等で強制 refresh も可。 これは subscription 状態変化直後 (= upgrade button 押下 → 即遷移) で stale plan を表示する可能性を意味する
- **対策**: critical な authz 判定 (例: 課金 gate) には JWT plan は信頼しない。 Stripe webhook 経由の DB 値 (= `getCurrentUser().plan`) を権威とし、 JWT は速度最適化のための snapshot 扱いとする (= read-mostly 経路でのみ使う)

## 将来フィールドを追加する手順

1. `lib/db/schema.ts` の users column 追加 (migration 生成)
2. `lib/auth/clerk-metadata.ts` の `ClerkMetadataInput` 型を拡張、 `syncClerkPublicMetadata()` 実装で metadata に key 追加
3. webhook handler (Clerk / Stripe) の sync 呼出に新 field を pass
4. `types/clerk.d.ts` の `CustomJwtSessionClaims` interface に field 追加
5. **Clerk Dashboard で session template に新 claim 追加** (dev / prod 両方、 OT が手動で実施)
   - Dashboard → Configure → Sessions → Customize session token → JSON edit
   - 既存値 (本 sprint 時点): `{"dbUserId": "{{user.public_metadata.dbUserId}}", "plan": "{{user.public_metadata.plan}}"}`
6. backfill script (`scripts/backfill-clerk-metadata.ts`、 C3 commit) で既存 user に新 field を埋め込み
7. C2 で page.tsx 切替経路に新 field を追加

順番に従わないと「fallback path に常時落ちる」 / 「JWT claim が undefined のまま」 等の degraded mode に陥る (= server SELECT 撤去効果が消える)。

## 動作確認 path (smoke)

1. **新規 sign-up**: Clerk Dashboard で対象 user の `publicMetadata` に `dbUserId` (UUID) と `plan: "free"` が乗ること
2. **Stripe Checkout 完了 (standard/pro)**: 同 user の `publicMetadata.plan` が `"standard"` / `"pro"` に更新されること。 `dbUserId` は touch されず温存
3. **Customer Portal 解約**: `publicMetadata.plan` が `"free"` に reset
4. **JWT 中身確認** (DevTools console から):
   ```js
   await window.Clerk?.session?.getToken().then(t =>
     JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
   )
   ```
   sessionClaims に `dbUserId` / `plan` が乗っていれば OK。 乗っていなければ Dashboard session template 設定漏れの疑い

## 既知の制約 / 観測点

- **JWT cache window** (Clerk JWT verification cache、 通常 60s): `user.delete()` 後も最大 60s は session が valid と判定される (= layout の deletedAt check は撤去せず維持、 詳細 lesson `2026-04-30-clerk-env-validation-environment-dependent.md` 系)
- **Clerk publicMetadata の top-level merge 仕様**: `updateUserMetadata({ publicMetadata: { plan } })` は他 key を温存する (PATCH semantic)。 これに依存して plan のみ送って `dbUserId` を維持している (helper 内 comment 参照)
- **template 未設定 / 旧セッション持越し時の degraded mode**: `getAuthContext()` の dbUserId undefined → `getCurrentUser()` fallback。 本 doc 設定後 60 秒以内に既存 session を refresh しないと一時的に fallback path 経由になる
