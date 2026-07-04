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
