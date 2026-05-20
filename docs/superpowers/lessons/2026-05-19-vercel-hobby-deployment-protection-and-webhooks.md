# Vercel Hobby plan の Deployment Protection が Webhook を 401 で蹴る

> **Source**: 2026-05-19 staging cleanup 後の sign-up flow 復旧調査で得た知見の保存。 Vercel Hobby plan を使う限り、 production / staging / preview を一律 protect か一律 public の二択しかなく、 「production だけ守る」 設定は構造的に不可。 webhook 検証時に 401 で蹴られる症状の検出と対処を baseline 化する。

## 1. 背景

2026-05-19 staging cleanup (Neon truncate + Clerk users 全削除 + Stripe customers 全削除) 後の新規 sign-up flow で「アカウントを準備しています…」 が永遠に固まる症状が発生。 過去 plan00 で確立した SyncingPage 設計 (`docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` §3.4) は `<meta http-equiv="refresh" content="2">` で 2 秒ごと page reload するだけのため、 webhook が DB に届かない限り永遠に loop する。

最初の調査 (`docs/superpowers/sessions/2026-05-19-account-prep-stuck-investigation.md`、 commit `c859032`) は Clerk Dashboard の Webhooks endpoint URL / signing secret 不一致を最有力 H1 / H2 と推定したが、 真の原因は Vercel Hobby plan の Deployment Protection で **production / staging / preview を一律 401 で蹴っている** ことだった。 Clerk / Stripe webhook が endpoint に到達する前に Vercel Edge で弾かれていた。

`docs/superpowers/sessions/2026-05-17-env-separation-and-prod-deploy-handoff.md` §6 で「stg 環境で Clerk webhook が Failed × 3 retry、 Deployment Protection 切替で復旧」 と 1 度記録済 だったが、 cleanup 操作の副作用で **再 ON されていた** 経緯あり。 lesson 蒸溜で再発時の検出を高速化する。

## 2. Lessons Learned

### 2.1 Vercel Hobby plan は Deployment Protection を「一律 ON / OFF」 でしか設定できない

Pro plan には「Deployment Protection Exceptions」 (特定 domain だけ unprotect する機能) があり、 「production domain は public、 preview deployment URL は protect」 という運用が可能。 Hobby plan では Exceptions が UI 上不在で、 **production / staging / preview 全部を protect か全部 public かの二択**。

「production だけ守りたい、 staging は webhook 受信のために public」 という直感的な設定は Hobby plan では構造的に実現不可。 これを知らないと、 staging で「Require Log In ON のまま webhook を試そうとして、 永遠に Failed が出続ける」 パターンに陥る。

### 2.2 Protection ON の response は HTML、 webhook 側は 401 で deliver fail

Vercel Edge は protect 配下の deployment 全 request に対し、 認証 cookie 不在なら HTTP 401 + Vercel Authentication HTML を返す。 webhook 経路 (`POST /api/webhooks/*`) も同 Edge layer を通るため、 Svix / Stripe の署名検証より前に弾かれる。

Clerk Dashboard / Stripe Dashboard 側からは Recent Deliveries で:
- HTTP status: `401`
- Response body: Vercel Authentication の HTML 文字列 (`<!DOCTYPE html>...Authentication Required...`)
- Failed retry: 3 回まで自動 retry、 すべて同 401 で fail

として見える。 endpoint URL の typo / secret 不一致と区別するため、 **response body が HTML かどうか** をまず見るのが切り分けの起点。

### 2.3 Clerk auth で /app/* を保護していれば、 Vercel Protection は冗長

`middleware.ts` で `clerkMiddleware` + `createRouteMatcher(['/app(.*)'])` が `/app/*` 配下を保護している以上、 未認証 user は sign-in に redirect される。 marketing page (`/`, `/pricing`, `/terms` 等) は元から public 想定。 つまり Vercel Deployment Protection は **アプリ層保護に対し冗長**で、 pre-launch / launch 後問わず外しても機能的セキュリティに穴は開かない。

