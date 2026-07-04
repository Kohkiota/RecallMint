# Notion 式テーブル S2 追補(S2b)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)。

**Goal:** ① scroll で中間帯(タイトル/日付 + view 切替/列ボタン + 条件バー)を collapse(B)② 「← 試験一覧」撤去 + 右下 scroll-top ボタン(A)③ 条件バー 2 ゾーン化 + タグ個別 chip + 文言変更(C)。

**Architecture:** spec `docs/superpowers/specs/2026-07-04-notion-table-s2b-followup-design.md`(commit f15e14e)§3-5 が設計判断の正本。本 plan は task 分割と各段検証のみ(設計理由は spec 参照)。spec §8 論点 1-5 は推奨案で本 plan を構成 — OT 承認で変更が入れば該当 task を改訂して確定。

**Tech Stack:** Next.js 16 / TanStack Table + Virtual / Tailwind v4 / shadcn Button + lucide-react(導入済)/ Vitest / stg smoke(DevTools・Playwright MCP)。

## Global Constraints(全 task 共通・spec §6)

- predicate 層 / S1 registry(`cardTableFilterEditors` / `deriveConditions` 契約)/ `undefined` 解除規約を不変。tags 特例は ConditionBar 内 `columnId === 'tags'` 分岐に局所化。
- S2 確定事項を壊さない: app-shell 密封・element virtualizer(`getScrollElement`)・thead `sticky top-0`・**scroll 保持**(filter/sort/view/列変更で scrollTop 非リセット。collapse も scrollTop を書き換えない)。
- 回帰範囲 = `page.tsx` / `exam-detail-view.tsx` / `exam-card-table.tsx` / `exam-card-table-condition-bar.tsx` + 対応 test。**app-header.tsx 非変更**。card view・inline 編集・side peek へ波及禁止。
- 固定 px 高さ禁止(viewport 追従)・YAGNI・既存パターン踏襲・scope 外リファクタ禁止。
- 各 task 完了 = TDD + 対象 test green + `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green + canonical review(`superpowers:requesting-code-review`・template 改変なし)+ Codex review(`scripts/ai/codex-review.sh`)両者 Critical/Important 0 → controller が `[reviewed]` commit(実装 subagent は commit しない)。review 観点 list に whole-repo lint 実行確認を含める。
- `git commit --no-verify` / `-n` 禁止。push は OT。

## File 構成(確定)

- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table.tsx`(S2b-1 scroll 信号 + ConditionBar wrapper collapse / S2b-2 ScrollTopButton render)
- Modify: `app/(app)/app/exams/[id]/_components/exam-detail-view.tsx`(S2b-1 table-chrome collapse 受信)
- Modify: `app/(app)/app/exams/[id]/page.tsx`(S2b-2 戻るリンク + AppContainer wrapper 撤去)
- Modify: `app/(app)/app/exams/[id]/_components/exam-card-table-condition-bar.tsx`(S2b-3 2 ゾーン + tags 個別 chip + 文言)
- 各 `.test.tsx` を対応追加/更新(condition-bar.test / exam-card-table.test / exam-detail-view.test)。

## Task 間 interface(先に凍結)

- **scroll 信号**: ExamCardTable 内 state `collapsed: boolean`。container `onScroll` → rAF throttle → 閾値判定(collapse: `scrollTop > 24` かつ 短コンテンツ guard `scrollHeight - clientHeight - 中間帯実測高 >= 8` / expand: `scrollTop < 8`)→ boolean 変化時のみ setState。
- **伝播 prop**: `ExamCardTableProps` に `onCollapsedChange?: (collapsed: boolean) => void` を追加。exam-detail-view が受けて table-chrome を collapse。
- **collapse 方式**: wrapper `grid grid-rows-[1fr] transition-[grid-template-rows]` ↔ `grid-rows-[0fr]` + inner `min-h-0 overflow-hidden`(unmount しない)。transition 150-200ms + `motion-reduce:transition-none`。
- **collapsed 初期化**: 初期値 false。ExamCardTable remount で false から再出発、exam-detail-view 側 state は table view 離脱時にリセット(stale collapse 禁止)。
- **ScrollTopButton**: ExamCardTable 内 render。表示 = `collapsed && selectedIds.length === 0`。`data-testid="scroll-top-button"` / `aria-label="先頭へスクロール"`。click = `containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })`。
- **tags chip testid**: `condition-chip-filter-tags-{optionId}`(option 単位ユニーク。optionId = UUID ゆえ sanitize 不要)。sort/他 filter chip の testid 不変。

---

### Task S2b-1: 中間帯 collapse(B)

**目的**: container scroll で collapsed 信号を導出し、ExamCardTable 自身の ConditionBar wrapper と(onCollapsedChange 経由で)exam-detail-view の table-chrome を grid-rows 方式で畳む。collapse 中は app-header + thead の 2 段固定、scrollTop≈0 で復帰。
**制約**: Global。interface 凍結節の信号仕様(閾値 24/8 + hysteresis + 短コンテンツ guard・rAF throttle・boolean 変化時のみ setState)。scrollTop を書き換えない(scroll 保持)。unmount しない(popover state / ResizeObserver churn 回避)。virtualizer の getScrollElement/内部 listener に触らない。shellTop 実測 effect(exam-detail-view)は不変。card view branch 不変。
**完了条件**: (a) 閾値/hysteresis/guard の判定ロジック test(scrollTop・scrollHeight・clientHeight・帯高を与えて collapsed 遷移を固定 — 判定を純関数に切り出して直接 test 可)(b) collapsed 時に chrome/ConditionBar wrapper へ collapse class、復帰で解除、の構造 test(onScroll 発火は jsdom で dispatchEvent + 値 stub)(c) onCollapsedChange 伝播 test(d) remount/view 切替で collapsed=false リセット test。full-dir green + lint/typecheck exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。実 collapse 挙動・sticky 連続・popover エッジ(条件バー editor 開いたまま collapse — 実害基準 = 操作不能/画面外/誤操作誘発なら対応、位置不自然のみは記録)は stg smoke ②④。

