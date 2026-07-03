# Notion 式テーブル S1 — セッション handoff(次セッション復帰用)

- 作成: 2026-07-03 / branch: develop / HEAD: e9e218e
- 実装方式: superpowers:subagent-driven-development(RecallMint 規律に適応 = review-before-commit)
- SDD ledger(正本): `.superpowers/sdd/progress.md` の「Notion 式テーブル S1」節。本 doc はその committed バックアップ + S1-5 詳細。

## 進捗サマリ

| task | 状態 | commit([reviewed]) | review |
|---|---|---|---|
| S1-1 ヘッダーメニュー+sort動的化 | ✅完了 | 86629aa | canonical Crit0/Imp0/Min4 + Codex 0/0/0 |
| S1-2 動的条件バー shell | ✅完了 | 25df3a9 | canonical 0/0/1 + Codex 0/1(cosmetic・Minor裁定) |
| S1-3 既存3フィルタ動的化 | ✅完了 | e736841 | canonical 0/0/3 + Codex 0/0/0 |
| S1-4 適用中インジケータ | ✅完了 | 5849345 | canonical 0/0/1 + Codex 0/0/0 |
| S1-5 固定バー撤去+wrapper再定義 | ⬜未着手 | — | — |
| S1 締め whole-branch review(opus) | ⬜未着手 | — | — |

- docs/codex 記録も各 commit 済。working tree クリーン。push は未(全 commit ローカル・OT が push)。
- plan: `docs/superpowers/plans/2026-07-03-notion-table-s1.md` / spec: `docs/superpowers/specs/2026-07-03-notion-table-s1-design.md`(凍結)。

## 再開手順(次セッション)

1. `.superpowers/sdd/progress.md` と本 doc を読む。S1-1〜S1-4 は DONE = 再 dispatch 禁止。
2. S1-5 を subagent-driven で実装。review-before-commit 規律: implementer は commit しない → 未 commit diff に canonical(superpowers:requesting-code-review general-purpose opus + template 改変なし)+ Codex(`scripts/ai/codex-review.sh --uncommitted`)→ Crit0/Imp0 → controller が [reviewed] commit。Codex は python3(環境に jq 無し)。
3. S1-5 後: whole-branch review(opus)(範囲 c913bab..HEAD 相当の S1 実装差分)→ Crit/Imp 解消 → whole-repo `pnpm lint --max-warnings=0` + `pnpm typecheck` exit0 → 報告。push 前 local smoke ①②③⑤(dev + DevTools MCP)。stg smoke は OT push 後。
4. Sprint 完了で停止(OT 判断)。

## S1-5 実装内容(brief は scratchpad 揮発ゆえここに封入)

plan §S1-5(L81-89)+ Global Constraints(L10-45)が正。要点と確定済の test 波及判断:

### やること

1. 削除: `exam-card-table-filter-bar.tsx` + `exam-card-table-filter-bar.test.tsx`。
2. `exam-card-table.tsx`: `import { ExamCardTableFilterBar }` と `<ExamCardTableFilterBar .../>` mount を除去。filterBarWrapperRef wrapper は [ConditionBar, ColumnVisibilityToggle] の 2 児となる=最終レイアウト。ref のコメント更新(名前 rename は任意・全 use 一致条件)。ResizeObserver/listOffset の計算ロジックは不変(測る子が変わるだけ)。
3. test 波及(判断枠組み: 「固定バーを filter 設定手段に使っただけ」→新 UI へ re-point / 「固定バー固有挙動の test」→削除):
   - `exam-card-table-condition-bar.test.tsx`: describe('FilterBar + ConditionBar coexistence: streak sync after external clear')(≈L343)は固定バー固有 → 削除。`getByTestId('exam-card-table-filter-bar')` で tag を設定していた test(≈L320-338「タグ: 1 件」summary)は、新 tags header CardTagAddPopover 経由へ re-point(または S1-2 で追加済の summary-label test と重複なら削除・要カバレッジ確認)。chip × の /フィルタを解除/ query は ConditionBar 対象ゆえ維持。
   - `exam-card-table.test.tsx`: describe('Fix-1 T2: 回帰 — filter-bar / TagCell の tagEditCallbacks は不変')(≈L453)は削除される固定バーの tag popover 対象 → 削除可。理由: filter 文脈の tag editor は selectOnly(tagEditCallbacks なし)ゆえ leak が構造的に不可能で、その selectOnly 保証は `exam-card-table-filter-editors.test.tsx` の「selectOnly で新規作成/編集導線が非表示」(≈L352)が既にカバー(削除前に現物確認せよ)。file 冒頭コメント(≈L11 の filter-bar 言及)も更新。
4. aria/コメント: ConditionBar chip × の `aria-label="フィルタを解除: …"`(「を」あり)は固定バー削除後は唯一の label ゆえ維持(文法的に自然)。「を」-vs-なし の disambiguation コメント(condition-bar.tsx ≈L241-242)のみ除去。filter-editors.tsx / card-filter-labels.ts の「moved from filter-bar」provenance コメントは残置可。
5. 完了確認: `grep -rn "ExamCardTableFilterBar" app/` が live 参照ゼロ。full-dir `pnpm vitest run "app/(app)/app/exams/[id]"` 全 green(filter-bar.test が skip でなく消滅)+ typecheck + whole-repo lint --max-warnings=0 exit0。

### 実装者へ渡す注意

- delicate file(仮想化/memoized body/resize handle/selection prune/S1-1..S1-4 wiring)に触れない。
- Fix-1 T2 削除でカバレッジが失われるなら削除せず NEEDS_CONTEXT で停止。

## carry Minor(S1 whole-branch review で triage)

- S1-1: report RED narration nit / cursor-pointer が th padding 全域(spec-mandated)/ 初期矢印 ▲→⇅(sorting=[] 由来)
- S1-2: 固定バー streak 表示 stale(S1-5 で対象削除=自動解消)/ 「フィルタを解除」の「を」正規化(S1-5 で唯一化=解消)/ justify-between 3→2 児(S1-5 で解消)
- S1-3: tag-toggle ロジック 3 copy(filter-bar 削除で 2 = rule-of-three 未満)/ condition-bar import grouping / tags chip × 冗長 stopPropagation
- S1-4: なし(stale comment は修正済)

## ⚠ tool-call テキスト漏れバグ(前セッションで多発)

- 症状/原因/復旧: `docs/superpowers/lessons/2026-07-03-malformed-toolcall-leak-investigation.md`。既知 harness バグ・副作用ゼロ。
- 対策 Stop hook 導入済: `.claude/hooks/detect-leaked-toolcall.sh`(登録=`.claude/settings.local.json`・gitignore 済)。新セッションで hook 反映確認(必要なら /hooks 開くか restart)。
- 運用: 漏れたら prose なしでツール呼び出し 1 件を先頭再発行。同一セッション 2 回以上再発は停止して新セッション(=本 doc を作った理由)。
