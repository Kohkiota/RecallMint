# 環境分離構築と Stripe key mode 強制の lesson

> **Source**: Sprint A-3.2 完了直後の本番初回デプロイで `STRIPE_SECRET_KEY=rk_live_*` が
> test-only validation で弾かれ、 環境分離 + mode 強制方針を整理した知見 (commit `4f8002d`)。
> mcq-platform 本番投入フェーズの境界整理。

## 1. 背景

Sprint A-3.2 (plan-limits 再設計 + contact_messages 配線) 完了後、 本番ドメイン
`recallmint.nekotest.net` への初回 Vercel production deploy で build が失敗:

```
STRIPE_SECRET_KEY must start with rk_test_ or sk_test_.
Live keys (sk_live_ / rk_live_) are forbidden.
Got prefix: rk_live_x...
```

原因: `lib/stripe.ts` が plan00 由来の「test keys 専用」絶対 validation を保持しており、
本番 instance に切り替えた瞬間にこの guard 自体が deploy 阻害となった。 同様の事象は
Phase 1 E-2 で Clerk 側で先に踏まれており (`2026-04-30-clerk-env-validation-environment-dependent.md`)、
当時は「Stripe には適用しない」と意図的に分離していたが、 今回 Stripe も同 pattern に
統一する判断に至った。

同時に、 本番投入を機に **2 環境構成 (prod / dev 共用)** を明文化し、 各 service の環境
分離方式を確定させた。 本 lesson はその全体像と教訓を記録する。

## 2. Lessons Learned

### 2.1 2 環境構成 (prod / dev 共用) の確定

mcq-platform は MVP 段階の小規模 SaaS であり、 環境を増やすほど運用負荷が線形に
増える。 採用した最小構成:

| 環境 | URL | git branch | Vercel scope | 目的 |
|---|---|---|---|---|
| prod | `recallmint.nekotest.net` | `main` | Production | 本番ユーザー、 live 課金 |
| dev (共用) | `stg.recallmint.nekotest.net` | `develop` | Preview | preview deploy 検証 + 開発者共有 |
| local | `localhost:3000` | feature branch | Development | 個別開発、 dev と同じ external service 共有 |

key 判断:

- **Vercel Preview scope と Development scope は同一の external service を共有**
  (同じ R2 bucket / Neon staging branch / Clerk Dev instance / Stripe test mode)。
  preview と local で別 backend を持つと preview で再現した bug が local で再現
  しなくなり、 デバッグ動線が断絶する
- **環境を「prod / それ以外」の 2 群でしか分けない**。 staging / qa / sandbox 等
  細分しないことで、 env vars 設定漏れの blast radius を抑える
- dev 共用 backend は **GDPR / 個人情報保護法でいう商用本番ではない** という前提
  (test キー / 開発者のみアクセス) で、 ユーザー一般公開しない

### 2.2 各 service の環境分離方式

| service | 分離方式 | prod scope | dev 共用 scope |
|---|---|---|---|
| **Neon** (Postgres) | branch 機能 | `main` branch | `staging` branch |
| **Clerk** | instance 分離 | Production instance | Development instance |
| **Stripe** | mode 分離 | live mode (`*_live_*` keys) | test mode (`*_test_*` keys) |
| **R2** (Cloudflare) | bucket 物理分離 | `recallmint` bucket | `recallmint-dev` bucket |
| **CNAME** | Vercel 経由統一 | `8823a5e067e80624.vercel-dns-017.com` | 同 (Vercel 側で alias 解決) |

CNAME 新形式 (`*.vercel-dns-017.com`) は Vercel 2025 後期に導入されたもので、 旧
`cname.vercel-dns.com` から移行済。 本番 / stg の DNS 設定は同一 CNAME target、
Vercel 側で project + domain の組合せで送り分けるため、 DNS layer での誤接続事故
リスクが低い。

### 2.3 Stripe key mode 強制の進化 (commit `4f8002d`)

`lib/stripe.ts` の validation 進化を 3 段階で記録:

**Stage 1: plan00 時代 (test-only 絶対強制)**

```ts
if (!key.startsWith('rk_test_') && !key.startsWith('sk_test_')) {
  throw new Error('... Live keys are forbidden.')
}
```

設計意図: zero-prod 段階 (まだ本番が存在しない) で live key 誤投入を構造的に防止。
CLAUDE.md §Stripe 絶対ルール #1 / #2 / #3 もこの方針を明文化していた。

**Stage 2: 本番投入で破綻**

Vercel production env に `STRIPE_SECRET_KEY=rk_live_*` を設定 → build 時 validation
で throw → deploy 不可。 「test-only 強制」が本番 deploy 自身を阻害する状態に。

**Stage 3: VERCEL_ENV ベース mode 強制 (現行)**

```ts
const isProd = process.env.VERCEL_ENV === 'production'
if (isProd) {
  if (!key.startsWith('rk_live_') && !key.startsWith('sk_live_')) throw ...
  if (!pk.startsWith('pk_live_')) throw ...
} else {
  if (!key.startsWith('rk_test_') && !key.startsWith('sk_test_')) throw ...
  if (!pk.startsWith('pk_test_')) throw ...
}
```

