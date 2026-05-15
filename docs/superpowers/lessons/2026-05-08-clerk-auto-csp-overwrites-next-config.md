# Clerk middleware auto CSP overwrites next.config.ts headers() CSP

> **Source**: plan00 Phase 1 G-baseline-3 (`8aafc22` security headers + minimal CSP)
> production reach 後の curl 確認で発見 (2026-05-02)。 Clerk middleware を採用する
> Next.js プロジェクトで CSP header を扱う際に再利用。

## 1. 背景

plan00 (Next.js + Clerk + Stripe SaaS、 Phase 1 G で security header 整備中) で
`next.config.ts` の `headers()` で `Content-Security-Policy: frame-ancestors 'none'`
を配備したが、 production response の最終 `Content-Security-Policy` header に
**含まれていない** ことを `curl -I` で発見。 Clerk middleware が injection する
auto CSP が next.config 側を **置き換える** (concat / merge ではない) 挙動が原因。
plan00 では X-Frame-Options DENY の代替防御で実害なしと判断、 ただし template
利用者が同 pattern (next.config.ts headers() + Clerk middleware
contentSecurityPolicy: {}) を採用した場合に同現象に当たるため、 lesson 化。

## 2. Lessons Learned

### 2.1 Clerk middleware の auto CSP は next.config.ts headers() の CSP を上書きする

`clerkMiddleware({ contentSecurityPolicy: {} })` (default mode) は request ごとに
動的に CSP header を組み立てて response.headers に inject する。 同一 HTTP response
内に next.config.ts headers() からの CSP と Clerk middleware の CSP が共存する場面で、
Clerk middleware の値が単独で残る (Next.js / Vercel の上書き挙動)。

W3C CSP spec 上は複数 CSP policy の AND (intersection) を取るのが正しいが、 本 case
では Clerk middleware の injection が next.config 側を **置き換えている**
(concat / merge ではない) ことを production curl で実証。

### 2.2 X-Frame-Options DENY は Clerk が touch しないので機能する

Clerk middleware が auto-inject するのは CSP のみ、 X-Frame-Options は touch しない。
clickjacking 防御として CSP `frame-ancestors 'none'` と X-Frame-Options DENY は
**等価機能**、 後者単独で防御は維持される。 next.config.ts headers() で
X-Frame-Options DENY を配備すれば二重防御の片翼が機能。

### 2.3 修正方針は 3 案、 yagni で X-Frame-Options 代替が現実的

| 案 | 内容 | trade-off |
|---|---|---|
| A | X-Frame-Options DENY 単独 + Clerk auto CSP 受け入れ | 最小、 plan00 採用、 yagni |
| B | Clerk strict mode + nonce で middleware 内 mutate に追加 directive | nonce 取扱いの追加複雑性、 Server Component 経路調整、 中規模以上で過剰 |
| C | Clerk middleware を解除して自前 CSP injection | Clerk 認証 protect の機能を別 layer に分離必要、 影響範囲大、 中規模以上で過剰 |

plan00 は **案 A** 採用 (Phase 1 G-baseline-3 確定)。 案 B / C は将来 (CSP 詳細制御
要件発生時) に再評価。

## 3. 検出方法

production / preview deploy 後に `curl -I <URL>` で response header の
`Content-Security-Policy` を確認:

```bash
curl -I https://<your-deploy-url>/
# Content-Security-Policy: connect-src ...; default-src 'self'; ... の Clerk auto 値のみ確認
# next.config.ts の frame-ancestors directive が消失していれば本 pitfall
```

next.config.ts の `headers()` で配備した CSP directive が消失していたら本 pitfall に
該当。 X-Frame-Options DENY が同 response に存在することは別途確認 (`curl -I` の
`X-Frame-Options:` 行)。

## 4. アンチパターン

- **next.config.ts headers() CSP に Clerk / Stripe origin を列挙して配備**
  - Clerk auto CSP に上書きされて消失、 maintenance コストだけ発生
  - Clerk middleware が動的に必要な origin を組み立てるのに任せる方が筋
- **Clerk auto CSP を `contentSecurityPolicy: undefined` で停止**
  - Clerk が必要とする connect-src / frame-src 等の directive が抜け、 sign-in 動作崩れ
  - 停止せずに案 A / B / C で運用

## 5. plan00 case study への参照

- 検出 commit: `8aafc22` (Phase 1 G-baseline-3 push 後 production curl で発見)
- 実装: `next.config.ts` (X-Frame-Options DENY 配備)、 `middleware.ts` (clerkMiddleware
  auto CSP)
- production curl 結果 (2026-05-02 時点):
  ```
  content-security-policy: connect-src ...; default-src 'self'; form-action 'self';
  frame-src ...; img-src ...; script-src ...; style-src ...; worker-src 'self' blob:
  ```
  → `frame-ancestors` directive が消失、 Clerk auto CSP の値のみ残存

## 6. 関連リンク

### Web standards
- [W3C CSP spec § 3.2.4 Multiple policies](https://www.w3.org/TR/CSP3/#multiple-policies) — 複数 CSP policy の AND intersection
- [MDN: Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy)
- [MDN: X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options) — clickjacking 防御の equivalent

### Clerk doc
- [Customize CSP in middleware](https://clerk.com/docs/security/clerk-csp) — `contentSecurityPolicy: {}` default mode + strict mode 切替

### Next.js doc
- [next.config.js headers()](https://nextjs.org/docs/app/api-reference/config/next-config-js/headers) — 静的 header 配備
