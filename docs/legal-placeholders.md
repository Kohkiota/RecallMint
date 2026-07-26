# 法務 page プレースホルダ管理

最終更新: 2026-05-17 (SERVICE_NAME placeholder 撤回、 12 placeholder 体制に縮減)

対象 file:
- `app/(marketing)/terms/page.tsx` (利用規約)
- `app/(marketing)/privacy/page.tsx` (プライバシーポリシー)
- `app/(marketing)/legal/page.tsx` (特定商取引法に基づく表記)

各 file 内の `{{...}}` リテラル文字列 (JSX 上は `{'{{...}}'}` 表記) は本気運用
切替時に sed 一括置換する。 法務本文の固定値 (戸籍名・連絡先・住所・価格・
制定日等) を git 直書きしない運用 (strategic / personal value は Obsidian 管理)
を支える sed 置換 system。

**SERVICE_NAME placeholder 撤回** (2026-05-17):
chrome / footer / logo / hero の `{{SERVICE_NAME}}` は `"RecallMint"` hardcode
に統一済（本 repo は RecallMint 固有 product ゆえ service 名を placeholder 化しない）。 残る 12 placeholder は
本気運用切替時の fill-in 値 (個人情報 / 価格 / 日付等) として sed 置換で運用。

---

## 1. プレースホルダ一覧 (12 項目、 SERVICE_NAME 撤回後)

| # | プレースホルダ | 仮値の例 | 用途 / 出現 page |
|---|---|---|---|
| 1 | `{{COMPANY_NAME}}` | `<戸籍上氏名>` (個人事業主は本名、屋号併記可) | terms 冒頭 / privacy 第1条 / privacy 第11条 |
| 2 | `{{OPERATOR_NAME}}` | `<戸籍上氏名>` | 特商法「運営責任者」(請求時開示前提なら現状未使用) |
| 3 | `{{ADDRESS}}` | `〒XXX-XXXX 都道府県市区町村...` | 特商法「所在地」(請求時開示前提なら現状未使用) |
| 4 | `{{PHONE}}` | `XX-XXXX-XXXX` | 特商法「電話番号」(請求時開示前提なら現状未使用) |
| 5 | `{{EMAIL}}` | `support@example.com` | privacy 第9・11条 / 特商法 冒頭・dl |
| 6 | `{{DOMAIN}}` | `<your-vercel-app>.vercel.app` | 特商法「ホームページ URL」 |
| 7 | `{{PRICE}}` | `990 円` | terms 第4条 / 特商法「販売価格」 |
| 8 | `{{JURISDICTION}}` | `東京地方裁判所` | terms 第15条 (専属合意管轄裁判所) |
| 9 | `{{LAST_UPDATED}}` | `2026年4月30日` | 各 page 末尾「制定」 |
| 10 | `{{LAUNCH_DATE}}` | `2026年5月1日` | terms / privacy 末尾「施行」 |
| 11 | `{{DISCLOSURE_FEE}}` | `無料` (or `1,000 円` 等) | privacy 第9条 4項 (開示請求手数料) |
| 12 | `{{BUSINESS_HOURS}}` | `平日 10:00-18:00` | 特商法「営業時間」 |

`{{OPERATOR_NAME}}` / `{{ADDRESS}}` / `{{PHONE}}` は現状の特商法 page では「ご請求があった場合は遅滞なく開示」固定 text を採用しているため**未使用**。本気運用で「最初から公開」に方針転換した場合、特商法 page の該当箇所を `{'{{OPERATOR_NAME}}'}` 等に書き換えてから sed 置換する (この 3 placeholder は将来「最初から公開」方針に転換する場合に備え残置)。

---

## 2. 本気運用時の sed 一括置換手順

### 2.1 値の準備

下記を `.env.production-legal` 等の **コミットしない** ファイルに用意してから export:

```bash
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

### 2.2 一括置換 (法務 3 page が対象)

```bash
FILES="app/\(marketing\)/terms/page.tsx app/\(marketing\)/privacy/page.tsx app/\(marketing\)/legal/page.tsx"

# macOS / GNU sed 互換: -i の引数空文字を別途渡す書き方推奨
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
grep -rn '{{[A-Z_]*}}' app/\(marketing\)/
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
- [ ] 商標利用の許諾範囲確認: brand 名 "RecallMint" がサードパーティ商標と衝突しないか (本確認は hardcode のため本 sed 手順とは独立、 service rename 時に別途実施)

---

## 4. 参照

- 関連 sprint: Phase 1 E-4 (法務 page 整備、`docs/TODO.md` 参照)、 2026-05-17 (SERVICE_NAME 撤回)
- 関連 lesson: `docs/superpowers/lessons/2026-04-29-vercel-domain-confusion.md` (`{{DOMAIN}}` 設定の罠)
