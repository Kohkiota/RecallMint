# Sprint F(カードビュー freeze 修正)完了記録

- **日付**: 2026-07-15
- **branch**: `develop`(未 push・OT push 待ち)
- **plan**: `docs/superpowers/plans/2026-07-15-sprint-f-cardview-virtualization.md`(v2・OT 承認済)
- **spec**: `docs/superpowers/specs/2026-07-15-sprint-f-cardview-virtualization-design.md`(rev2)
- **fact-finding**: `docs/audit/2026-07-15-b1-scope-reduction-and-cardview-freeze-factfinding.md`
- **実装方式**: subagent-driven-development(実装=CC inline TDD / canonical review=read-only general-purpose subagent + code-reviewer.md template 改変なし / Codex 独立 review / commit=CC)。
  harness 制約(Agent tool は非同期実行 + CLAUDE.md「background agent write auto-deny」)により実装 subagent は使わず CC 本体 inline 実装、review のみ read-only subagent。

## 目的・結論

約 300 件カードのカードビューで inline 編集離脱時に freeze(fact-finding = 未仮想化 O(N) 同期再レンダー・ループでなく枚数/レイアウト起因)。G→W0→W1→W2→S の順で安全網 → 前提ガード 2 件 → 仮想化を着地。**全 gate green・push + OT smoke 待ち**。

## commit 範囲(range `2c853ed..2eb5f87`)

| task | 種別 | fix commit | codex 記録 | tag |
|---|---|---|---|---|
| G | test(安全網)| `2c853ed` | `26b2a0c` | `[reviewed]` |
| W0 | refactor(verbatim 抽出)| `0562508` | `e00de7c` | `[reviewed]` |
| W1 | fix(consume)| `8145ed5` | `85301c4` | `[reviewed]` |
| W2 | fix(commit-on-unmount・**データ保全**)| `30f630c` | `9a257b4` | **tag 無し**(下記)|
| S | fix(仮想化)| `cdae2cf` | `2eb5f87` | `[reviewed]` |

## 各 task の要点

