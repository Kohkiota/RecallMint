# S2.0b1 試験詳細スリム化 + OCR ポーリング 2 フェーズ化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) 試験詳細 card 一覧を PC でスリム・mobile で tap target 維持の responsive に。(B) OCR ポーリングを「開始起点・画面非依存」に格上げし 1 本 poll で exam 出現 (フェーズ1) → card 反映/完了停止 (フェーズ2) を回す。

**Architecture:** (A) 既存の Tailwind utility class を base(mobile)=従来 / `md:`=スリム の responsive に書換。display↔edit の box 寸法一致 (layout-shift 防止) は各 breakpoint で維持。(B) poll loop + status context provider を `exams/page.tsx` から `/app` layout へ移設、module-scope signal で upload submit から kick、tick の runGuardedPull を 2 フェーズに拡張。mirror read-only / exam.updated_at 不変は堅持。

**Tech Stack:** Next.js 15 App Router, Tailwind v4, Dexie + dexie-react-hooks, `runGuardedPull` (lib/sync/pull), Vitest + jsdom + fake-indexeddb + @testing-library/react。新規ライブラリなし。

**事前調査 (spec 相当):** `docs/superpowers/sessions/2026-06-01-s2-0b1-presurvey.md` ((A) A-1〜A-5 / (B) 最終調査 軸1-3・方針 L+K)。

---

## 全体ルール (各タスクから参照)

- **TDD 必須**: red → green → commit。UI/spacing 変更は class 検証 or 既存 render test の回帰非導入で担保。logic 変更 (B) は Vitest unit/RTL。
- **絶対ルール**: Clerk owner-scope (全 read `WHERE user_id = ?`) 維持。AI/OCR — poll は `/api/exams/status` (非課金) のみ、**processing が尽きたら必ず poll 停止**、無限/高頻度 poll 禁止 (kick の空振りも上限 tick で停止)。実 API 禁止・mock 必須。
- **mirror read-only 不変**: 表示は Dexie mirror。mirror への書込は pull (runGuardedPull) 経由のみ。楽観 placeholder 行は作らない。
- **exam.updated_at は touch しない** (process.ts:542 凍結維持、presurvey 軸3 結論)。
- **layout-shift 防止**: display mode と edit mode は同一 `sharedBoxChrome` を共有 → 値を変える時も両 mode 同値を保つ (各 breakpoint で一致)。
- **実装方式**: subagent-driven-development (task 単位 fresh subagent + task 間 review)。feat commit は `requesting-code-review` skill 経路を通し `[reviewed]` 付与。
- **コミット**: 各タスク完了で 1 commit。

## File 構成 (touch 一覧)

| File | 役割 | 変更 |
|---|---|---|
| `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` | field cell | sharedBoxChrome(:213) responsive スリム化 |
| `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` | option row/cell | cell sharedBoxChrome(:499) + row container(:345-346) + grid gap(:349) + checkbox(:350-357) + delete btn(:409) responsive |
| `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` | card list | CardContent(:188) / list wrapper(:166) / ul(:184) / empty(:174) spacing responsive |
| `app/(app)/app/exams/[id]/page.tsx` | 詳細 page | 全体 wrapper space-y-6(:38) responsive |
| `lib/exams/ocr-poll-signal.ts` (新規) | OCR 開始 signal (pub-sub) | 新規 |
| `app/(app)/app/_components/exam-status-live.tsx` (移設先) | poll provider + badge | exams/_components から移設 + kick購読 + 2 フェーズ pull + grace |
| `app/(app)/app/_components/exam-status-poll.ts` (移設先) | 純ロジック | exams/_components から移設 (内容不変) |
| `app/(app)/app/exams/_components/exam-list-live.tsx` | 一覧 list | ExamStatusBadge の import path 修正のみ |
| `app/(app)/app/exams/page.tsx` | 一覧 page | ExamStatusProvider wrapper 撤去 (seed は layout へ) |
| `app/(app)/app/layout.tsx` | /app layout | ExamStatusProvider mount + getExamStatusMap seed |
| `app/(app)/app/upload/_components/upload-form.tsx` | upload | handleSubmit(:497) で requestOcrPoll() kick |

---

# Part A: 試験詳細スリム化

## Task A1: 共通 cell/field box chrome の responsive スリム化

**Files:** `inline-text-field.tsx` (sharedBoxChrome :213) / `inline-option-row.tsx` (InlineOptionCell sharedBoxChrome :499)。両者は同一文字列で重複定義。

**目的:** `min-h-11 p-2` 固定 (44px tap target) を、mobile=従来 / PC=スリム の responsive に。display↔edit 一致は両 file 内で共有された同一 chrome により自動保持。

