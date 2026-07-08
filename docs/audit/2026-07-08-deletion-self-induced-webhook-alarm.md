# アカウント削除 → 自己誘発 subscription.deleted webhook の偽アラート(fact-finding・実装なし)

- 日付: 2026-07-08 / branch `develop` / 事象発生 2026-07-07T15:21Z(stg/preview)
- 事象: アカウント削除は DB 上正常完了(soft-delete 済)なのに、Discord に `eventType=customer.subscription.deleted / customerId=cus_UqHI32nb6n0Maa / environment=preview` のエラーレポートが届いた。
- 判定: **根本原因特定済・構造的(paid user の退会のたびに毎回発生)・実害は Discord 偽アラートのみ(DB 不整合なし)**。

## 事象の流れ(コード + 実 DB タイムスタンプで確定)

1. **Clerk user.deleted → handleUserDeleted**(`lib/clerk/handle-clerk-event.ts:69`): SELECT user → **Stripe cancel ループ**(:100-139、`cancelWithRetry` = `stripe.subscriptions.cancel` 即時 cancel、`lib/stripe/client.ts:88-96`、対象 = active/trialing/past_due)→ **DB tx**: users soft-delete + GDPR PII scrub(`deletedAt=now, email=null, clerkId=null`、:178-181)+ 子 10 テーブル物理削除。**`stripe_customer_id` は意図的に保持**(cus_xxx 単体で個人特定不能・correlation key、:163-166 コメント)。ここまで正常(15:21:01.851 に deleted_at)。
2. **即時 cancel が `customer.subscription.deleted` を発火**。Stripe 公式(docs.stripe.com/api/events/types): "Occurs whenever a customer's subscription ends" — `DELETE /v1/subscriptions/:id`(= `subscriptions.cancel`)は即時終了なので必ず発火する。**削除フローの正常な副産物**であり異常ではない。
3. **webhook 後着**(15:21:02.665、tx の約 0.8 秒後): `handle-stripe-event.ts:242-277` の `.deleted` handler が `UPDATE users ... WHERE stripeCustomerId = customerId RETURNING clerkId` を実行。**行は存在する**(soft-delete + customer id 保持)ため **1 行 match・UPDATE 成功**(plan='free' / subscriptionStatus='canceled' / stripeSubscriptionId=null / 予約 3 列 null / updatedAt bump ← 観測された 15:21:02.665 の正体)。
4. **偽アラートの分岐**: RETURNING の `clerkId` は scrub 済みで **NULL**。`handle-stripe-event.ts:263` の `const clerkId = updated?.[0]?.clerkId` が falsy → else 分岐(:268-276)→ `notifyOps('stripe sub event for unlinked customer')` = Discord のエラーレポート。payload(eventId / customerId / eventType / environment / timestamp)が受信内容と一致。

## 根本原因

**`clerkId` 非 null を「UPDATE が行に match した」ことの代用(proxy)にしている**(`handle-stripe-event.ts:263`)。この条件は「行が本当に無い(整合崩壊)」と「行は有るが GDPR scrub で clerkId=NULL(削除済 user への自己誘発 webhook = 正常)」を**区別できない**。else 分岐のコメント(:268)は「row が消えている整合崩壊 = OT 介入対象・recover 経路なし」を想定して書かれており、削除カスケードが自分で誘発する webhook を設計が想定していなかった。

## 毎回か / 特有か

**構造的・毎回**。cancel 対象 subscription(active/trialing/past_due)を持つ user の退会ごとに必ず起きる:

- handler は Stripe cancel を **DB tx の前**に実行する(:97-99 コメントの設計)が、webhook 配送(〜秒)は local tx(〜ms)より遅いため、「scrub 済み行に webhook 後着」が通常順序。
- 逆順 race(webhook が tx より先着)の場合は clerkId がまだ有り → 正常 path → `syncClerkPublicMetadata` が Clerk 404 → **silent skip 設計済**(`lib/auth/clerk-metadata.ts` 失敗ポリシ「削除済 user 宛 Stripe webhook 後着」を明示的に想定)→ 無害・無通知。つまり**後着(通常)側だけが未想定**。
- **env 非依存**(VERCEL_ENV はキー選択のみ・経路共通)。**prod でも paid user 退会のたびに同じ偽アラートが出る**。
- 同型の proxy 誤りは `.created/.updated` 分岐(:227-239)にも存在する — scrub 済み行への subscription event は同様に 'unlinked customer' を誤発火しうる(本事象では `.deleted` のみ観測)。

## 実害

**DB 不整合なし・実害は Discord ノイズのみ**。webhook の UPDATE は soft-delete 行に「解約の終端状態」を書いており、むしろ正しい方向(handleUserDeleted 自体は subscription 系列を触らないため、観測された `subscription_status=canceled` はこの webhook が書いたもの)。害は「OT 介入対象」と定義された重いアラートが正常フローで毎回鳴ること = alert 疲れ・本物の整合崩壊アラートの信頼低下。

## fix の想定

- **独立 fix 可・S(〜10-20 行 + test)**: `.deleted`(および同型の `.updated`)の判定を「行が本当に無い」場合に限定する。実装案 = RETURNING に `deletedAt` を追加し、① match 0 行 → 従来どおり notifyOps(真の整合崩壊)② match 有 + `deletedAt` 非 null(+ clerkId null)→ 削除済 user への自己誘発 webhook として**無害 skip**(metadata sync せず・通知せず。観測性が要るなら debug log 1 行)。
- **F1 Subscription aggregate 同梱も自然**(webhook⇄DB 整合領域で ④ と同じ設計文脈)だが、本件は「毎回鳴る運用ノイズ」で fix が極小のため、**グループ A への追加(A-4)or 独立 chore が割に合う**(scope 追加は OT 判断)。

## 参照

- 削除フロー: `lib/clerk/handle-clerk-event.ts:69-203`(cancel ループ :100-139 / soft-delete tx :175-202)
- 偽アラート分岐: `lib/stripe/handle-stripe-event.ts:242-277`(判定 :263 / notifyOps :269-275)
- 逆順 race の無害化(既設計): `lib/auth/clerk-metadata.ts` 404 silent skip(spec: `docs/superpowers/specs/2026-05-27-notify-ops-404-silent-skip-design.md`)
- Stripe 公式: customer.subscription.deleted = "Occurs whenever a customer's subscription ends"(api/events/types・immediate cancel で発火)
- 関連: `docs/audit/2026-07-08-server-invariant-verification.md` §④(同じ Stripe⇄DB webhook 領域・F1 の入力)
