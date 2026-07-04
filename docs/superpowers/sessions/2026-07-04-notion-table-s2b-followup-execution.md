# S2b(Notion テーブル追補)実装セッション記録

- 日付: 2026-07-04 / branch: develop / 実行方式: `superpowers:subagent-driven-development`(RecallMint 規律 = review-before-commit)
- spec: `docs/superpowers/specs/2026-07-04-notion-table-s2b-followup-design.md`
- plan: `docs/superpowers/plans/2026-07-04-notion-table-s2b-followup.md`
- 起点 HEAD: 3d2dbe0 / 完了 HEAD: (S2b-3 docs commit)

## 実装結果(全 task Critical 0 / Important 0 で [reviewed])

| task | 内容 | feat commit | canonical | Codex |
| --- | --- | --- | --- | --- |
| S2b-1 | scroll で中間帯 collapse(container onScroll → computeCollapsed 純関数 + rAF throttle + grid-rows 0fr/1fr + inert) | 8e49db6 | Approved(Crit0/Imp0/Min1) | r1 Imp1(a11y)→fix / r2 clean |
| S2b-2 | 「← 試験一覧」撤去 + 右下 scroll-top ボタン(collapsed && 非選択時) | ba7f246 | Approved(Crit0/Imp0/Min2) | clean |
| S2b-3 | 条件バー 2 ゾーン + タグ個別 chip(色付き・option 単位 ×)+ 「クリア」文言 | ab940b2 | Approved(Crit0/Imp0/Min3) | clean |

- 各 docs(codex)記録: `docs/codex/2026-07-04-s2b-1-collapse.md` / `-r2.md` / `-s2b-2-scrolltop.md` / `-s2b-3-condbar.md`
- fix round: S2b-1 で Codex a11y Important(collapsed control が tab order 残存)→ collapsed 時 inner content に `inert` 付与で解消(canonical Minor 3 件も同 round で吸収)。

## whole-branch review(opus・3d2dbe0..HEAD)

✅ ready to merge / Critical 0 / Important 0 / Minor 1(cosmetic)。cross-task 8 点全 OK。詳細は下記「Minor triage」。

### 検証された cross-task 相互作用
- collapse × virtualizer: onScroll と virtualizer listener は同一 element でも独立(scroll 非 bubble)。collapse で flex-1 container の clientHeight 増 → 既定 ResizeObserver が row window 再計算。rAF throttle + boolean 変化時 setState ゆえ thrash なし。
- collapse × sticky thead: chrome/condBar wrapper は scroll container の外の sibling ゆえ thead sticky は flush 維持。
- scroll 保持: collapse path は scrollTop 非書換。short-content guard(`scrollHeight-clientHeight-中間帯実測高>=8`)で collapse↔expand 振動を代数的に排除。
- scroll-top × action-bar: `collapsed && selectedIds===0` vs `selectedIds>0` = selectedIds で相互排他、同一 render commit で swap(両表示フレームなし・z-30/z-40 非共存)。
- condbar × collapse: tag chip 増で middleBandHeight 増 = guard が正しく多い scrollHeight を要求。CardTagAddPopover は portal ゆえ inert 非影響。
- page.tsx wrapper 撤去: ExamDetailView 上位の AppContainer(ExamDetailPullGate=null render のみ包む)撤去。card view は ExamDetailView 内の自前 AppContainer 維持で不変。shellTop 実測が新開始位置へ追従。

## Minor triage(whole-branch・全件 defer)

- S2b-1: `handleScroll` useCallback deps に安定 ref(chromeRef)列挙 — cosmetic。
- S2b-2 M1: page.test.ts `toContain('ExamDetailPullGate')` が import にも match / M2: page.tsx source-level assertion(async server component + Clerk/Drizzle で jsdom render 不可・YAGNI 許容)。
- S2b-3 M1: sort-flip test が positional `getAllByRole('button')[0]` / M2: stopPropagation test(g)は × と trigger が sibling ゆえ機構未 probe(観測結果は正)/ **M3: chip-body→popover-open 経路が未 test(follow-up 最有力)**。

## gate

- whole-repo `pnpm typecheck` exit 0 / `pnpm lint --max-warnings=0` exit 0。
- full-dir vitest: S2b-3 時点で 2649 pass。

## 残(OT / 次アクション)

