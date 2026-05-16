# Clerk env validation should be environment-dependent

> **Source**: plan00 Phase 1 E-2 (Clerk production keys 切替) で得た知見。Clerk + Next.js + Vercel プロジェクトで再利用。

## 1. 背景

plan00 Phase 1 E-2 で Clerk dev instance → production instance への切替を Vercel production env に対して実施した際、deploy build error 発生:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_test_.
Live keys (pk_live_) are forbidden.
```

原因: `lib/clerk.ts` の env validation が `pk_test_` / `sk_test_` を**完全必須** (live keys 全拒否) にしていた。これは dev 段階での live key 誤投入を防ぐ guard として導入されたが、本番 production instance への切替時にこの guard 自体が deploy 阻害となった。

## 2. Lessons Learned

### 2.1 dev 誤用防止の env guard は production 切替時に逆に障害になる

「test keys のみ許可」は dev 段階で live key 誤投入を防ぐ強力な guard だが、**production instance に切り替える瞬間にこの guard を必ず外す必要が出る**。外し方を間違えると dev 誤用防止機能が消える。

両方の誤用 (dev で live key / production で test key) を防止しつつ deploy 切替を可能にするには、**環境依存の validation** が必要:

- `VERCEL_ENV === 'production'` → live keys 必須、test keys 拒否
- それ以外 → test keys 必須、live keys 拒否

### 2.2 環境依存 validation の pattern

```ts
const isProd = process.env.VERCEL_ENV === 'production'

if (isProd) {
  if (!key.startsWith('pk_live_')) throw new Error('production requires pk_live_')
} else {
  if (!key.startsWith('pk_test_')) throw new Error('non-prod requires pk_test_')
}
```

`VERCEL_ENV` が undefined の場合 (ローカル dev、Vercel 外) は **test keys 必須側に倒す**。これにより:

- ローカル dev: undefined → test keys 必須
- Vercel preview: `'preview'` → test keys 必須 (production 以外)
- Vercel production: `'production'` → live keys 必須

の 3 段で誤用を構造的に防止できる。

### 2.3 Stripe には適用しない

CLAUDE.md §Stripe-1 / -2 は Claude Code が live keys に**触れること自体を全面禁止**しており、test keys (sk_test_ / rk_test_) のみ許可。「人間が手動で本番切替」の運用方針 (Claude Code は関与させない) を採用しているため、本 lesson の env-dependent pattern は適用しない。

Stripe と Clerk で扱いが異なる理由:
- Stripe: 課金 = 不可逆な金銭移動、live キー漏洩 / 誤動作のリスクが極大
- Clerk: 認証 = 状態のみ、live キー誤動作でも金銭被害なし、deploy 自動化の旨味が大きい

サービスごとに「自動 live 切替を許す / 許さない」の判断が必要。auth は許す、payments は許さない、が plan00 の合意。

### 2.4 切替確認手順

Vercel Project → Settings → Environment Variables で env vars を **scope ごとに分離**:

- Production scope のみ: `pk_live_*` / `sk_live_*` / `CLERK_WEBHOOK_SECRET (production instance 用)`
- Preview / Development scope: `pk_test_*` / `sk_test_*` / `CLERK_WEBHOOK_SECRET (dev instance 用)`

これで同一 codebase で両環境を fail-fast 検証できる:
- preview deploy → test keys でないと build error → dev 誤用検知
- production deploy → live keys でないと build error → production 切替忘れ検知

### 2.5 Clerk Dashboard 側の作業 (Vercel env 設定と並行)

1. Clerk Dashboard で production instance を新規作成 (free plan 50,000 MAU まで無料、2026-02 時点)
2. production instance の API keys (`pk_live_*` / `sk_live_*`) を Vercel Production env に設定
3. production instance の Webhook endpoint URL を **正規 production domain** に再登録 (auto-generated short URL は使わない、`docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` 参照)
4. 新 webhook signing secret を Vercel Production env の `CLERK_WEBHOOK_SECRET` に設定
5. dev instance は `Preview` / `Development` scope で残置 (preview deploy / 開発で継続使用)

## 3. 推奨

「test 環境では test keys 必須、production 環境では live keys 必須」の env-dependent validation を採用。`VERCEL_ENV` ベースで分岐。`VERCEL_ENV` が undefined の場合は test keys 側に倒す (ローカル dev = 安全側)。

Stripe など「live 切替を Claude Code に触らせたくない」サービスには適用しない。各サービスごとに「自動切替の旨味と漏洩リスクの天秤」で判断。

## 4. 参照

- 関連実装: `lib/clerk.ts`, `lib/clerk.test.ts`, `lib/stripe.ts`, `lib/stripe.test.ts` (後者 2 つは 2026-05-16 追加、 §5 参照)
- 関連 lesson: `docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` (production domain 確定の話)
- CLAUDE.md §Clerk-1 / §Stripe-1 (本 lesson の sprint で「環境依存」に更新、 後者は 2026-05-16 §5 で同 pattern 採用)
- 関連 sprint: Phase 1 E-2 (Clerk production keys 切替、`docs/TODO.md` 参照)

## 5. Update (2026-05-16): Stripe にも同 pattern 採用

本 lesson §2.3 は当初「Stripe には適用しない (CLAUDE.md §Stripe-1 / -2 で live keys 全面禁止)」としていたが、 Sprint A-3.2 後の本番デプロイで `STRIPE_SECRET_KEY=rk_live_*` が起動時 validation で弾かれて Vercel build 失敗となり、 方針変更。

`lib/stripe.ts` を `lib/clerk.ts` と同 `VERCEL_ENV`-aware pattern に書換、 CLAUDE.md §Stripe-1 も env-aware 文言に統一。 「人間が手動で本番切替」原則は維持 (Vercel env vars 設定は OT、 Claude Code は code 上の検証 logic のみ実装)。

§2.3 の「課金 = 不可逆な金銭移動、 live キー漏洩リスクが極大」という分析自体は今も正しいが、 **「Claude Code が live key を validate logic で参照する」 ≠ 「Claude Code が live key を使って API を叩く」** という区別を当初混同していた。 前者は安全 (string prefix 比較のみ)、 後者は危険 (実 API 呼出)。 本 commit は前者のみを許可、 後者は依然禁止 (実 Stripe API 呼出は OT 環境変数経由のみ)。

教訓: env validation の logic と API 実行の logic は別 layer。 前者を全面禁止すると production deploy 自体が阻害される。 「禁止」の粒度を慎重に設計すべき。
