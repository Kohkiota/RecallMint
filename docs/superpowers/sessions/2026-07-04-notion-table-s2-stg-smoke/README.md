# S2 stg smoke — app-shell + 2段 sticky(2026-07-04・runtime gate)

- 環境: `https://stg.recallmint.nekotest.net`(develop HEAD 337abe8 デプロイ反映確認済)
- ツール: Playwright MCP。対象: 39-card(`17af78ea`)/ `[PERF-SEED] 300-card`(`fb10b7cf`)
- 結論: **①③④⑤⑥ PASS / ② PASS(Minor: 32px document overflow)**。table ページ console error 0。app-shell/bounded 固有リスク(②③⑥)は明示検証。

## stale deploy チェック
thead `position:sticky` / 列ボタン view 切替隣へ移設 / shell `height: calc(100dvh - 93px)` を実測確認 = **S2 最新 build 反映**。stale なし。

## ① 2段 sticky — PASS
container を 1500px 内部スクロール後も thead が container 上端(147)に固定。視覚確認: ナビ + タイトル/日付 chrome + 見出し行が全て上部固定、tbody 行のみ内部スクロール(smoke-02)。実質 nav+chrome+thead の多段固定。

## ② 二重スクロール消去 — PASS(Minor 1 件)
- table container だけが内部スクロール(scrollH 9202/clientH 598)。thead sticky・内部スクロールが主。カード view は document スクロール維持(app-shell 化はテーブル view のみ)を確認。
- **Minor**: shell 高 = `calc(100dvh - 93px)`(shell 自体は viewport ちょうど top93+h667=760)だが、exam-detail-view root の `space-y-1 pb-8`(padding-bottom 32px)が shell 下に付き **document が 32px スクロール可能** = 微小な二重スクロール(app-shell 密封が pb-8 分だけ不完全)。desktop/mobile 共通。**Critical/Important でない**(table 完全機能・内部スクロールが主)。推奨 fix = table-view branch で pb-8 を外す(card view のみ pb-8)or shell 側で吸収。

## ③ mobile 短 viewport(375×667)+ action bar 干渉 — PASS(最重要リスク clear)
- table 領域 clientH 413px(潰れず)・内部スクロール可・thead sticky。タイトル「[PERF-SEED]…」1行 truncate + 日付小(最小 chrome 成立)。列ボタン+view 切替 同一行。
- 行選択で fixed action bar(`fixed inset-x-0 bottom-0 z-40`・h68・top599）出現。選択時 container に `pb-32`(128px)が効き、最下部スクロールで最終行(y524)が action bar(top599)の**上に可視 = occlusion なし**・スクロール噛み合う(smoke-04)。
- (② の 32px document overflow は mobile でも同様・Minor)

## ④ 300-card 仮想化 + scroll 位置保持 — PASS(主リスク段 S2-2 本番)
- 仮想化有効(container scrollH 37822/clientH 598・9→13 行 window)。
- 中間(scrollTop 17688)で sort 条件追加 → **scrollTop 17688 維持(先頭リセットなし)**・行連続 anomaly 0・13 行。
- filter(直近正誤=直近正解)適用 → scrollH 37822→22927 に縮小(件数減)・crash なし・spacer 健全(top/bottom 2)。※seed に 直近正解 マッチが存在し 0 件は未再現(0/1 件は unit + whole-branch 済)。

## ⑤ 列ボタン移設 + 永続 + card 非表示 — PASS
- 「列」ボタンが view 切替(カード/テーブル)と同一行(top 105 ≈ viewToggle 103）。card view で列ボタン非表示・card view は document スクロール維持。
- メモ列 hide → reload → **メモ hidden 維持** + **view=table 復元**(S2-5 単一所有永続 + race fix 実効、列消失なし)。smoke 後に メモ 復元済。

## ⑥ ヘッダーセル全体 trigger + resize 非干渉 + Popover 非 clip — PASS
- trigger button full-width(312/320px）・sort glyph が trigger 内。**glyph(ラベル以外)クリックで menu 起動**(昇順/降順)。
- resize handle クリックで menu 非起動(stopPropagation 有効）。
- **Popover が scroll container 外へ portal**(overflow-auto で clip されず・rect 132-276/175-247 viewport 内）= Radix portal 有効。

## carry Minor 目視
- tags pill 撤去: ヘッダー「タグで絞り込み」は他ヘッダーと chrome 統一で破綻なし(smoke-01)。
- breadcrumb(← 試験一覧)→ タイトル gap: 不自然さなし。

## console
- table ページ全経路で error 0(warning 1 = 無害な dev warning）。
- サインインページ読込時に装飾 SVG(data:image/svg noise pattern)が CSP `img-src` でブロックされる既存 nit 1 件 = S2 無関係・table 非該当。

## 総括
S2 の app-shell + 2段 sticky + element virtualizer + 列 lift + th 全域 trigger は実機で機能。**唯一の実欠陥 = ② の 32px document overflow(root pb-8・Minor・cosmetic）**。OT 判断: 今 fix(1行・要 re-push/re-smoke）or 記録 defer。

---

## ② re-smoke(2026-07-04・scroll-fix 6f548c4 反映確認)= PASS

fix(root を `cn('space-y-1', view === 'card' && 'pb-8')`)デプロイ反映を確認(table view の root className = `space-y-1`・pb-8 なし)。

- **desktop table view**: doc_scrollHeight 760 = viewport 760・**doc_overflow 0px**(前回 32px→0)・document スクロール不可(scrollTop 500 試行→0 維持)。二重スクロール消滅 ✓
- **mobile(375×667)table view**: doc_scrollHeight 667 = viewport・doc_overflow 0px・document スクロール不可 ✓
- **card view 回帰なし**: card view root は pb-8 維持・doc_scrollHeight 25443 ≫ viewport・document スクロール可能 ✓(pb-8 出し分けが正しく card のみ）

② 二重スクロールは desktop/mobile とも完全消滅、card view 非回帰。console error 0。**S2 stg smoke 全項目 PASS 確定**。
