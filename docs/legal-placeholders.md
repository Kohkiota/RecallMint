# 法務 page プレースホルダ管理

最終更新: 2026-05-06 (Phase 1 I-K で chrome / RG 構造変更に追従)
対象 file:
- `components/marketing/marketing-footer.tsx` (旧 `components/legal-footer.tsx` 廃止 → MarketingFooter に吸収)
- `components/brand/logo.tsx` (新規、 chrome Logo の SERVICE_NAME placeholder)
- `app/(marketing)/page.tsx` (top page hero h1 の SERVICE_NAME placeholder)
- `app/(marketing)/terms/page.tsx` (旧 `app/(legal)/terms/page.tsx`)
- `app/(marketing)/privacy/page.tsx` (旧 `app/(legal)/privacy/page.tsx`)
- `app/(marketing)/legal/page.tsx` (旧 `app/(legal)/legal/page.tsx`)

各 file 内の `{{...}}` リテラル文字列 (JSX 上は `{'{{...}}'}` 表記) は本気運用時に sed 一括置換する。

---

## 1. プレースホルダ一覧 (13 項目)

| # | プレースホルダ | 仮値の例 | 用途 / 出現 page |
|---|---|---|---|
| 1 | `{{SERVICE_NAME}}` | `Vocab App` | MarketingFooter copyright / Logo (chrome) / top page hero h1 / terms 第1条 / 各 page |
| 2 | `{{COMPANY_NAME}}` | `<戸籍上氏名>` (個人事業主は本名、屋号併記可) | terms 冒頭 / privacy 第1条 / privacy 第11条 |
| 3 | `{{OPERATOR_NAME}}` | `<戸籍上氏名>` | 特商法「運営責任者」(請求時開示前提なら不使用、template 用) |
| 4 | `{{ADDRESS}}` | `〒XXX-XXXX 都道府県市区町村...` | 特商法「所在地」(請求時開示前提なら不使用、template 用) |
| 5 | `{{PHONE}}` | `XX-XXXX-XXXX` | 特商法「電話番号」(請求時開示前提なら不使用、template 用) |
| 6 | `{{EMAIL}}` | `support@example.com` | privacy 第9・11条 / 特商法 冒頭・dl |
| 7 | `{{DOMAIN}}` | `<your-vercel-app>.vercel.app` | 特商法「ホームページ URL」 |
| 8 | `{{PRICE}}` | `990 円` | terms 第4条 / 特商法「販売価格」 |
| 9 | `{{JURISDICTION}}` | `東京地方裁判所` | terms 第15条 (専属合意管轄裁判所) |
| 10 | `{{LAST_UPDATED}}` | `2026年4月30日` | 各 page 末尾「制定」 |
| 11 | `{{LAUNCH_DATE}}` | `2026年5月1日` | terms / privacy 末尾「施行」 |
| 12 | `{{DISCLOSURE_FEE}}` | `無料` (or `1,000 円` 等) | privacy 第9条 4項 (開示請求手数料) |
| 13 | `{{BUSINESS_HOURS}}` | `平日 10:00-18:00` | 特商法「営業時間」 |

`{{OPERATOR_NAME}}` / `{{ADDRESS}}` / `{{PHONE}}` は現状の特商法 page では「ご請求があった場合は遅滞なく開示」固定 text を採用しているため**未使用**。本気運用で「最初から公開」に方針転換した場合、特商法 page の該当箇所を `{'{{OPERATOR_NAME}}'}` 等に書き換えてから sed 置換するために残置している (template 用)。

---

## 2. 本気運用時の sed 一括置換手順

### 2.1 値の準備

下記を `.env.production-legal` 等の **コミットしない** ファイルに用意してから export:

```bash
export L_SERVICE_NAME='Vocab App'
export L_COMPANY_NAME='<戸籍上氏名>'
export L_OPERATOR_NAME='<戸籍上氏名>'
export L_ADDRESS='〒XXX-XXXX 東京都...'
export L_PHONE='XX-XXXX-XXXX'
export L_EMAIL='support@example.com'
export L_DOMAIN='<your-vercel-app>.vercel.app'
export L_PRICE='990 円'
export L_JURISDICTION='東京地方裁判所'
export L_LAST_UPDATED='2026年5月1日'
export L_LAUNCH_DATE='2026年5月1日'
export L_DISCLOSURE_FEE='無料'
export L_BUSINESS_HOURS='平日 10:00-18:00'
```

### 2.2 一括置換 (legal page 系のみ対象)