例外: 「launch 前に SEO で indexing されたくない」 「特定 staging URL の存在を世間に知られたくない」 等は **robots.txt** + **noindex meta** で十分対応可能 (`public/robots.txt` で `Disallow: /` + `/app/` + `/api/` 等)。

→ Hobby plan で webhook 検証する pre-launch 期間は **Require Log In OFF を default 運用** にして良い。

### 2.4 「OCR の長尺対応のために Pro 化」 と「staging だけ protect 解除のために Pro 化」 は同じ判断軸で決める

Vercel Pro upgrade は $20/月。 RecallMint の technical roadmap 上、 Pro 化を検討する drivers は 2 つ:
1. **OCR function timeout** (Hobby 60s → Pro 900s)。 1 ファイル 150 page まで単発処理する CLAUDE.md 整合性のため必須
2. **Deployment Protection Exceptions** (staging だけ unprotect)、 本 lesson の症状を構造的に解消

両者は同 plan upgrade で同時解決される。 Pro 化判断は「OCR 長尺対応」 を主要 driver にしつつ、 「staging Protection 整理」 を副次的 benefit として扱う。 単独で Pro 化する justification にはなりにくい (Hobby + OFF 運用で機能的に等価)。

## 3. 検出方法 (切り分け順)

### 3.1 Clerk / Stripe Dashboard で Recent Deliveries を見る (5 秒)

最速。 全 fail なら Vercel Protection を疑う。 一部 fail / 一部 succeed なら別の原因 (handler 例外 / secret 不一致)。

| symptom | 原因候補 |
|---|---|
| 全件 Failed + response status 401 | **Deployment Protection ON** |
| 全件 Failed + response status 400 「invalid signature」 | `WEBHOOK_SECRET` 不一致 |
| 全件 Failed + response status 404 | endpoint URL 設定漏れ / deploy 失敗 |
| 一部 Failed + response status 500 | handler 例外 (Vercel logs 確認) |
| Recent Deliveries 0 件 | endpoint 未登録 / Clerk side で send されていない |

### 3.2 Response body が HTML か確認 (5 秒)

Recent Deliveries の詳細を開いて Response Body を読む。

```html
<!DOCTYPE html>
<html>
<head>
<title>Authentication Required</title>
...
```

の形なら Vercel Authentication HTML、 **Protection ON 確定**。 JSON / plain text なら別原因。

### 3.3 curl で endpoint 死活確認 (10 秒)

```bash
curl -i -X POST https://stg.recallmint.nekotest.net/api/webhooks/clerk
```

期待する response:
- **`HTTP/1.1 401 Unauthorized` + `<!DOCTYPE html>...Vercel...`** → Protection ON 確定 (この lesson の症状)
- `HTTP/1.1 400` + `missing svix headers` → endpoint 生きている、 別原因 (secret 不一致 / handler issue)
- `HTTP/1.1 404` / `500` → deploy 問題 (Vercel Deployments status 確認)

## 4. 対処 (Hobby plan で取れる選択肢)

### 案 A (採用): Require Log In OFF にして全公開

- Vercel Dashboard → Project → Settings → Deployment Protection → **Require Log In: OFF**
- 機能的セキュリティは Clerk middleware (`/app/*` 保護) + Stripe webhook 署名検証 + Clerk webhook Svix 検証で確保
- SEO は `public/robots.txt` の `Disallow:` ディレクティブで指定 page を indexing 拒否
- RecallMint pre-launch 期間中 (ユーザー 0、 業務 traffic なし) は実害ゼロ

**RecallMint 採用根拠**:
- pre-launch でユーザー 0、 staging を実 traffic から守る必要なし
- Clerk + 署名検証で機能セキュリティは担保
- Pro 化を含めた構造改善は OCR timeout 解決と合わせ別軸で判断

### 案 B: Protection Bypass for Automation (secret + query param)

- Vercel が「Deployment Protection Bypass for Automation」 機能を提供 (Hobby plan でも利用可能)
- `x-vercel-protection-bypass` header or `?x-vercel-protection-bypass=<secret>` query param で個別 request を bypass
- 但し Clerk / Stripe Dashboard 側で webhook endpoint URL に secret query を含める必要があり:
  - `https://stg.recallmint.nekotest.net/api/webhooks/clerk?x-vercel-protection-bypass=<long-secret>`