**制約:** 2 file の sharedBoxChrome 値は**同一に保つ** (presurvey A-5「両 mode 一致設計」)。base=`min-h-11 p-2` 維持、`md:` でスリム化 (初期値: `md:min-h-8 md:py-1` = PC 32px・縦 padding 4px、px は p-2 の px-2 を継承)。値は OT smoke 微調整前提。

**完了条件:** display/edit 切替で各 breakpoint の高さ一致 (既存 render test 回帰なし)。`pnpm exec tsc --noEmit` + 既存 `inline-text-field.test.tsx` / `inline-option-row.test.tsx` green + Critical 0 + `[reviewed]`。

## Task A2: option row 構造の responsive スリム化

**Files:** `inline-option-row.tsx` — row container (:345-346 `p-2`)、grid (:349 `gap-2`)、checkbox label (:350 `min-h-11 min-w-11`) + input (:356 `h-6 w-6`)、delete button (:409 `min-h-11 min-w-11`)。

**目的:** PC で行高・余白・チェックボックスを圧縮、mobile は tap target (44px) を残す。

**制約:** base=従来 (`p-2` / `gap-2` / `min-h-11 min-w-11` / `h-6 w-6`)、`md:` でスリム (初期値: container `md:py-1`、grid `md:gap-1`、checkbox label `md:min-h-0 md:min-w-0`・input `md:h-4 md:w-4`、delete `md:min-h-0 md:min-w-0`)。grid 列定義 (:349 の `grid-cols-[...]` / `md:grid-cols-[...]`) と explanation/delete の row/col 配置は**不変** (presurvey A-3、列構造は触らない)。正解 row の bg/border 表現も不変。

**完了条件:** mobile で checkbox/delete が 44px 維持・PC で縮小。`tsc` + 既存 `inline-option-row.test.tsx` / `.debounce.test.tsx` green + Critical 0 + `[reviewed]`。

## Task A3: card list / page spacing の responsive スリム化

**Files:** `inline-card-list.tsx` (CardContent :188 `p-4 space-y-3` / list wrapper :166 `space-y-3` / ul :184 `space-y-2` / empty CardContent :174 `p-6`) / `page.tsx` (全体 :38 `space-y-6`)。

**目的:** PC で card padding・section 間隔・list/page 間隔を圧縮、mobile は従来。

**制約:** base=従来、`md:` でスリム (初期値: CardContent `md:p-2 md:space-y-1.5`、page `md:space-y-3`、list wrapper `md:space-y-2`、ul は据置可、empty `md:p-4`)。見出し「カード (N 件)」の live 計数 (:171) と card 構造は不変。

**完了条件:** PC でスリム・mobile 従来の見た目。`tsc` + 既存 `inline-card-list.test.tsx` / `inline-card-list-live.test.tsx` green + Critical 0 + `[reviewed]`。

---

# Part B: OCR ポーリング 2 フェーズ化 (方針 L+K)

## Task B1: OCR 開始 signal モジュール (pub-sub)

**Files:** Create `lib/exams/ocr-poll-signal.ts` + `lib/exams/ocr-poll-signal.test.ts`。

**目的:** upload submit と layout 常駐 poller を疎結合する module-scope pub-sub。`requestOcrPoll()` (発火) と `subscribeOcrPoll(cb): () => void` (購読解除関数を返す) を提供。

**制約:** SSR 安全 (module-scope set、window 非依存)。多重 subscribe / unsubscribe 冪等。React 非依存の純モジュール。

**完了条件:** unit test green (subscribe→request で cb 発火 / unsubscribe 後は不発火 / 多重購読)。`tsc` + Critical 0 + `[reviewed]`。

## Task B2: poll provider + 純ロジックの app-level 移設

**Files:** Move `exams/_components/exam-status-live.tsx` → `_components/exam-status-live.tsx`、`exams/_components/exam-status-poll.ts` → `_components/exam-status-poll.ts` (+ それぞれの test)。import 修正: `exam-list-live.tsx` (ExamStatusBadge)、`exams/page.tsx`。

**目的:** app-wide provider 化の準備として PullTrigger と同層 (`app/(app)/app/_components/`) へ移設。**この task は移設 + import 修正のみ、ロジック不変**。

**制約:** 中身のロジック変更なし (badge 描画含む無改修)。import は @-alias / 相対を正しく張替え。

**完了条件:** 移設後 `tsc` + 全関連 test (`exam-status-live.test` / `exam-status-poll.test` / `exam-list-live.test`) green + `pnpm build`。refactor (ロジック変更なし) のため commit は `refactor(exams):` + `[no-review]` 可。

## Task B3: provider を 2 フェーズ poll + kick + grace に拡張

**Files:** `_components/exam-status-live.tsx` (+ test) / `_components/exam-status-poll.ts` (+ test、必要なら純ヘルパ追加)。

