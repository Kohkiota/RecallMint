# Vercel auto-generated URL と正規 production domain の混同

> **Source**: plan00 Phase 1 E-1「Tailwind 紫画面」(2026-04-22 〜 2026-04-29) の決着で得た知見。Vercel + Next.js プロジェクトで再利用。

## 1. 背景

plan00 で長期 (約 1 週間) にわたり memory / TODO に「`/app?checkout=success` 着地時に紫背景一面で UI 完全崩壊」という known bug が残留していた。仮説は当時「Tailwind v4 の本番 CSS pruning が dynamic class を purge している」とされ、原因究明 sprint (E-1) を起こす予定だった。

E-1 着手前に OT が production URL を再確認したところ、**OT がアクセスしていたのは `vocab-app.vercel.app` で、これは plan00 の正規 production deployment ではなかった**。Vercel hobby tier の auto-generated subdomain は他人/別 deployment に当たる可能性がある。正規 domain は Vercel Dashboard の Domains セクションに登録されている `<your-vercel-app>.vercel.app` で、こちらにアクセスすると紫画面は再現せず、checkout 成功画面は正しく表示された。

Tailwind v4 CSS pruning は本件に**まったく関係ない**。memory 上の「Tailwind v4 production pruning bug」は誤診断のまま固着していた幻想 bug で、E-1 sprint は実体不要 (再現テストのみで決着) と確定した。

## 2. Lessons Learned

### 2.1 Vercel hobby tier の `<project>.vercel.app` URL は別人 deployment と衝突しうる

Vercel は project 名から `<project>.vercel.app` の auto-generated URL を発行するが、hobby tier では他 user が同じ short name を先に取っていた場合、自分の deployment はより冗長な suffix 付き domain (例: `<your-vercel-app>.vercel.app`) になる。短い `<project>.vercel.app` は **別の人の app** か、**同じ project 名の parked URL** に解決される可能性がある。

正規 production domain は **Vercel Dashboard → Project → Settings → Domains** で確認する。表示されている domain こそ「自分の deployment が serve されている URL」であり、auto-generated short URL を信用しない。

### 2.2 環境変数の URL 系は Vercel Dashboard で確認した正規 domain を参照する

以下の env var に URL を入れる際、auto-generated `<project>.vercel.app` をハードコードしてはならない:

- `NEXT_PUBLIC_APP_URL`
- Stripe `success_url` / `cancel_url` (Checkout session 作成時)
- Clerk redirect URLs (sign-in / sign-up 後 redirect)
- Webhook endpoint URL (Stripe Dashboard / Clerk Dashboard 側に登録するもの)

short URL を使うと、別人の app へ user を redirect させる事故が起きる (auto-generated subdomain の所有が変わったタイミングで気付かないうちに発生)。Vercel Domains で確認した正規 domain (custom domain か、Vercel が auto-generated した冗長 suffix 付き domain) を使う。

### 2.3 memory の "Known bug" は実機再現テスト先行でないと幻想 bug が長期残留する

E-1 案件では「紫画面」が memory に書かれたまま 1 週間放置され、Tailwind v4 の本番 pruning という(妥当に見える) 仮説が伴っていたため、誰も再現確認をせずに sprint 化される寸前まで進んだ。**memory に記載された bug は、sprint 起こす前に必ず実機再現を first ステップで取ること**。再現しなければ memory が stale な可能性が高く、原因仮説 (Tailwind / Router Cache / 等の技術側) よりも先に「観察条件 (アクセス URL / 環境 / 再現手順)」を疑う。

### 2.4 仮説の妥当さは観察結果の正しさを保証しない

「Tailwind v4 本番 pruning」は技術的に妥当に聞こえる仮説で、checkout 成功画面の dynamic class purge という特異な症状にも筋が通っていた。しかし観察そのもの (= 自分の deployment にアクセスできているか) が間違っていれば、どれだけ仮説が妥当でも結論は誤る。**bug 報告で先に確認すべきは「自分が観察対象を正しく見ているか」**。仮説検証はその後。

## 3. 推奨パターン

### 3.1 production deploy 直後の観察手順

1. Vercel Dashboard → Project → Settings → Domains を開き、登録 domain を控える
2. その domain で sign-in / 主要 flow を動作確認
3. 環境変数 (`NEXT_PUBLIC_APP_URL` 等) が同じ domain を指していることを確認
4. Stripe / Clerk Dashboard 側の webhook URL / redirect URL も同 domain を参照

### 3.2 bug 報告 / memory 記載の triage チェックリスト

memory または bug report を sprint 化する前に:

- [ ] 実機で再現するか? (まだなら再現テストが first ステップ)
- [ ] アクセスしている URL は Vercel Dashboard の正規 domain か?
- [ ] 環境変数の URL 系は正規 domain を指しているか?
- [ ] memory の記載日時から 1 週間以上経過していないか? (経過していれば stale 疑い)

3 項目通過してから初めて技術的な原因仮説 (Tailwind / Router Cache / 等) に踏み込む。

### 3.3 stale memory の上書き

memory の Known bug が再現せず確定した場合、即座に:

- TODO.md からは sprint 行を削除し、「決着済」section に 2 行で根拠を残す
- claude.ai 側 memory を訂正対象として `docs/superpowers/notes/<date>-stale-memory-corrections.md` に列挙
- lesson (本 file 種別) として理由・観察手順・再発防止策を残す

## 4. 参照

- 関連 audit: `docs/superpowers/notes/2026-04-29-phase-1-e5-audit.md`
- stale memory 訂正対象一覧: `docs/superpowers/notes/2026-04-29-stale-memory-corrections.md`
- Vercel domain doc: https://vercel.com/docs/projects/domains