```bash
FILES="components/marketing/marketing-footer.tsx components/brand/logo.tsx app/\(marketing\)/page.tsx app/\(marketing\)/terms/page.tsx app/\(marketing\)/privacy/page.tsx app/\(marketing\)/legal/page.tsx"

# macOS / GNU sed 互換: -i の引数空文字を別途渡す書き方推奨
sed -i.bak "s|{{SERVICE_NAME}}|${L_SERVICE_NAME}|g" $FILES
sed -i.bak "s|{{COMPANY_NAME}}|${L_COMPANY_NAME}|g" $FILES
sed -i.bak "s|{{OPERATOR_NAME}}|${L_OPERATOR_NAME}|g" $FILES
sed -i.bak "s|{{ADDRESS}}|${L_ADDRESS}|g" $FILES
sed -i.bak "s|{{PHONE}}|${L_PHONE}|g" $FILES
sed -i.bak "s|{{EMAIL}}|${L_EMAIL}|g" $FILES
sed -i.bak "s|{{DOMAIN}}|${L_DOMAIN}|g" $FILES
sed -i.bak "s|{{PRICE}}|${L_PRICE}|g" $FILES
sed -i.bak "s|{{JURISDICTION}}|${L_JURISDICTION}|g" $FILES
sed -i.bak "s|{{LAST_UPDATED}}|${L_LAST_UPDATED}|g" $FILES
sed -i.bak "s|{{LAUNCH_DATE}}|${L_LAUNCH_DATE}|g" $FILES
sed -i.bak "s|{{DISCLOSURE_FEE}}|${L_DISCLOSURE_FEE}|g" $FILES
sed -i.bak "s|{{BUSINESS_HOURS}}|${L_BUSINESS_HOURS}|g" $FILES

# 後始末
rm -f $(for f in $FILES; do echo "$f.bak"; done)
```

### 2.3 dry run (確認)

```bash
# 置換予定 hit 件数を事前確認
for f in $FILES; do echo "=== $f ==="; grep -c '{{' "$f" || true; done

# 残置検出 (置換漏れ)
grep -rn '{{[A-Z_]*}}' app/\(marketing\)/ components/marketing/ components/brand/
```

置換完了後 `grep` の結果が空 (または `{` のみ) であれば全置換成功。

---

## 3. 切替時のチェックリスト

本気運用 (実名公開、Stripe Live、本番ドメイン確定) 切替時に確認:

- [ ] `{{COMPANY_NAME}}` を実名 (or 屋号 + 実名) に置換
- [ ] `{{EMAIL}}` を本気運用で監視するアドレスに置換 (Discord 通知のみ依存しない)
- [ ] `{{DOMAIN}}` を Vercel Dashboard で確認した正規 production domain に置換 (`<project>.vercel.app` short URL は使わない、`docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` 参照)
- [ ] `{{PRICE}}` が Stripe Dashboard の Price object と一致しているか確認 (税込・月額表記)
- [ ] `{{JURISDICTION}}` を運営責任者の住所地 (or 事業所所在地) を管轄する地裁に設定
- [ ] `{{LAST_UPDATED}}` / `{{LAUNCH_DATE}}` を実際の制定・施行日に置換 (法務 page は施行日以降に公開、施行日前は draft 扱い)
- [ ] `{{DISCLOSURE_FEE}}` を実運用方針に合わせて確定 (個人事業主は無料 or 実費数百円が一般的)
- [ ] 特商法 page の「請求があった場合は遅滞なく開示」を維持するか、最初から公開に方針転換するか判断 (後者なら `{{OPERATOR_NAME}}` / `{{ADDRESS}}` / `{{PHONE}}` を page 内 dl の dd に書き戻してから sed 置換)
- [ ] Stripe を test mode → live mode に切替えた場合、特商法 page の決済関連記述 (Stripe Customer ID / 課金時期) が変更不要か確認 (text は変更不要のはず)
- [ ] privacy 第6条「外国にある第三者への個人データの提供」の委託先 5 社 (Clerk / Stripe / Neon / Vercel / Google) 構成変更があれば table 修正
- [ ] /app/settings の法務 link / footer link がすべて生きているか (404 にならないか)
- [ ] 商標利用の許諾範囲確認: `{{SERVICE_NAME}}` がサードパーティ商標と衝突しないか

---

## 4. 参照

- 関連 sprint: Phase 1 E-4 (法務 page 整備、`docs/TODO.md` 参照)
- 関連 lesson: `docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` (`{{DOMAIN}}` 設定の罠)
- Phase 2 template 化先: 新規 `nextjs-saas-template` (本 file + 4 法務 file は project 名 placeholder 化のみで再利用可能な構造)