### Task S2b-2: 戻るリンク撤去 + scroll-top ボタン(A)

**目的**: page.tsx の「← 試験一覧」Link と AppContainer wrapper を撤去(`ExamDetailPullGate` は素で残す = null render)。ExamCardTable に ScrollTopButton(fixed 右下 `right-4 bottom-4` 目安・`Button variant="outline" size="icon-lg"` 36px + lucide `ChevronUp` + `rounded-full shadow-sm`)を追加し、S2b-1 の collapsed 信号を消費して表示制御。
**制約**: Global。interface 凍結節の表示条件(`collapsed && selectedIds.length === 0` = 選択時 action bar との z/クリック競合を構造回避)と click 挙動。導線はナビ「試験」で代替(他の戻る導線を足さない)。card view の上部余白変化は許容(意図したスペース節約)、それ以外の card view 変更禁止。z は action bar(z-40)未満で可(同時表示なし)。mobile 下端は `bottom-4` 基本 + safe-area は stg 確認で必要時のみ `env(safe-area-inset-bottom)` 加算(先回り実装しない)。非表示化 = unmount(focus 消失許容)。
**完了条件**: (a) page.tsx から Link 消滅 + ExamDetailPullGate 残存の test(exam-detail 系 render test 更新)(b) ScrollTopButton の表示条件 3 態(collapsed=false 非表示 / collapsed=true 表示 / collapsed=true かつ選択中 非表示)+ click で scrollTo 呼出(containerRef spy)の test。full-dir green + lint/typecheck exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。先頭スクロール実挙動・smooth の jank 判定(jank 時 instant へ)は stg smoke ①。

### Task S2b-3: 条件バー 2 ゾーン + タグ個別 chip + 文言(C)

**目的**: ConditionBar render を [sort ゾーン | 縦区切り(両ゾーン非空時のみ)| filter ゾーン + クリア(ml-auto)] に再構成。sort chip label から「並び替え: 」削除。tags フィルタを選択 option ごとの個別 chip(`{カテゴリ名}: {option 名}`・`colorToClass(option.color)` 色付き・chip body = CardTagAddPopover trigger 維持・× = その option のみ除去)へ展開。「すべてクリア」→「クリア」。
**制約**: Global。`deriveConditions` の生成契約不変(振り分けは render 側)。回答状態/連続正解数 chip・flip・×・全クリア挙動・sort/他 filter testid 不変。option 除去は既存 `handleTagsChipToggle` の除去経路(空カテゴリ prune + 空 map → undefined)を再利用し新経路を発明しない。欠損 option/category は optionId label 無彩色 fallback + × 機能。tags chip testid = interface 凍結節どおり。
**完了条件**: condition-bar.test 更新 + 新規: (a) ゾーン振り分け(sort 左 / filter 右)+ 区切り表示 3 態(左空/右空/両空)(b) sort chip プレフィックス無し label(c) tags 2 option 選択 → chip 2 個(色 class + label + option 単位 aria-label)→ 片方 × → value から該当 option のみ消え chip 1 個(d) 全 option × → filterValue undefined(dot 消灯は既存 test 流用)(e) 欠損 option fallback(f) 「クリア」文言 + 全解除(g) chip × click で CardTagAddPopover が開かない(stopPropagation)。full-dir green + lint/typecheck exit0 + canonical/Codex Crit・Imp 0 → `[reviewed]`。色の実表示・2 ゾーン視覚・mobile 折返しは stg smoke ③④。

---

## S2b 完了 gate(全 task commit 後・OT push 前)

- **whole-branch review(opus)**: cross-task 相互作用(collapse × sticky × virtualizer × 条件バー改修 × scroll-top、S2 本体からの回帰)。Critical/Important 解消まで完了としない。carry Minor を triage。
- whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit 0(報告に明記)。
- **stg smoke(OT push 後・stg URL・ツール CC 裁量)**: ① scroll-top ボタン(container 先頭へ・少スクロール時非表示・選択中非表示)② scroll で中間帯 collapse → app-header + thead 2 段固定・先頭で復帰・scroll 保持と非干渉・短コンテンツでちらつき無し ③ 条件バー 2 ゾーン・sort プレフィックス無し・タグ個別 chip 色付き・個別 × で option 単位解除・「クリア」文言・タグ全解除で dot 消滅 ④ mobile での collapse / scroll-top(safe-area 下端)/ 条件バー折返し(クリアの回り込み)⑤ card view の上部余白変化が意図どおり(戻るリンク撤去の波及確認)。証拠(snapshot/console/IDB)添付。
- Sprint 境界 = OT 判断で停止。

## 実装順序 / 停止条件

- S2b-1 → S2b-2 → S2b-3 直列(S2b-2 の表示条件が S2b-1 の collapsed 信号を消費。S2b-3 は独立だが直列維持で review 負荷平準化)。各段単独 smoke 可能。
- Critical 検出は CC が修正試行 → 未解決のみ即上げ(自走継続条件)。仕様解釈揺れ・外部設定変更要・sprint 完了で停止。

## Minor 記録(whole-branch triage 用)

- (現時点なし。per-task review 発生分を controller が記録し S2b 締めで triage)
