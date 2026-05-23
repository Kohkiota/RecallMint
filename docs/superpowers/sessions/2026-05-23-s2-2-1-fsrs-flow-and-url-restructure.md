# S2.2.1 FSRS フロー修正 + URL 構造変更 sprint 完了

- 日付: 2026-05-23 (S2.2 closure 同日 follow-up)
- branch: `develop` (commit のみ、 push は OT 判断)
- 前提: S2.2 sprint 完了済 (commit `2497a69`)
- plan: なし (follow-up bug fix 規模、 OT kickoff prompt + 各 task subagent prompt で仕様確定)

## 結論

S2.2 完了直後に OT が 2 点の改修を kickoff:
1. FSRS モード回答フローを 1-step に簡素化 (「回答する」 button 廃止、 4 rate ボタンが回答兼用)
2. `/app/study/smart` URL 構造変更 (入口画面廃止、 直接セッション画面に統合)

全 3 task 完了。 568/568 test pass / tsc clean / build pass。 develop branch、
staging 投入は OT 判断。

## Sprint 達成事項

- T1 `e3e3fc5`: FSRS 2-step → 1-step 再設計 (`SessionRunner`)、 selecting で 4 rate ボタン
  (空選択 disabled、 押下時 submit + judged 遷移)、 「次へ」 純遷移 (通常モードと統一)。
  「回答する」 button は FSRS モード時 DOM 不在。 通常モード挙動は不変
- T2 `8179242`: `/app/study/smart/session` を `/app/study/smart` 直下に統合。
  git mv で 6 file 移動 (内部 import 同階層 relative で不変)、 旧 entry page 廃止
  (StartButton 削除)、 smart/page.tsx 全書換 (旧 session/page.tsx 相当)、 dashboard-actions /
  revalidate.ts / 各 test の references を `/app/study/smart` に統一
- T3 (本 commit): tech-spec §3 routes 再更新 (smart 単一 route、 session 廃止 + FSRS 1-step
  挙動明記) + S2.2.1 session log

## review 結果集計

| Task | Critical | Important (fix 済) | Minor (記録のみ) |
|---|---|---|---|
| T1 | 0 | 0 | 4 |
| T2 | 0 | 0 | 3 |
| T3 | (no-review) | - | - |

- review は全 feat task で `superpowers:requesting-code-review` skill canonical 経路
  (general-purpose subagent / template 改変なし)。
- **Critical / Important 全 task 0 件**。 Minor は記録のみで握り潰しなし。

## 確定した設計判断 (S2.2.1)

- **FSRS モード回答フロー**: 旧 S2.2 の 2-step (selecting で「回答する」 → judged →
  rate → 自動次へ) を廃止し、 1-step (selecting で 4 rate ボタン → submit + judged
  → 「次へ」純遷移) に統一。 通常モードと judged 以降の挙動が共通化され UI 一貫性が向上、
  click 数も「opt 選択 + rate 1 click」で通常モードと同等。
- **「回答する」 button = 通常モード専用**: FSRS モード時は 4 rate ボタンが回答兼用となるため
  「回答する」を DOM に出さない。 footer 描画分岐 `!isJudged && !fsrsMode` で構造的に隠す。
- **judged phase = 両モード共通「次へ」純遷移**: submit は selecting → judged 遷移時に
  完了しているため、 「次へ」 は idx を進めるだけ。 自動次へは廃止 (user が解説を読む
  時間を尊重)。
- **URL 構造 = 1 階層 flatten**: `/app/study/smart` をセッション画面そのものに統一。
  `/app/study/smart/session` を廃止し、 dashboard / nav リンクと revalidatePath type
  union を全て同期更新。 入口画面 (StartButton + 「現在の設定: XX 枚」) は廃止。
  「現在の設定」 表示も削除 (FSRS モード等は `/app/settings` で確認)。
- **file 配置**: 旧 `smart/session/_components/_actions/_lib/` 配下を 1 階上 `smart/`
  配下に move。 内部 import は同階層 relative path (`../_actions/...` 等) で不変、
  git は pure rename として検出 (履歴保持)。
- **`/app/study/custom/session`**: 存在せず skip (`find` で empty 確認済)。 custom 演習
  自体が未実装のため別 sprint で実装時に同 pattern (smart と同じく 1 階層) を適用予定。
- **旧 URL `/app/study/smart/session`**: Next.js が dir 削除で自動 404、 redirect /
  rewrite は OT 指示なしで scope 外。 user の bookmark への対応は将来 sprint で
  必要なら追加 (現状 user 数小規模で影響軽微)。

## 既知の Minor (記録のみ、 将来 work)

- (T1) `submitAndJudge` 内で `correct` を引数受領しているが、 `handleAnswer` /
  `handleRateFsrs` の両方が `correctIds` 計算を持つ (3 行 × 2 重複)。 過度な統合は
  「FSRS は user rating 信頼 / 通常モードは集合一致から rating 導出」 非対称が崩れる risk
- (T1) FSRS rate error path test で「retry 実行 → judged 遷移」 までは未検証 (4 ボタン
  enabled 復帰までは確認、 retro 候補)
- (T2) `smart/page.tsx:17-19` の auth-gate コメントが旧 session/page.tsx から 3 行で
  carry over (project 1 行コメント convention で軽微冗長)
- (T2) `smart/page.test.tsx` 0 件 path で heading "スマート復習" の assert 省略
  (nice-to-have coverage)
- (T2) `revalidate.ts` の history コメントが T6 (added) + S2.2.1 T2 (removed) で
  2 段、 consolidate 余地 (housekeeping)

## scope 外 (本 sprint 不実施)

- 旧 URL `/app/study/smart/session` → 新 URL の rewrite/redirect 設定
- カスタム演習 `/app/study/custom` 自体の実装 (S2.3 想定)
- 「現在の設定: XX 枚」表示の代替 (現状は `/app/settings` でのみ確認可)
- FSRS mode の onboarding tooltip / explainer (上級向け切替の認知導線)

## 判断必要: no

sprint 完了報告のみ。 OT が next sprint kickoff および push / staging deploy のタイミングを判断。

## 詳細 file path

- 前提 sprint plan: `docs/plans/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md` (S2.2)
- 各 task commit:
  - T1=`e3e3fc5`
  - T2=`8179242`
  - T3=(本 commit)
- tech-spec: `docs/02-tech-spec.md` (§3 routes: /study/smart の挙動更新)
- 関連 S2.2 session log: `docs/superpowers/sessions/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md`
