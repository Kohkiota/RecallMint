# Lesson: Stripe deprecation と billing mode 差異の早期検出

> 外部 API のフィールドが SDK 型に残っていても deprecated されており、かつ
> account の billing mode で意味が変わるため、設計時に schema へ反映してしまう
> と本番で機能しない、という Phase 1 D-1 で発覚した教訓。

---

## 起きたこと

Phase 1 D-1 で `users.cancel_at_period_end` (boolean NOT NULL DEFAULT false)
カラムを追加し、Stripe webhook handler で `sub.cancel_at_period_end` を素直
反映する仕様で実装した。code-reviewer pass / 12 test pass / production deploy
まで通った。

本番 verify で発覚: 解約予約操作後に DB の `cancel_at_period_end` が常に
false のまま、UI の解約予約 badge が表示されない。

### 根本原因

Stripe API `2025-03-31.basil` で `cancel_at_period_end` parameter は
**deprecated**:

> "Integrations currently using the deprecated `cancel_at_period_end`
> parameter should switch to using the new `cancel_at` parameter with the
> `min_period_end` enum value."
> — `docs.stripe.com/changelog/basil/2025-05-28/cancel-at-enums`

加えて Customer Portal cancellations の正しい監視方法は account の billing
mode で異なる:

> "For **flexible billing mode**, check that `cancel_at` is not `null`;
> for classic billing mode, check that `cancel_at_period_end` is `true`."
> — `docs.stripe.com/customer-management/integrate-customer-portal`

production の plan00 Stripe account は **flexible billing mode** で、
payload `billing_mode.type: "flexible"` (OT が Stripe Dashboard で実物確認)。
flexible mode では `cancel_at_period_end` は常に false、`cancel_at != null` が
解約予約中の signal。

### SDK 型から「読めない」だけだった

stripe-node v22 は `cancel_at_period_end: boolean` を Subscription type 上に
依然定義している (deprecation 移行期の互換維持)。TypeScript strict でも
`sub.cancel_at_period_end` は何の警告もなくアクセスできる、ただ payload は
常に `false`。「型が存在 = 機能する」前提が成立しないケース。

## 教訓

### 1. 外部 API 統合時、SDK 型が残っていても deprecation を changelog で確認する

SDK 型に field が定義されていても **deprecated** 状態のことがある。SDK は
互換維持のため deprecated field を型から即削除しない (Stripe v22 の
`cancel_at_period_end` がこれに該当)。schema / handler が参照する field は、
最低でも以下を確認:

- 公式 changelog (Stripe なら `docs.stripe.com/changelog/<basil>/...`) で
  当該 field の deprecation 状況
- 同じ field の代替 (今回なら `cancel_at` enum) の有無
- billing mode / API version 等の context 依存性

「SDK 型に存在する」は必要条件であって十分条件ではない。

### 2. schema 設計を最終決定する前に、production の実際の API mode を確認する

Stripe / Auth0 / Slack 等、account 単位で機能 set / billing mode / API version
が変わる外部サービスでは、production account の実体を確認してから schema を
決める必要がある。今回は「flexible billing mode が default」という事実を確認
していなかったため、`cancel_at_period_end` boolean column を schema に作って
しまった。

具体行動指針:
- 設計時、Stripe Dashboard / 同等管理画面で account settings を確認
- production / staging / test account の billing mode が一致しているか確認
  (test account が flexible で production が classic、等の差異もありうる)
- 確認できない場合、schema を「Stripe payload を素直反映」前提で設計せず、
  汎化された field (今回なら `cancel_at` 一元化) で受ける

### 3. spec 改訂は deprecation 確証を取ってから決める

本番 verify で「素直反映が機能しない」と判明した時、初動の対応案は 2 つあった:
- Option A: handler で `cancel_at_period_end = sub.cancel_at != null` を派生
  (schema 維持)
- Option B: `cancel_at_period_end` カラム廃止、`cancel_at` 一元化 (schema 変更)

Option A は短期 fix で動くが、deprecated field を派生する設計が長期保守で破綻。
公式 docs を確証ベースで読み込んでから Option B (根治) を OT 判断で採用。

教訓: 仕様の解釈揺れが発覚した時、**公式 docs / production payload 実物 / OT
の方針判断** の 3 点を揃えてから方針確定。場当たり修正で進めない。

### 4. 既存 lesson との関連

本 lesson は同 sprint で記録した
[`2026-04-29-test-fixture-payload-drift.md`](./2026-04-29-test-fixture-payload-drift.md)
と関連する。両者は **「外部 API 統合時に production payload を確認しない結果、
test green でも production で機能しない」** という共通テーマ:

- 前 lesson: SDK 型から消えた field を強引 cast で読むコードが、test fixture
  でも top-level に書いていたため偶然動いていたが production で NULL 書込
- 本 lesson: SDK 型に残っている field を素直反映するコードが、production の
  flexible billing mode では機能しない (常に false)

両者を防ぐ運用は同じ:
- production payload を 1 つでも実物 capture して fixture に組み込む
- SDK upgrade / 外部 API integration 時に **changelog + account-specific config**
  両方を読む
- 設計判断は確証ベース、SDK 型 / 過去ドキュメント / 推測で進めない

## References

- 公式 changelog (cancel_at deprecation): `docs.stripe.com/changelog/basil/2025-05-28/cancel-at-enums`
- 公式 integration guide (Customer Portal billing mode): `docs.stripe.com/customer-management/integrate-customer-portal`
- 関連 spec: `docs/superpowers/specs/2026-04-29-cancel-at-period-end-and-current-period-end-bug.md` §5.2 / §9
- 関連 lesson: `docs/superpowers/lessons/2026-04-29-test-fixture-payload-drift.md`
- 修正 commit: `20695b2 feat(db): drop cancel_at_period_end column (deprecated by Stripe)` /
  `54b006f fix(stripe-webhook): drop cancel_at_period_end sync, derive from cancel_at`