- 運用コスト:
  - secret 管理 (Vercel 側で発行、 Clerk / Stripe Dashboard に貼付)
  - secret rotate 時に Clerk + Stripe 両方で URL update が必要
  - URL に secret が embed されるため Dashboard 経由で漏洩 risk

**RecallMint 不採用根拠**: secret 管理コストが pre-launch 期間の利益を上回る、 案 A で十分。

### 案 C: Vercel Pro upgrade ($20/月)

- Deployment Protection Exceptions で「production domain だけ unprotect、 staging / preview は protect」 構成可能
- OCR function timeout も同時に 60s → 900s に改善
- Pro 化は OCR 長尺対応の必須要件 (CLAUDE.md「1 ファイル ≤ 150 ページ単発で完結 (Vercel Pro 900s)」 と整合)

**RecallMint 将来採用**: launch 直前 / OCR 長尺ユーザー流入時に判断。 本 lesson の症状解決単独では Pro 化しない。

## 5. RecallMint pre-launch 運用 (採用 baseline)

- **Hobby plan のまま**、 Require Log In **OFF を default** に維持
- smoke / webhook 検証時も OFF 維持 (毎回切替不要)
- production launch 時に SEO 対策 (`public/robots.txt` 解除 + `public/sitemap.xml` 整備) で Search Engine 対応、 機密性は Clerk auth に委ねる
- 将来 Vercel Pro 化 (OCR timeout 解決と合わせ) のタイミングで本 lesson update、 staging のみ unprotect する構成に移行

## 6. 再発防止チェックリスト

sprint kick 前 / cleanup 操作後に確認:

- [ ] Vercel Dashboard → Settings → Deployment Protection → **Require Log In: OFF** か確認
- [ ] Clerk Dashboard / Stripe Dashboard の Recent Deliveries で Failed が積み上がっていないか
- [ ] smoke 失敗時、 まず Deployment Protection を疑う (response 401 + HTML が tell)
- [ ] `docs/superpowers/sessions/2026-05-17-env-separation-and-prod-deploy-handoff.md` §6 で記録した「staging Protection OFF」 状態が崩れていないか定期確認 (cleanup や Vercel 設定変更操作の副作用で再 ON される pattern あり)

## 7. 関連 risk

- **「production だけ守りたい」 衝動は Hobby plan では構造的に叶わない**。 「とりあえず ON に戻しておく」 の運用が再発の温床、 OFF default を維持する
- Pro 化判断は **OCR Vercel function timeout 60s 制約** を主要 driver に、 本 lesson の症状解決を副次として扱う
- Vercel が将来 Hobby plan 仕様変更で Exceptions 提供する可能性は低い (有料化 driver なので)。 Pro 化のタイミングまで本 lesson 採用方針を継続する

## 8. 参考

- 調査記録 (本 lesson の発端): `docs/superpowers/sessions/2026-05-19-account-prep-stuck-investigation.md` (commit `c859032`、 root cause を Clerk 側に推定したが Vercel Protection が真の原因だった点を本 lesson で訂正)
- 過去 env-separation handoff: `docs/superpowers/sessions/2026-05-17-env-separation-and-prod-deploy-handoff.md` (env-separation 時点で同症状を 1 度経験、 Protection OFF で復旧記録済、 本 lesson は同事象の再発)
- Clerk webhook architecture: `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` (SyncingPage + webhook race の設計、 本 lesson の前提)
- Clerk production / Dev instance 切替: `docs/superpowers/lessons/2026-04-30-clerk-production-domain-setup-pitfalls.md` (independent な落とし穴、 本 lesson とは別軸)
- Vercel domain confusion: `docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` (関連する Vercel 関連 pitfall)
- Vercel 公式 doc: https://vercel.com/docs/security/deployment-protection (Hobby vs Pro の feature 差は本 page で確認可能、 Exceptions は Pro plan 限定と明記)
