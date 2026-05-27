# cache-fix Step 3b: rate-then-confirm fix — session log

- **日時**: 2026-05-27
- **対象 sprint**: cache-fix Step 3b (FSRS rate 確定タイミング修正、 致命バグ)
- **branch**: `develop`
- **状態**: 実装完了 / commit 済 / **push 待機中** (OT 指示まで pause)

---

## 1. 目的

FSRS モード rate click 毎に Dexie write を発火する致命バグの修正。 連打 / 変更で
events が累積し、 server reviews / study_days / cards.current_streak に連打回数分
の不正累積が発生する問題を「1 card = 1 操作」 UX に戻す。 cache-fix Step 3a の
TTFB 10.7s 計測ノイズも、 bulk POST 内容を正常 size に戻すことで軽減。

---

## 2. 経緯 (skill workflow)

### 2.1 brainstorming (clarify skip → design 提示 → spec doc commit → user gate)

- kickoff prompt 受領 (確定仕様 + 確定設計 + scope In/Out 明示済) → clarifying
  questions step skip、 design step から start
- A 案 (handleRateFsrs inline state-only / runSubmit 本体不変) vs B 案
  (markRated helper extract) を提示、 OT が A 案承認
- 残論点 3 件 (refactor 粒度 / 「前へ」 分岐条件 / test 反転範囲) OT 一括承認
- spec doc `docs/superpowers/specs/2026-05-27-rate-then-confirm-design.md`
  起草 (295 行) + commit `3e0013e` [no-review]
- user review gate で approve

### 2.2 writing-plans

- 7 task 構成、 218 行 (CLAUDE.md 上限 250 内) で plan
  `docs/superpowers/plans/2026-05-27-rate-then-confirm.md` 起草 + commit
  `2ab6d2c` [no-review]
- 初稿 305 行で CLAUDE.md 上限 250 超過、 self-review で「全体ルール」 + 各 task
  制約節 + Self-Review 章を簡潔化して 218 行に縮約
- execution mode = subagent-driven-development (A 案、 OT 選択)

### 2.3 subagent-driven execution (Task 1-7)

| task | 内容 | review |
|------|------|--------|
| 1 | session-runner.test.tsx の既存 FSRS test 15 件を新仕様に反転 (TDD 赤確立) | spec ✅ / code quality ✅ Approved (Minor 3 defer) |
| 2 | 新規 test 4 件追加 (連打 / 「前へ」 submit / 戻り再 rate / リトライ guard) | spec ✅ / code quality ✅ Approved (Minor 4 defer)。 plan §完了条件 Test 4 緑記述が誤記と判明 |
| 3 | handleRateFsrs inline state-only 化 (Dexie write 撤去) | spec ✅ / code quality ✅ Approved (Minor 1)。 **OT 進捗報告 → A 承認** |
| 4 | handleNextFsrsAfterRate に runSubmit 追加 (「次へ」 で 1 件 submit) | spec ✅ / code quality ✅ Approved (Minor 0) |
| 5 | handlePrev に FSRS judged + rated 分岐追加 (「前へ」 で 1 件 submit) | spec ✅ / code quality ✅ Approved (Minor 0)。 **OT 進捗報告 → A 承認** |
| 6 | full test suite + typecheck 総合確認 (controller 直接実行) | 822/822 pass / typecheck clean |
| 7 | canonical review (requesting-code-review skill) + 集約 `fix(study)` commit + [reviewed] tag | Critical 0 / Important 0 / Minor 5、 Minor 2 件は本 commit で fix、 残 3 件は defer / 別 follow-up |

### 2.4 user 指示による workflow 修正

途中、 user (OT) から指示:

> Task 3 / Task 5 の logic 変更後は念のため OT に進捗報告 してもらえると安心です
> (= 致命 bug 修正なので軌道修正の余地を残す)

これを受けて subagent-driven skill 既定の continuous execution を override、
Task 3 + Task 5 完了直後に OT 進捗報告 (= chk point) を挟む運用に変更。 同方針を
memory `critical-bug-fix-progress-reports.md` に保存。

---

## 3. 確定仕様 (再掲)

### 通常モード (handleNextNormal 経路、 fsrsMode=false)

現状維持。 回答ボタン押下 → judged → 「次へ」 で `runSubmit` 発火 = 即 Dexie write。

### FSRS モード (fsrsMode=true)

| step | 操作 | 挙動 |
|------|------|------|
| 1 | 回答ボタン押下 | phase='judged' へ遷移、 選択肢確定、 rate button 有効化 |
| 2 | rate button click | React state 更新のみ (lastRating / tally / submittedCardIds)、 Dexie write しない |
| 3 | rate 連打 / 変更 | setLastRating の state 上書きのみ、 Dexie write しない |
| 4 | 「次へ」 押下 (lastRating !== null) | runSubmit(lastRating, goNext) で Dexie write 1 件 + 次 card 遷移 |
| 5 | 「前へ」 押下 (lastRating !== null, judged) | runSubmit(lastRating, goPrev) で Dexie write 1 件 + 前 card 遷移 |
| 6 | 「リトライ」 押下 | resetCardState のみ (現状維持) |
| 7 | 「前へ」 戻り後再回答 → 「次へ」 / 「前へ」 | **追加 1 件 Dexie write** (上書きせず、 server submit-review-tx で順次 apply = 案 B) |