- **G**: option cell「blur 後 unmount で追加書込なし」を pin(= W2 #5 と同一 test・二重実装回避)。Codex 3 周で async wait を Dexie tx 直列化 sync に強化(wall-clock 非依存)。
- **W0**: `InlineCardRow` を module scope へ verbatim 抽出(挙動不変・既存 test 41/41 zero-change green が証明)。`<li>`+key は親 map 温存(S の measureElement 持ち場)。
- **W1**: `newCardIds` に mount 時 consume(`InlineCardRow` の one-shot effect → `consumeNewCardId` functional updater)。list-level test を neuter で RED 確認(非真空)。
- **W2**: `InlineOptionCell` に commit-on-unmount(latestRef + cleanup + blur の editing 同期反映で二重 commit 防止)+ 存在 gate(F6: `runOptimisticUpdate` は missing row でも enqueue するため cards.get で実在確認)。**canonical/Codex 2 周で 2 件の data-loss を検出・修正**: ① `optionsRef` 未同期で後続 handler が edit を上書き(canonical Critical・hook 回帰 test 追加)② gate resolve 時に captured snapshot でなく最新 working-set を commit(Codex P2)。
- **S**: `useWindowVirtualizer`(window スクロール・estimateSize=738 実測 median・overscan=3・getItemKey=card.id・scrollMargin=offsetTop)+ spacer `<li>` + measureElement(margin→pb-2 移行・真の末尾 card は pb なし)+ scrollToIndex(align:'auto')。canonical/Codex 2 周で lint gate(`--max-warnings=0`)Critical を修正。

## ESTIMATED_CARD_HEIGHT 実測記録(2026-07-15・stg)

- **値 = 738**(median 採用)。測定環境 = stg `[PERF-SEED] 300-card exam`(`fb10b7cf…`)カードビュー・Playwright(viewport 1042×575・md/desktop)。
- 分布: n=300(件数一致 ✓)/ min 666 / median 738 / p90 738 / max 828(px)。selector = children>50 の ul 直下 li(選択肢行 li 混入回避)、option checkbox 構造で card 確認。
- **seed 特性の申し送り(重要)**: seed は選択肢 **4 択 298 / 5 択 1 / 7 択 1**、**多択(15-20 択)カードは不在**(実分布 max 828px)。fact-finding の「20 択≈4531px」は UI worst-case で seed には無い。
  - freeze 実証(smoke ①)= 300×738px 未仮想化 = O(N) 再レンダーを十分に突く(枚数支配)ゆえ **有効**。
  - **coverage gap(§9 未検証・OT 確定事項 2026-07-15)**: spec §9「多択行高肥大の measure jitter / scroll 飛び」(smoke ④ 重点)は**本 seed で発火せず、今回の smoke で検証できていない**。
    - ESTIMATED_CARD_HEIGHT=738 に対し**設計上の最過酷ケース(20 択 ≈ 4531px 想定)は実機で一度も走っていない**(738 と 4531 の乖離を突く行が seed に存在しない)。
    - 再燃条件の検証は **実データ投入後(実ユーザーの多択カード出現時)または seed への多択追加時**に持ち越し。
    - **OT 判断: seed への多択カード追加は行わない**(本 sprint 範囲外)。§9 は監視方針として `docs/next-sprints-priority.md` §4 に follow-up 記載。

## 完了 gate(2026-07-15 実行)

- whole-repo `pnpm lint`(--max-warnings=0)**exit 0**。
- `pnpm typecheck`(tsc --noEmit)**exit 0**。
- `pnpm test`(vitest run 全 231 files)**3625/3625 green**。

## OT stg smoke 結果(2026-07-15・全 6 項 PASS)

OT が stg で人力実施。**全 6 項 PASS**:

1. **① PASS(仮説の実証)**: 300 件 seed のカードビューで inline 編集 → blur が固まらない。複数 field で反復済。→ fact-finding の静的 trace 結論(枚数起因・ループ不在)が実機で裏付けられた。
2. **② PASS(W2 データ保全)**: option 編集中 scroll-out → 戻って値が保存されている。
3. **③ PASS(W1)**: 追加カードの誤 auto-edit なし。
4. **④ PASS(描画健全性)**: spacer 飛び・空白帯なし。**ただし多択カードは seed 不在ゆえ §9 は未検証**(下記「§9 未検証」参照)。
5. **⑤ PASS(追加 UX)**: scrollToIndex + auto-edit が従来どおり。`align='auto'` の判断も実機で問題なし。
6. **⑥ PASS(回帰)**: side peek / テーブルビュー無変化。

**参考(追跡不要・記録のみ / §11 監視対象)**: deploy 直後の初回アクセス時に一度だけ「編集→blur で固まりエラー音頻発・ブラウザ不応」が発生したが**再現せず**、Console 残存は**ブラウザ拡張由来ノイズのみ**(`A listener indicated an asynchronous response...` = 拡張の messaging、アプリ由来エラーは無し)。deploy 直後の一過性と判断し**追わない**。**ただし今後同一現象が再発した場合は spec §11 分岐を発火**(ログが無くても現象自体が証拠)。

## W2 の [reviewed] 正記録(データ保全 fix・tag 無し commit)

`30f630c`(W2)は **approved plan + GC v2 W2 前例に従い tag 無し commit**。canonical + Codex は **Crit0/Imp0 で収束済**(formal review 完了)。**OT smoke ②(上記)PASS を確認**:

- [x] **W2 [reviewed] 確定**(2026-07-15): commit `30f630c` の formal review 完了 + OT smoke ②(option 編集中 scroll-out → 保存)実機 PASS をもって **[reviewed] 相当と確定**。push 済 commit の force-push はしない(tag は追わず本 doc を正記録とする = CLAUDE.md「stg smoke を要する重要 Fix」規律)。

## OT smoke checklist(人力・push/deploy 後)

既存 stg `[PERF-SEED] 300-card exam` で:

1. **仮説の実証(最重要)**: カードビューで「inline 編集に入る → 抜ける(blur)」が固まらない。複数 field(問題文/選択肢/解説/メモ)で反復。
2. **W2(データ保全)**: option 編集中に scroll-out(行を画面外へ)→ 戻って値が保存されている。→ pass で W2 [reviewed] 確定。
3. **W1**: 新規カード追加後に scroll して該当行を出し入れしても誤 auto-edit(勝手に編集モード)しない。
4. **S 描画健全性**: 全域 scroll で spacer 飛び・行高 jitter・空白帯がない。件数見出し・空 state・削除・タグ操作が従来どおり。**注意: 本 seed に多択カードが無いため §9 の多択 jitter は本 smoke で検証不可**(§9 再燃条件は別途・監視方針)。
5. **追加 UX**: 「+ カードを追加」→ 新カードへ scroll + 問題文 auto-edit(既存 UX 保持)。
6. **回帰**: side peek 経由の option 編集保存が従来どおり / テーブルビューの cell 編集 enter/exit が無変化(共有 primitive を触るため)。

## 失敗時の扱い(必須分岐・spec §11)

**修正後も 300 件で freeze する場合**: fact-finding の静的 trace 結論(ループ不在・枚数起因)が誤りだったことを意味する。**仮想化で糊塗しない・追加緩和(memo/debounce/overscan 調整)を積まない**。観測事実(どの操作で固まったか・可能なら Performance trace)を添えて **claude.ai へ即上げ(Critical 扱い)**。「固まらないが遅い/scroll jitter」の中間結果は Critical でなく、観測値を記録して OT 判断(§9 再燃条件と照合)。

## 触ったファイル

- `inline-card-list.tsx`(W0 抽出 → W1 consume → S 仮想化)/ `inline-option-row.tsx`(W2 latestRef + cleanup + DRY 化)/ `use-card-options.ts`(W2 existence-gated unmount save + optionsRef 同期)/ 対応 test(G/W1/W2/S + hook 回帰)。
- 新 dep なし(`@tanstack/react-virtual` 導入済)。migration なし。`.env` 変更なし。
