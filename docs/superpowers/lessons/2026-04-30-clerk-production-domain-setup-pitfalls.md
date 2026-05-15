# Clerk production instance + 独自ドメイン setup の落とし穴

> **Source**: plan00 Phase 1 E-2 (Clerk production keys 切替) で得た知見。Clerk + Next.js + Vercel + 独自ドメインの組み合わせで再利用。

## 1. 背景

Clerk dev instance はそのまま production 投入できない (usage limit / development banner)。production instance への切替は Clerk + Vercel + DNS registrar の三者連携が必要で、順序を間違うと sign-up 画面真っ白 / build error / apex domain 汚染といった連鎖事故が起きる。

plan00 では <your-domain>.example.com (お名前.com 取得) の subdomain `<your-production-domain>` を Vercel に接続して production 切替を実施。実体験ベースで詰まりポイントを記録。

## 2. Lessons Learned

### 2.1 Clerk production instance は独自ドメイン必須

Clerk production instance は `*.vercel.app` 等の汎用 domain を許可しない。独自ドメインの取得が必須。

- お名前.com / Cloudflare / Route 53 等、registrar はどこでも OK
- Vercel に CNAME で接続できる構成であれば、registrar 側で apex / subdomain どちらの管理も可能
- Clerk dev instance は `*.vercel.app` で動くので、production 切替の瞬間が独自ドメイン要件の発生 timing

### 2.2 「Secondary application」を選択して apex domain 汚染を回避

Clerk Dashboard で production instance 作成時、**Primary application / Secondary application** の選択を求められる。

- **Primary application**: Clerk が要求する 5 個の DNS records が apex domain (例: `<your-domain>.example.com`) 配下に配置される。apex を Clerk 専用に汚染するため、将来別プロジェクトで apex を使いたい場合に詰む
- **Secondary application**: DNS records が指定 subdomain (例: `<your-production-domain>`) 配下に配置される。apex を温存できる

**推奨: Secondary application を選択し、subdomain (vocab / app / accounts 等) 配下で運用**。複数プロジェクトを同 apex で運用する戦略が取れる。

### 2.3 Clerk が要求する 5 個の DNS records (CNAME)

production instance 作成 + domain 入力後、Clerk Dashboard が以下 5 record の追加を要求する:

| host | type | target |
|---|---|---|
| `clerk.<subdomain>.<apex>` | CNAME | Clerk 指定 |
| `accounts.<subdomain>.<apex>` | CNAME | Clerk 指定 |
| `clkmail.<subdomain>.<apex>` | CNAME | Clerk 指定 |
| `clk._domainkey.<subdomain>.<apex>` | CNAME | Clerk 指定 (DKIM) |
| `clk2._domainkey.<subdomain>.<apex>` | CNAME | Clerk 指定 (DKIM) |

5 record 全てが registrar に追加 + DNS 伝播済 + Clerk Dashboard で「Verify configuration 5/5」になるまで sign-up 画面が動かない。**1 record でも欠けると `clerk.<subdomain>.<apex>` への request が ERR_NAME_NOT_RESOLVED で sign-up 画面真っ白**になる。

### 2.4 Clerk production 切替の正しい順序

連鎖事故を避けるための時系列:

1. **独自ドメイン取得** (お名前.com / Cloudflare 等)
2. **Vercel に subdomain CNAME で接続** (`vocab.<apex>` 推奨、apex 直接接続は将来詰みやすい)
3. **Vercel domain status を `Valid Configuration` で確認** (この前に Clerk 進めると DNS 反映が二重待ちになる)
4. **Clerk Dashboard で production instance を Secondary application として作成**、対象 domain (`vocab.<apex>`) を入力
5. **Clerk が指定する 5 records を registrar に追加**
6. **DNS 反映待ち** (5-30 分、`dig clerk.<subdomain>.<apex>` 等で確認可)
7. **Clerk Dashboard で「Verify configuration 5/5」 + SSL certificates Issued を確認**
8. **Clerk から production publishable / secret keys を取得** (domain change で再生成される、step 4 直後の値ではない)
9. **Vercel Production env を新 keys で更新** (Production scope 限定。Preview / Development scope は test keys 維持)
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = `pk_live_*`
   - `CLERK_SECRET_KEY` = `sk_live_*`
   - `CLERK_WEBHOOK_SECRET` = production instance 用 whsec_*
   - `NEXT_PUBLIC_APP_URL` = `https://vocab.<apex>`
