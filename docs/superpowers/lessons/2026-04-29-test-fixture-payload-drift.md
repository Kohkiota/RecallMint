# Lesson: test fixture payload drift

> 外部 API の breaking change で payload 構造が変わったが、test fixture が古い
> 構造のまま残っていたため、handler の field 強引 cast が test では偶然動き、
> production では NULL 書込が起きていた件。Phase 1 D-1 で発覚。

---

## 起きたこと

`users.current_period_end` が production で全行 NULL になっていた。
原因の根本は、Stripe API の breaking change で `subscription.current_period_end`
の位置が変わっていたのに、handler 側コードと test fixture のどちらも追従していな
かったため。

### Stripe API breaking change

- API version `2025-03-31.basil` 以降、`subscription.current_period_end` は
  subscription resource の top-level から削除され、subscription item resource
  (`sub.items.data[N].current_period_end`) に移動
- 出典: `docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end`
- `stripe-node` v22 はこの API version を default で採用

### 現コードの実装

`app/api/webhooks/stripe/route.ts:126-130` で、SDK 型から削除された field を
強引 cast で読んでいた:

```ts
// current_period_end was removed from the Stripe SDK v22 type but is still
// present in webhook payloads. Cast through unknown to access it safely.
const rawPeriodEnd = (sub as unknown as Record<string, unknown>).current_period_end
const periodEnd = typeof rawPeriodEnd === 'number' ? new Date(rawPeriodEnd * 1000) : null
```

このコメントは事実誤認。API 2025-03-31.basil の payload には top-level に
`current_period_end` が存在しない。`rawPeriodEnd` 常に `undefined`、`typeof`
チェックで弾かれて `periodEnd = null` → DB に NULL 書込。

### test fixture が見逃した理由

`tests/integration/stripe-webhook.test.ts` の event payload は **top-level に
`current_period_end` を持たせていた**:

```ts
data: { object: { ..., current_period_end: 1730000000, ... } }
```

これだと handler の cast が偶然動き、test green になる。production payload
(2025-03-31.basil 構造) には top-level に存在しないので `null` が書かれる。
test と production で payload 構造が乖離していた。

---

## 教訓

### 直接的教訓

1. **外部 API 由来の field を強引 cast で読むな**。型から消えた field を
   `(x as unknown as Record<string, unknown>).field` で読むのは「型が合わなく
   なったが existence は保証されている」前提に立つ。breaking change で
   existence 自体が消えるとサイレントに NULL を書く
2. **test fixture は production payload の構造に揃える**。理想は webhook 受信
   時の payload を Stripe Dashboard / Vercel Function Logs から実物取得して
   fixture 化。最低限、SDK の type definition と整合する payload を書く

### 一般化教訓

3. **外部 API SDK の breaking change は SDK upgrade 時に必ず changelog を読む**。
   特に payload 構造変更は静かに通る (型エラーが出ない field を強引 cast で読む
   コードがあれば、コンパイルも test も通って production だけ壊れる)
4. **「型から消えた field を cast で読む」コメントを書く時は赤信号**。「なぜ
   型から消えたか」を SDK changelog で確認するべき。SDK の deprecation は
   payload からの削除を伴うことが多い (Stripe のように API version 同期で
   payload 構造そのものが変わる pattern も含む)

### 防御策の方向性

- `pnpm test` 通過は必要条件であって十分条件ではない。webhook handler のような
  外部 payload 受信箇所は、production の event を 1 つでも実物 capture して
  fixture に組み込む整備が long-term で要る (Phase 2 以降の課題)
- SDK upgrade PR の review checklist に「payload 構造変更系の changelog 確認」
  を含める運用が要る (Phase 2 以降の課題)

---

## References

- 公式 changelog: `docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end`
- 修正 spec: `docs/superpowers/specs/2026-04-29-cancel-at-period-end-and-current-period-end-bug.md`
- 関連現場ファイル:
  - `app/api/webhooks/stripe/route.ts` (修正前: line 126-130 の誤コメント + cast 読み)
  - `tests/integration/stripe-webhook.test.ts` (修正前: top-level に current_period_end)
  - `lib/stripe.ts` (API version pin 無し = SDK default = basil 系)