- push は OT。push 後、stg smoke(①scroll-top ②collapse ③条件バー2ゾーン ④mobile ⑤card view 余白)を OT 指示で別 kickoff(CC 裁量ツール)。
- follow-up 候補(別 task 起票): S2b-3 M3(chip body が ConditionBar 文脈で CardTagAddPopover を開く経路の test)。

---

## stg smoke 結果(OT push 後・deploy b469712 反映確認済・全項目 PASS)

環境: stg.recallmint.nekotest.net / PERF-SEED 300-card exam / Playwright MCP / desktop 1280×900 + mobile 375×812。証拠スクショ = `docs/superpowers/sessions/assets/s2b-*.png`。
deploy 反映確認: 「← 試験一覧」消失 + `[data-testid=cond-bar-wrapper]` 出現で S2b live 確定(初回 2 回は stale=旧コードで中止→ OT 再デプロイ後 fresh)。

### ② 中間帯 collapse(最重点)= PASS
- scrollTop 400 で collapse: table-chrome grid-rows 53.75px→0px・inert 付与・thead が top 45(app-header 44px 直下)= **app-header + thead の 2 段固定**。scrollTop≈0 で復帰(grid-rows 53.75px・inert 解除)。証拠 = s2b-collapsed-desktop.png。
- **振動 / 短コンテンツ guard(最重点)= PASS**: container の scrollHeight/clientHeight/scrollTop を上書きし実 onScroll ハンドラを駆動して境界検証(middleBand 実測 94px)。
  - overflow 100(<102=middleBand+8)→ collapse **ブロック**(false)= 振動 zone を guard が阻止。
  - overflow 154 → collapse(true)。overflow 102(境界)→ collapse(true)。
  - hysteresis: scrollTop 15(8–24)は前状態維持(true)、scrollTop 5(<8)で expand(false)。
  - 実データ 0 行(≥14 filter)= overflow 0 で collapse 非発火(scrollTop 動かず)。
- **scroll 保持 = PASS**: collapse 中に sort 適用 → scrollTop 4494(0 非リセット)・collapse 維持。filter 適用 → scrollTop 1735(0 非リセット)。数値ドリフトは可変行高 virtualizer の measureElement 再計測(既存 S2 挙動・S2b 非関与)。

### ① scroll-top ボタン = PASS
collapse 中に右下出現(36×36・fixed right/bottom 16px)→ click で container を scrollTo top(smooth)+ chrome 展開 + inert 解除 + ボタン消失。先頭(非 collapse)では非表示。

### ③ 条件バー 2 ゾーン = PASS
- sort chip「問題文 ↑×」= **プレフィックス無し**。ソートのみ時は区切り非表示、sort+filter 両方で `zone-separator` 出現。
- タグ個別 chip: `condition-chip-filter-tags-{UUID}`・「難易度: 難×」「難易度: 中×」・色付き(難=red-200 / 中=yellow-200、colorToClass)。他 filter(連続正解数)は無彩色。× aria-label は option 単位。
- 個別 × で該当 option のみ除去(難 × → 中 残存)、全 option 除去で dot 消灯(undefined 解除)。「クリア」文言で全消去 + バー height 0 シュリンク。
- chip 本体クリックで CardTagAddPopover 開く(aria-expanded true)= plan M3 の未 test 経路を live で確認。証拠 = s2b-condbar-2zone.png / s2b-tag-chips-colored.png。

### ④ mobile 375px = PASS
collapse(chrome→0・nav+thead 2 段)+ scroll-top 右下(bottom 16px)。条件バーは flex-wrap で 2 行折返し(sort=灰 / タグ=色付き)+「クリア」右配置、崩れなし。証拠 = s2b-mobile-collapsed.png / s2b-mobile-condbar-wrap.png。
※ iOS safe-area(home indicator)は Playwright emulation で inset 非適用ゆえ未検証 = 実機確認は spec 通り deferred(bottom-4 + 36px で下端 52px は確保)。

### ⑤ card view 余白 = PASS
戻るリンク撤去でタイトルが nav 直下(top 45)= スペース節約が意図どおり。カード一覧・切替 toggle 正常、崩れなし。証拠 = s2b-cardview-margin.png。

### console
S2b 関連エラー 0。既存の Permissions-Policy header 警告 + Clerk dev-key 警告(stg 恒常)のみ。/sign-out 404 は smoke 中の手動ナビ(アプリ通常フロー外・S2b 無関係)。

### 総括
全 5 項目 PASS。Critical / Important な回帰・破壊なし。振動(最重点)は短コンテンツ guard が境界で正しく collapse を抑止することを実ハンドラ駆動で確認。
