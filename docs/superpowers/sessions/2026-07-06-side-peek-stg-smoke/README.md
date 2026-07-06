# side peek stg smoke(2026-07-06・push 後)

- 対象: https://stg.recallmint.nekotest.net/app/exams/fb10b7cf-…(`[PERF-SEED] 300-card exam`)
- 経路: Playwright MCP(devcontainer)。develop = 4db2151(origin 同期・push 済)。
- 結果: **全 smoke 項目 PASS / console errors 0(全セッション 15 msg 中 error 0)**。データは全マーカー復元済(clean baseline)。

## 結果一覧(実ブラウザ検証)

| # | 項目 | 結果 | 証拠 |
|---|---|---|---|
| ★1 | **[最優先] Esc layer stack**: peek 内 tag popover 開 → Esc で popover のみ閉じ peek 残存 → 2nd Esc で peek 閉 | ✅ | popover: expanded true→false・peek open 維持 / 2nd Esc: dialog 0。列メニューでも再現(Esc で menu のみ閉・peek 残存) |
| 2 | peek open: トリガー click → slide-in・width 480px・z-45・aria-pressed=true・全フィールド描画 | ✅ | smoke-peek-open.png |
| 3 | peek 編集 → テーブル即反映(memo) | ✅ | peekMemo === tableMemo("SMOKE-6JUL-peek→table") |
| 4 | テーブル編集 → peek 即反映(title・live 追従) | ✅ | peek title に "[SMOKE-table→peek]" 反映 |
| 5 | non-modal 併用: peek 開状態で背面テーブルセル click → peek 残存 + セル編集起動 | ✅ | peekStillOpen=true・tableEditStarted=true |
| 6 | **card 切替 option commit(M1 focus-steal)**: option 編集中に別行トリガー click → 切替前に blur→commit | ✅ | card1 opt0 に "[SMOKE-switch-commit]" commit・peek は card2 表示 |
| 7 | × close | ✅ | peekOpenAfterX=false |
| 8 | Esc close | ✅ | 2nd Esc で dialog 0 |
| 9 | 仮想化 scroll-out で peek 維持: active 行 unmount しても peek 残存 | ✅ | scrollTop 8771・row unmount(false)・peek は card 0001 表示継続 |
| 10 | ActionBar(z-40)共存: 行選択 → peek(z-45)と ActionBar 同時表示 | ✅ | smoke-peek-actionbar-coexist.png・peekZ=45 / barZ=40 |
| 11 | **フィルタで peek 閉じない(prune は削除時のみ)**: title フィルタで active card をテーブル除外 → peek 残存 | ✅ | card1 table 除外(可視1行)・peek は card 0001 表示継続 |
| 12 | mobile(375px): table view トリガー常時表示(opacity 1)・peek 全幅(375=viewport)・× close | ✅ | smoke-mobile-fullwidth-peek.png |
| 13 | console errors 0(全セッション) | ✅ | 15 msg / error 0(warning は Permissions-Policy・Clerk dev-keys = 環境由来・非関連) |

## 環境 artifact(prod bug ではない)

- **desktop hover-reveal トリガー**は自動ブラウザで視覚再現不可。理由: この Playwright ブラウザは `(hover: hover)` = false / `(hover: none)` = true を報告。生成 CSS は `.md\:group-hover\/peek\:opacity-100` を **`@media (hover:hover)` でゲート**(Tailwind v4 標準)しており、CSS 本文 fetch で存在確認済。**実マウス desktop(`hover: hover`)では正常に hover で出現**する。トリガーは opacity 0 でも機能(clickable)し、`md:focus-visible:opacity-100` も生成済(keyboard focus で出現)。mobile は base `opacity-100` で常時表示(#12 で確認)。
- T1 で懸念した radix "Missing Description" 警告は F4(Dialog.Description)で解消 — smoke 中も出ず。

## 未実施(理由付き・残リスク低)

- 削除 → prune close: seed data 破壊回避。unit test T3⑤ + フィルタ非 close(#11)で prune 設計は担保。
- 正解 checkbox toggle: option primitive の commit 経路は #6(option text 編集 commit)で実行済 = 同経路。
- sticky header / pinning 回帰: side-peek は title cell への button 追加 + root overlay のみ(header/pinning コード不変)。sort/filter は #11 で実行(適用+クリアで再描画正常)。S5 pinning は当該 sprint で smoke 済。