10. **`lib/clerk.ts` の env validation が live keys を許可する実装になっていることを確認** (環境依存 validation、`docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md` 参照)
11. **Clerk production instance に webhook endpoint を登録** (`https://vocab.<apex>/api/webhooks/clerk`、user.created / user.updated / user.deleted を購読)
12. **Vercel redeploy (build cache 無し)** で env 反映 + 新 build
13. **ブラウザで動作 verify** (sign-up / sign-in / Pro upgrade / 削除 Free / 削除 Pro、計 10 項目程度)

### 2.5 publishable key 自動再生成の罠

Clerk は **domain change で publishable key を自動再生成する**。production instance 作成画面で表示された keys は domain 確定前の暫定値であり、domain verification 完了後に値が変わっている。

- step 4 で取得した keys を Vercel に入れて step 9 で stop してしまうと、build に古い key が inline され、production load 時に `Clerk: Invalid publishable key` で sign-up 画面が動かない
- step 8 を必ず最後に挟み、Clerk Dashboard の最新 keys を Vercel に再投入

「production instance 作成 → domain 設定 → keys 取得」を一気にやらず、**domain verification (5 records / SSL Issued) まで完了してから keys を取りに行く**のが安全。

### 2.6 lib/clerk.ts の validation を live 許容に修正済か確認

dev フェーズで「test keys のみ許可」の env guard を `lib/clerk.ts` に入れていると、Vercel Production env を pk_live_ に更新後の build で `must start with pk_test_` で deploy 失敗する。

環境依存 validation (`VERCEL_ENV === 'production'` で live 必須、それ以外で test 必須) に修正してから production env 切替を行うこと。詳細は `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md`。

### 2.7 dev instance は停止せず残置

production instance 切替後も、Vercel Preview / Development scope で dev instance keys を継続使用する。

- Preview deploy / 開発用 dev server は dev instance に向けたまま運用
- production instance には verify 用 user 以外を流入させない
- dev instance を停止すると Preview / Development scope の env が無効化されて開発が止まるため、停止判断は慎重に

### 2.8 Allowed Subdomains 設定は default で OK

Clerk Dashboard の `Allowed Subdomains` 設定は wildcard (default) のままで問題ない。明示的設定は preview deploy URL を production instance に向けたい等の特殊運用時のみ。

## 3. 推奨

Clerk + Vercel + 独自ドメインの組み合わせで production 切替する場合、本 lesson §2.4 の 13 step を上から順に実施。特に:

- §2.2 Secondary application 選択 (apex 汚染回避)
- §2.4 順序遵守 (Vercel domain → Clerk instance → DNS records → keys → env → redeploy → verify)
- §2.5 keys 取得は domain verification 後 (publishable key 再生成の罠回避)
- §2.6 lib/clerk.ts の validation を環境依存に修正済か事前確認

verify は §2.4 step 13 を 10 項目程度の checklist 形式で行い、結果を `docs/superpowers/notes/<date>-phase-X-Y-verify.yml` に記録。

## 4. 参照

- 関連 lesson: `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md` (lib/clerk.ts validation 環境依存化)
- 関連 lesson: `docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` (production domain 確定の話、Phase 1 E-1)
- 関連 sprint: Phase 1 E-2 (Clerk production keys 切替、`docs/TODO.md` 決着済 section 参照)
- verify 記録: `docs/superpowers/notes/2026-04-30-phase-1-e2-verify.yml`