**目的:** (1) `subscribeOcrPoll` を購読し signal で poll ループを kick 起動。(2) tick の pull を 2 フェーズ化: `nextProcessing.size>0` の tick で `runGuardedPull({reason:'ocr-pending'})` (フェーズ1)、`hasCompletion` true で `runGuardedPull({reason:'ocr-complete'})` + `router.refresh()` (フェーズ2、既存維持)。(3) kick 起動時は processing 未出現でも grace 上限まで poll 継続 (race 吸収)、processing を一度観測したら通常停止に移行。

**制約:** 既存ループ資産 (5s interval / `inFlight` 二重起動防止 / visibilitychange 連動 start-stop) を流用。**停止条件**: processing 観測済なら `nextProcessing.size===0` で恒久停止 (既存)。kick 後 processing 未観測のまま空 tick が `KICK_MAX_EMPTY_TICKS`(=6, 約30s) 連続したら停止 (無限 poll 禁止)。**failed 検知不変**: failed は status map に残り `processingIds` に入らない → 既存の「processing 0 で停止」「15分 fallback は server `deriveExamStatuses`」が無改変 (presurvey 軸1-3 / 軸2-3)。failed-only mount の 1 回 reconcile poll も維持。1 種の `runGuardedPull` で exam/card/tombstone delta を両フェーズカバー (別経路作らない)。

**完了条件:** TDD で検証 — (a) signal で空 status でも poll 起動し grace 上限で停止、(b) processing tick で `runGuardedPull('ocr-pending')`、(c) processing→消滅で `runGuardedPull('ocr-complete')`+`router.refresh()`+停止、(d) failed-only mount は 1 poll のみ・継続 poll せず、(e) processing 0 到達で恒久停止。既存 test 不変通過。`tsc` + Critical 0 + `[reviewed]`。

## Task B4: layout への provider 移設配線 + 一覧 page の wrapper 撤去

**Files:** `layout.tsx` (ExamStatusProvider mount + `getExamStatusMap` seed) / `exams/page.tsx` (ExamStatusProvider wrapper 撤去、ExamListLive はそのまま)。

**目的:** provider を `/app` layout で全ページ祖先として mount し seed を layout RSC で供給。一覧 page は wrapper を外す (badge は layout provider の context を購読)。

**制約:** seed は layout RSC の `getExamStatusMap(userId)` (owner-scope)。seed に processing があれば従来どおり mount poll、空なら kick まで poll しない (perf 維持)。ExamListLive 内 `ExamStatusBadge` は無改修で context 購読継続 (provider が祖先)。PullTrigger 等 既存 layout 子は不変。

**完了条件:** 一覧で processing exam のバッジが従来どおり表示。`tsc` + `pnpm build` + 一覧/詳細関連 test green + Critical 0 + `[reviewed]`。

## Task B5: upload submit からの kick 配線

**Files:** `upload/_components/upload-form.tsx` (handleSubmit :497-504)。

**目的:** OCR 開始 (submit) 時に `requestOcrPoll()` を呼び layout 常駐 poller を kick。processUpload は blocking で開始検知に使えないため client submit を起点とする。

**制約:** `setPhase({kind:'submitting'})` の urgent priority バッチング (:409-412 コメント) を壊さない位置で呼ぶ (fire-and-forget、await しない)。submit がクライアント検証で弾かれない実行経路でのみ kick。kick の空振りは B3 の grace 上限で停止するため安全。

**完了条件:** submit で `requestOcrPoll` が 1 回呼ばれる test (signal mock)。`tsc` + 既存 `upload-form.test.tsx` green + Critical 0 + `[reviewed]`。

## Task B6: failed 検知タイミング非回帰の確認 (OT 依頼 smoke)

**Files:** なし (確認のみ)。

**目的:** kickoff の明示確認点 — layout 格上げで failed バッジ表示・15分 fallback が壊れないこと。

**制約:** B3 の test (d) で failed-only 経路を担保済。加えて stg smoke で「processing→failed 遷移でバッジが失敗表示・poll が停止」を実機確認 (課金 OCR を伴うため OT 依頼、手順は presurvey 軸1-3 準拠)。

**完了条件:** B3 test green + stg smoke 証跡 (session log に記録)。

---

## Self-Review (spec 突合)

- (A) presurvey A-1〜A-5 → A1 (cell/field chrome) / A2 (option row) / A3 (card/page spacing)。responsive 導入・tap target mobile 維持・layout-shift 一致・updated_at 無関係を網羅。
- (B) 方針 L+K / 軸1-3 → B1 (signal) / B2 (移設) / B3 (2 フェーズ+kick+grace+stop) / B4 (layout seed) / B5 (kick 配線) / B6 (failed 非回帰)。1 種 runGuardedPull・mirror read-only・updated_at 不変・poll 停止条件を網羅。
- placeholder なし。型整合: `requestOcrPoll`/`subscribeOcrPoll`、reason `'ocr-pending'`/`'ocr-complete'`、`KICK_MAX_EMPTY_TICKS` をタスク間一貫。
