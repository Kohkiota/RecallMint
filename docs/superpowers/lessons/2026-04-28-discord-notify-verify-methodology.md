# Discord notifyOps verify methodology

> **Source**: plan00 Phase 1 C (account deletion 再設計) / Plan B B2 verify cycle
> (2026-04-28)。failure path 専用 `notifyOps` の本番動作 verify における方法論を保存。

## 1. 背景

`notifyOps(subject, context)` (`lib/ops.ts`) は本番運用通知用の Discord webhook helper。
Phase 1 F (Sentry 導入) までの暫定実装で、Sentry 移行時は `Sentry.captureException(err, { extra: ctx })`
に signature を保ったまま差し替える前提。

Plan B B2 (Clerk webhook 駆動の account deletion) verify で「**Discord 通知が届かない**」事象が
発生。切り分けの結果、bug ではなく**設計通りに failure path 専用**であることが判明。本 lesson は
その verify 方法論を記録する。

## 2. Lesson: failure path 専用通知は自然 trigger が困難

### 2.1 設計意図

`notifyOps` は元々「**運用 escalation 通知**」(エラー / 失敗時の人通知) として設計され、
success path で呼ばれない。Sentry 互換 signature を保つため、subject + context で failure
通知だけを担う。

### 2.2 自然 trigger 困難の具体例 (Clerk webhook deletion handler)

`app/api/webhooks/clerk/route.ts` 内で `notifyOps` を呼ぶのは failure 経路 2 つのみ:

- **outer catch**: handler 全体の uncaught error
- **recordFailure**: Stripe sub cancel 失敗 (per-sub) / list 失敗 / `customer_missing`

これらを自然発火させる困難:

- **outer catch**: handler 内部の防御層 (DB transaction / 内側 try-catch) が大半を吸収するため、
  意図的 throw を仕込まないと到達しない
- **recordFailure**: Stripe `subscriptions.list` は **customer 削除済みでも空配列を返す**
  (error 投げない)。`customer_missing` (`StripeInvalidRequestError` + `resource_missing` code)
  trigger を狙って Stripe Dashboard で customer を先に削除しておいても、list 自体が空配列で完走
  するため `for await` ループが no-op で終わる

→ 本番で「自然な失敗」を起こすこと自体が稀、verify のためには別経路で発火させる必要がある。

## 3. Workaround: 一時 API route + curl での関数経由 verify

verify 専用の使い捨て API route を作り、`notifyOps()` を直接呼んで Discord 到達を確認、verify
完了後に削除する。

### 3.1 手順

1. `app/api/verify-ops/route.ts` を新規作成 (GET handler で `notifyOps('manual verify via API
   route', { ... })` を 1 回呼んで 200 return)
2. `pnpm dev` で `curl http://localhost:3000/api/verify-ops` を叩く
   - production verify したい場合は本番 URL に向けて叩く (Vercel env に
     `OPS_DISCORD_WEBHOOK_URL` 設定済みの状態)
3. Discord channel に **太字 subject + JSON code block format** のメッセージが届くことを確認
   - format が独特なので curl ベタ書き test message と判別可能
4. cleanup:
   - API route ファイル削除 (commit に残さない、§3.3 参照)
   - dev verify した場合は `.env.local` の `OPS_DISCORD_WEBHOOK_URL` を削除
     (preview / dev で誤発火防止)
   - Vercel production env はそのまま残す (本番運用に必要)

### 3.2 Next.js routing の注意

App Router で `_` prefix folder は **private 扱いで route 化されない**
(`app/api/_verify-ops` だと 404)。verify 用 throwaway route は `app/api/verify-ops` のような
plain な path で作る。

参考: https://nextjs.org/docs/app/getting-started/project-structure#private-folders

### 3.3 commit に残さない理由

verify route は機能 spec に含まれない probe。残すと:

- **security**: 誰でも Discord 通知を発火可能 (rate limit / quota 食い潰し)
- **maintenance**: 「これ何?」が増える、責務が曖昧