server / schema / migration:
- event_id は `newId()` で UUID 新規 (deterministic 化しない)
- server ON CONFLICT (event_id) DO NOTHING 維持
- reviews / cards / study_days schema 無変更
- migration 不要 (既存累積データは silent drop で OK、 OT 承認済)

---

## 4. 累積 commit

| SHA | type | 内容 | 行数 |
|-----|------|------|------|
| `3e0013e` | docs(spec) | rate-then-confirm fix design [no-review] | +295 |
| `2ab6d2c` | docs(plan) | rate-then-confirm fix plan (7 task) [no-review] | +218 |
| `9b2f1e2` | **fix(study) [reviewed]** | FSRS rate state-only + 次へ/前へ で 1 件 submit | +399 / -124 |

`9b2f1e2` の構成: source `session-runner.tsx` の 3 handler + 上部コメント、
test `session-runner.test.tsx` の既存反転 15 件 + 新規 4 件。 通常モード /
S-cache-3.1 race gate / runSubmit 本体 / lib/sync / server route は一切 touch なし。

---

## 5. 動作確認結果

- **vitest 全 suite**: 79 test files / **822 tests / all passed** (full regression なし)
- **typecheck**: `pnpm tsc --noEmit` clean (exit 0、 no output)
- **scope discipline**: `git diff --stat` で session-runner.{tsx,test.tsx} 2 ファイルのみ

---

## 6. review record

### canonical review (Task 7、 superpowers:requesting-code-review skill)

- 経路: skill canonical / general-purpose subagent / template 改変なし
- 結果: Critical 0 / Important 0 / **Minor 5**
- Minor 1 (L147 stale comment) → 本 commit で fix
- Minor 2 (L360 task number reference) → 本 commit で fix
- Minor 3 (Test 3 累積 4 件拡張) → retain (reviewer 推奨、 ordering invariant guard 価値あり)
- Minor 4 (plan §完了条件 Test 4 緑誤記) → 別 follow-up commit (本 session log 直後に処理)
- Minor 5 (L232 idx===0 二重 guard intentional) → defer (既に L228-229 で rationale 説明済)

CLAUDE.md §「重要 Fix の裏取り」 対象外 (決済 / 認証 / 削除 / 外部副作用に非該当) →
review pass で即 [reviewed] tag 付与。

### per-task review (subagent-driven-development skill)

Task 1-5 で spec compliance + code quality を二段 review、 全 ✅ Approved。
Critical / Important なし、 Minor は各 task で defer or 後続 task で吸収。

---

## 7. follow-up

| # | 項目 | 担当 | 状態 |
|---|------|------|------|
| 1 | session log (本 doc) | Claude Code | 完了 (本 commit) |
| 2 | plan doc §完了条件 Test 4 誤記 fix | Claude Code | 次 commit で実施 |
| 3 | stg smoke 「FSRS rate 連打 → 次へ 1 回 → POST 1 件」 実機確認 | OT / claude.ai | 未着手 |
| 4 | origin/develop への push | OT 指示待ち | **pause 中** |
| 5 | cache-fix Step 3a (bulk endpoint TTFB 計測再開) | OT / Claude Code | Step 3b 完了で正常 size payload 回復、 計測再開可能 |

memory 保存:
- `critical-bug-fix-progress-reports.md` (致命 bug 修正の OT 進捗報告 workflow)

---

## 8. 学び / observation

- **plan 起草時の前提見落とし**: Task 2 §完了条件で「Test 4 緑」 と書いたが、
  現 source の `handleRateFsrs` が rate click で Dexie write を発火する挙動を
  plan 起草者が見落とした結果の誤記。 implementer が spec §4.2 #4 文言 (「0 回」)
  優先で red を確立し、 plan の誤記が表面化した。
  → 教訓: plan 起草時は「現 source の関連 path を grep で軽く確認してから完了条件
  を書く」 ステップが有効。 verify-plan-assumptions-before-each-task memory と整合。
- **subagent-driven skill 既定の continuous execution は致命 bug 修正に不向き**:
  Task 3 / 5 で OT 進捗報告を挟む運用 override で「軌道修正余地」 を確保。
  critical-bug-fix-progress-reports memory に保存。
- **A 案 (inline) vs B 案 (helper extract) trade-off**: A 案で handleRateFsrs と
  runSubmit に同一加算式が 5 行重複したが、 通常モード path への blast radius を
  ゼロに抑える効果が大きく、 OT 判断で A 案採用。 結果として review でも duplication
  は acceptable trade-off と判定。
