# S2.2.2 回答フロー 2-step 再設計 sprint 完了

- 日付: 2026-05-23 (S2.2.1 closure 同日 follow-up)
- branch: `develop` (commit のみ、 push は OT 判断)
- 前提: S2.2.1 sprint 完了済 (commit `c2d200d`)
- plan: なし (follow-up bug fix 規模、 OT kickoff prompt + subagent prompt で仕様確定)

## 結論

S2.2.1 完了直後に OT が回答フローを再変更 kickoff。 S2.2.1 で実装した 1-step
(selecting で 4 rate ボタン回答兼用 / 通常モード「回答する」 即 submit / 純遷移「次へ」)
を破棄し、 両モード共通 selecting 「回答する」 + judged で mode 別 footer (2-step) に
再設計。 全 2 task 完了。 569/569 test pass / tsc clean / build pass。

## Sprint 達成事項

- T1 `fba425a`: SessionRunner 2-step 再設計
  - selecting footer: 両モード共通「回答する」 1 個 (空選択 disabled、 押下時判定 + judged のみ submit なし)
  - 通常モード judged: 「次へ」 1 個 (押下で `currentCorrect ? 3 : 1` auto submit + 成功で自動次へ、 純遷移廃止)
  - FSRS モード judged: Again/Hard/Good/Easy 4 ボタン (押下で user 選択 rating submit + 自動次へ)
  - `handleAnswer` (両モード判定のみ) / `handleNextNormal` (通常 submit 兼遷移) /
    `handleRateFsrs` (FSRS submit 兼遷移) / `runSubmitAndGoNext` (共通 submit + tally + goNext)
- T2 (本 commit): tech-spec §3 routes 再々更新 (両モード footer 仕様 + S2.2 → S2.2.1 → S2.2.2 履歴) + session log

## review 結果集計

| Task | Critical | Important (fix 済) | Minor (記録のみ) |
|---|---|---|---|
| T1 | 0 | 0 | 4 |
| T2 | (no-review) | - | - |

- review は `superpowers:requesting-code-review` skill canonical 経路 (general-purpose
  subagent / template 改変なし)。
- **Critical / Important 0 件**。 Minor は記録のみ、 握り潰しなし。

## 確定した設計判断 (S2.2.2)

- **selecting footer = 両モード共通**: 「回答する」 1 個、 空選択 disabled。 footer 描画
  `!isJudged && (...)` で fsrsMode 分岐なし。
- **「回答する」 押下時に submit は呼ばれない (両モード)**: 判定 + `setCurrentCorrect` +
  `setPhase('judged')` のみの同期処理、 transition 不要。 spec 中核要件、 test で明示確認。
- **judged footer = mode 別**:
  - 通常: 「次へ」 = submit 兼遷移 (auto-rating `currentCorrect ? 3 : 1`)
  - FSRS: 4 rate ボタン = submit 兼遷移 (user 選択 rating)
- **純遷移「次へ」 は廃止**: 両モードとも submit 成功時のみ次 card に遷移。 submit 失敗時は
  judged 維持 + error + 「次へ」 / 4 ボタン再 enable で retry。
- **`currentCorrect` snapshot**: `runSubmitAndGoNext` 内で `goNext()` の reset 前に
  ローカル変数に capture して tally 計算に使用 (closure race 回避)。
- **UX trade-off**: S2.2 T4 では通常モードで「回答する」 即 submit により解説を読む間に
  裏書込が完了していたが、 S2.2.2 では submit が「次へ」 押下後にずれるため、 「次へ」 tap
  直後の待機が増える可能性。 一方 FSRS モードと挙動が対称化、 UI 共通化の理解しやすさを優先。
  OT 承認の意図的 trade-off。
- **履歴上の経緯** (回答フローの変遷): S2.2 T4 = 1-step 通常 + 2-step FSRS / S2.2.1 T1 =
  両モード 1-step / S2.2.2 T1 = 両モード 2-step (selecting 共通 / judged で mode 別)。
  short-period での 3 度の仕様変更だが、 都度の OT 承認で確定、 retro 候補。

## 既知の Minor (記録のみ、 将来 work)

- (T1) `runSubmitAndGoNext` 冒頭で `setError(null)` を呼んでいない (retry 時の旧 error が
  pending 中まで残る、 UX 微改善余地)
- (T1) `handleNextNormal` の `currentCorrect === null` ガードが `runSubmitAndGoNext` 内部と
  二重 (防御的、 害なし)
- (T1) FSRS rate 3 ケース test ブロックで `mockSubmitReview.mockClear()` 個別 reset 省略、
  `toHaveBeenLastCalledWith` で回避中 (独立性は OK だが明示性低)
- (T1) FSRS rate ボタン Hard/Again の variant 色付け検討余地 (Good のみ filled、 spec 明示なし)

## scope 外 (本 sprint 不実施)

- M1 (`setError(null)` retry 先行 reset) の同 commit 取り込み (次 follow-up 候補)
- 解説を読む間の裏 submit パターン復活 (S2.2 T4 design への部分回帰、 OT 不採用)
- 完了画面 UI 改変 / streak / study_days 列構造変更

## 判断必要: no

sprint 完了報告のみ。 OT が next sprint kickoff および push / staging deploy のタイミングを判断。
回答フローの短期間 3 度変更は retro で振り返り対象。

## 詳細 file path

- 関連 sprint:
  - S2.2 plan: `docs/plans/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md`
  - S2.2 session log: `docs/superpowers/sessions/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md`
  - S2.2.1 session log: `docs/superpowers/sessions/2026-05-23-s2-2-1-fsrs-flow-and-url-restructure.md`
- 本 sprint commit:
  - T1=`fba425a`
  - T2=(本 commit)
- tech-spec: `docs/02-tech-spec.md` (§3 routes /study/smart 挙動 再々更新)