verify が終わったら同 session 内で削除する。

### 3.4 webhook handler の outer catch 経路 verify (Stripe trigger + Vercel Protection Bypass)

webhook handler 内 outer catch + `notifyWebhookError` 経由の Discord 通知が production / preview deploy で実機動作することを verify するには、 自然 trigger が困難 (handler 内部の防御層が大半吸収) のため、 **意図的 throw を verify branch に仕込んで preview deploy で外部 trigger** で発火させる:

1. verify 専用 branch (例: `e3-verify-throw`) を切り、 handler 頭に `throw new Error('verify: intentional throw')` を追加
2. Vercel preview deploy 後、 **Vercel Protection Bypass for Automation** (query string 経由) を有効化 (preview deploy への外部 webhook POST が認証なしで通る)
3. Stripe CLI で `stripe trigger <event-type>` (例: `customer.subscription.updated`) を host から発火
4. preview endpoint で intentional throw → outer catch → notifyWebhookError → Discord 着信を確認 (handler / eventId / eventType / error.* / environment / timestamp の payload shape も同時 verify)
5. verify 完了後 cleanup:
   - production webhook endpoint 再有効化 (verify 中は production endpoint を一時無効化していた、 Stripe trigger は全 active endpoint に同時配信のため preview と production で event_id 衝突 / DB 書込競合回避)
   - 一時 webhook endpoint (Stripe Dashboard で preview deploy 用に追加した方) 削除
   - Vercel preview env の WEBHOOK_SECRET 削除
   - Protection Bypass for Automation token 削除
   - verify branch 削除 (local + remote)

注意点:
- `stripe trigger` は **全 active endpoint に同時配信**、 verify 中の production endpoint 一時無効化が必須 (event 重複処理回避)
- Vercel Protection Bypass for Automation は preview deploy のデフォルト Vercel auth を bypass、 verify 完了で必ず削除 (token 残置で外部 access 可能化 risk)

## 4. 何を verify したと言えるか (役割分担)

関数経由 verify で確認できるのは:

- ✅ env (`OPS_DISCORD_WEBHOOK_URL`) が production scope に正しく設定されている
- ✅ `lib/ops.ts` の `notifyOps` 実装 (fetch / payload format / truncate) が動く
- ✅ Discord webhook URL が valid

確認できないのは:

- ❌ webhook handler の outer catch 経路が本当に `notifyOps` を呼ぶか
- ❌ `recordFailure` 経路が本当に `notifyOps` を呼ぶか
- → 後者は **unit test で coverage** (Plan B B2 の 5 ケースのうち「個別 cancel 失敗 / list 失敗
  / customer_missing」3 ケース)

つまり: 関数経由 verify = **infra 層の到達性確認**、unit test = **caller 経路の coverage**、
合わせて初めて failure path 全体を担保。

## 5. plan00 case study への参照

- Plan B B2 (本 lesson の trigger):
  `docs/superpowers/plans/2026-04-27-account-deletion-B-webhook-driven.md`
- Spec §6.3 / §10.1 / §10.2 (notifyOps 設計意図 + verify フロー):
  `docs/superpowers/specs/2026-04-27-account-deletion-redesign.md`
- 実装: `lib/ops.ts` / `instrumentation.ts` / `app/api/webhooks/clerk/route.ts`

## 6. 関連リンク

### Stripe
- [List subscriptions](https://stripe.com/docs/api/subscriptions/list) — customer 削除でも空配列
  return の挙動
- [Errors](https://stripe.com/docs/api/errors) — `StripeInvalidRequestError` + `resource_missing` code

### Next.js
- [Project Structure: Private folders](https://nextjs.org/docs/app/getting-started/project-structure#private-folders)
- [instrumentation.ts onRequestError](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation)

### Discord
- [Webhook resource](https://discord.com/developers/docs/resources/webhook) — incoming webhook payload format