これにより双方向の事故を防止:
- prod scope に test key を設定 → 起動拒否 (本番が test mode で誤動作することを防ぐ)
- 非 prod scope に live key を設定 → 起動拒否 (dev で誤って本番課金が走ることを防ぐ)

Clerk 側 (`lib/clerk.ts`) は Phase 1 E-2 で先に同 pattern を採用済。 今回 Stripe も
統一されたため、 両者の env validation 形式は grep 等価。

**抽出した meta lesson**:

「test-only 強制」のような防御は **zero-prod 段階の便宜** であり、 本番投入フェーズで
誤作動する。 mode 強制は環境依存に進化させるべきであって、 一度書いた絶対 validation を
そのまま温存するのは負債。 「Claude Code に live key を validate logic で参照させる」 ≠
「Claude Code に live key で API を叩かせる」 という layer 分離が肝で、 前者は安全
(string prefix 比較のみ)、 後者は危険 (実 API 呼出 → 不可逆な金銭移動)。 後者の禁止は
維持しつつ、 前者は環境依存に開放するのが正解。

### 2.4 R2 token の scope 限定

Cloudflare R2 token 発行時の選択:

- **bucket-scoped token (Apply to specific buckets only)** を選ぶ
  - 漏洩時に被害が当該 bucket に限定される
  - prod token は `recallmint` のみ、 dev token は `recallmint-dev` のみに scope
- **Account API token を選ぶ** (User API token ではない)
  - 人 (個人 user) に紐付かないため、 OT 退職 / アカウント停止で token が失効しない
  - account level の audit log が残る
- **Object Read + Write 権限のみ付与**、 Bucket Edit (create / delete) は付与しない
  - bucket 管理は Cloudflare Dashboard 経由の手作業のみ

### 2.5 本番デプロイ失敗の教訓 — 防御コードと CLAUDE.md ルールの整合

防御コード (validation guard) が本番投入で誤作動するパターンは、 開発初期に書いた
「絶対○○」系のルールが時間経過で陳腐化することに起因する。 本件では:

- CLAUDE.md §Stripe 絶対ルール #1 「test keys のみ許可」
- CLAUDE.md §Stripe 絶対ルール #2 「live keys の取り扱い禁止 (コードにも書かない)」
- CLAUDE.md §Stripe 絶対ルール #3 「起動拒否」

の 3 ルールが本番投入時に同時破綻した。 修正にあたって code と CLAUDE.md を**同一
commit で更新** (commit `4f8002d`) し、 「policy と code が常に一致している」状態を
保った。 lesson:

1. 「絶対 / 全面禁止」と書く前に、 そのルールが production 投入時にどう振る舞うかを
   先に考える。 多くの場合「環境依存」が正解で、 「絶対」と書くのは zero-prod 段階の
   便宜に過ぎない
2. ルール変更時は **code と CLAUDE.md (および関連 lesson doc / .env.example /
   architecture-guide) を同一 commit で update**。 doc drift は次世代の Claude
   session で同じ事故を再発させる
3. 防御 logic 自体が deploy 阻害になった場合、 該当 logic を bypass するのではなく
   **環境依存 logic に進化させる** のが正しい解。 `--no-verify` 的な短絡は厳禁

## 3. 推奨

- 新サービス導入時、 「prod / 非 prod」の 2 群 × `VERCEL_ENV === 'production'` 判定で
  env vars / API mode を切り替える pattern を default 採用。 細分化は MVP 段階では避ける
- env validation を新規追加する際は、 最初から `isProd` 分岐込みで書く (絶対 validation を
  あとから env-aware に書換える工数を発生させない)
- key / token 系の scope は最小権限。 R2 は bucket-scoped、 Stripe は Restricted Key
  (`rk_*`)、 Clerk はインスタンス分離
- 「絶対ルール」を CLAUDE.md に書く前に「これは本番投入フェーズでも維持できるか?」を
  自問。 zero-prod 段階のみ有効なルールには `[zero-prod 段階のみ]` 等のタグを付ける

## 4. 参照

- 関連実装: `lib/stripe.ts`, `lib/stripe.test.ts`, `lib/clerk.ts`, `lib/clerk.test.ts`
- 関連 lesson:
  - `2026-04-30-clerk-env-validation-environment-dependent.md` (Clerk 側で先行採用、 本 lesson の前段)
  - `2026-04-29-vercel-domain-confusion.md` (production domain 確定)
  - `2026-04-30-clerk-production-domain-setup-pitfalls.md` (Clerk production instance 切替)
- CLAUDE.md §Stripe 絶対ルール (本 lesson の sprint で env-aware 文言に更新)
- 関連 commit: `4f8002d fix(stripe): allow live keys in production, enforce test keys elsewhere`
- 関連 sprint: Sprint A-3.2 直後の hotfix (plan 外、 本番初回 deploy 起因)
