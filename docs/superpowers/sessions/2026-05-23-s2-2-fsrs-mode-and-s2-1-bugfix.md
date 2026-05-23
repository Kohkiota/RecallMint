# S2.2 FSRS モード + S2.1 bug fix sprint 完了

- 日付: 2026-05-23
- branch: `develop` (commit のみ、 push は OT 判断)
- plan: `docs/plans/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md`

## 結論

S2.2 (FSRS モード追加 + S2.1 残存 bug 3 件 fix + 回答フロー再設計) 全 5 task 完了。
schema 変更 1 点 (user_settings.fsrs_mode) + saveFsrsMode action + B1 input ゼロ strip +
入口画面 server 化 + session 画面全書換 (phase machine 再設計 / B2/B3 fix / mode 分岐)
+ tech-spec / session log closure。 全 567/567 test pass / pnpm build / tsc clean。
develop branch、 staging 投入は OT 判断。

## Sprint 達成事項

- T1 `dc23556`: `user_settings.fsrs_mode boolean not null default false` 追加 + migration 0010 (no-review)
- T2 `a3ddb04`: B1 fix (session-limit input 先頭ゼロ strip) + FSRSモード toggle + `saveFsrsMode` action + `fsrs-mode-form` (optimistic update + rollback)
- T3 `c20f0a5`: `/app/study/smart` を server component 化 + 現在 session_limit 表示 + `StartButton` を client 子 component に分離 (S2.1 T6 I-2 fix 維持)
- T4 `e3b7e19`: SessionRunner 全書換 (`selecting → judged → finished`)、 `equalSet` helper、 B3 click 選択、 B2 `stripPrefix(text, optId)` (A 案)、 mode 別 submit タイミング、 session/page.tsx で fsrsMode 取得 + props 渡し
- T5 (本 commit): tech-spec §2.2 / §2.5.5 / §3 routes / §3 actions / §Logic 3 を実装合わせに更新 + session log

## review 結果集計

| Task | Critical | Important (fix 済) | Minor (記録のみ) |
|---|---|---|---|
| T1 | (no-review) | - | - |
| T2 | 0 | 0 (元 C-1 UPSERT updatedAt 欠落 / I-1 React 19 flake / I-2 test title / I-3 test pin in は fix 済) | 4 |
| T3 | 0 | 0 | 3 |
| T4 | 0 | 0 (元 I-1 PREFIX_RE 副作用 / I-2 コメント矛盾 / I-3 retry button 未実装 は fix or plan 緩和済) | 5 |
| T5 | (no-review) | - | - |

- review は全 feat task で `superpowers:requesting-code-review` skill canonical 経路
  (general-purpose subagent / template 改変なし)。
- **Critical は全 task 0 件**。 Important は各 task で fix 済 or OT 承認握り潰し (T4 I-3 のみ plan 緩和)。

## 確定した設計判断 (S2.2)

- **正解判定 = client 集合一致**: `equalSet(selectedIds, correctIds)` の順序非依存完全一致。
  partial / 余剰 / 不足 は全て incorrect。 単一/複数選択 flag は schema に無いため常時複数選択可能 UI。
- **submitReview signature 不変**: `(cardId, rating)`。 通常モードは client が
  `correct ? 3 : 1` で auto-map、 FSRS モードは user 選択 rating そのまま。
- **client 判定値が真実 source**: `currentCorrect` を tally と UI に使用、 server 戻り値
  `data.correct` は参照しない (FSRS モードで user rating と判定値が乖離するため)。
- **submit タイミング mode 別**:
  - 通常モード: 「回答する」押下時に判定 + 即 submit + judged 遷移。 「次へ」は純遷移
    (user が解説を読む間に server 書込完了、 「次へ」 tap で待機ゼロ)。
  - FSRS モード: 「回答する」押下で判定 + 解説表示 (未 submit)、 rate ボタン押下で
    submit + 自動次へ (rate 選択を待ってから 1 度だけ submit)。
- **B2 fix = A 案 (T4 review I-1 OT 承認)**: `stripPrefix(text, optId)` で
  `startsWith(optId)` + ID 直後文字種判定 (数字なら strip しない)。 `"1誤正正誤"` → `"誤正正誤"` ✅、
  `"1990s"` 保全 ✅、 `"1.5g"` → `"5g"` は犠牲ケース (単位系小数頻度低、 OT 承認 trade-off)。
- **error UI = 素出し (T4 review I-3 OT 承認 plan 緩和)**: 通常モードは selecting 維持で
  「回答する」 再押下、 FSRS モードは judged 維持で rate ボタン再押下が retry。
  専用 retry button や案内文は **不要**。
- **drizzle `$onUpdate` × `onConflictDoUpdate` (T2 review C-1 で再確認)**: `$onUpdate` は
  UPSERT の conflict 分岐で発火しないため、 `saveSessionLimit` / `saveFsrsMode` は
  conflict set に `updatedAt: new Date()` を明示追加。 plan §T2 文言が S2.1 T5 review I-1 と
  逆の指示になっていたため controller が plan 修正 (commit `fbe9374`)。
- **/app/study/smart の server 化**: 既存 client onClick (revalidateAppPath) は
  `_components/start-button.tsx` に分離して維持 (S2.1 T6 I-2 fix の Router Cache 破棄を継続)。

## 既知の Minor (将来 work)

- (T4) opt explanation を disabled `<button>` の子要素として描画 (a11y 軽微、 button accessible name に解説が混入)
- (T4) opt button の tap target が `p-3` のみで 44px に届かない可能性 (rate button は `h-14` で明示確保済)
- (T4) test 内 regex `/^正解/` (banner "不正解" を除外する意図) のコメントなし
- (T4) SessionRunner 冒頭 docstring が 19 行 (CLAUDE.md §コーディング規約「1 行コメント」 推奨を超過)
- (T2) test mock chain の WHERE 引数を assert していない (multi-tenant 担保が test では見えない、 plan 範囲外)
- (T2) `<Switch>` primitive を新設せず native `<input type="checkbox">` + sr-only + 装飾で代替
  (将来複数の toggle が出てくる場合は shadcn `Switch` 等の primitive 化検討余地)

## scope 外 (本 sprint 不実施)

- カスタム演習 `/app/study/custom` (S2.3 想定)
- FSRS desiredRetention / per-user 最適化
- tag / exam 絞り込み filter
- 完了画面 UI 改変 / streak / study_days 列構造変更

## 判断必要: no

sprint 完了報告のみ。 OT が next sprint kickoff (S2.0b tag schema 移行 / S2.3 カスタム演習 / 他) を判断。

## 詳細 file path

- Plan: `docs/plans/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md`
- 各 task commit:
  - T1=`dc23556`
  - T2=`a3ddb04` + plan 修正 `fbe9374`
  - T3=`c20f0a5`
  - T4=`e3b7e19` + plan 修正 `6a772fc`
  - T5=(本 commit)
- tech-spec: `docs/02-tech-spec.md` (§2.2 / §2.5.5 / §3 routes / §3 actions / §Logic 3)
