# S2.2 FSRS モード + S2.1 bug fix 実装 plan

- 日付: 2026-05-23
- branch: `develop` (commit のみ、 push は OT 判断 — 既定方針)
- 前提: S2.1 sprint 完了済 (commit `1e33fa4` 時点)
- spec source: 本 sprint kickoff prompt (本 file §kickoff 抜粋に同等内容を集約)

## Goal

S2.1 で残存した bug 3 件 (B1 入力欄ゼロ残り / B2 選択肢 ID 重複表示 /
B3 選択肢クリック選択不可) を修正し、 同時に回答フローを「選択 → 回答 →
判定 → 解説 → 次へ」型に再設計する。 加えて user_settings に `fsrs_mode`
を追加し、 オフ時は FSRS rating を自動マッピング、 オン時は user が
Again/Hard/Good/Easy を直接押す上級モードを提供する。

## Architecture / 設計判断 (sprint 全体共通)

- **schema**: `user_settings.fsrs_mode boolean not null default false` を追加。
  migration 0010。 既存行は default で fsrs_mode=false 扱い。
- **正解判定の source of truth は client**: 「ユーザーが選んだ選択肢集合」と
  「`opt.is_correct === true` な opt の集合」の **完全一致** を correct とする。
  partial match は incorrect。 単一/複数選択フラグは card schema に無いため、
  常に複数選択可能 UI で集合一致判定する。
- **submitReview signature は不変** (`cardId, rating`)。 通常モードでは client が
  correct→rating=3 / incorrect→rating=1 を渡し、 FSRS モードでは user 選択
  rating を渡す。 server 側 `correct = rating >= 2` (study_days / cards 列更新用)
  は維持、 戻り値 `data.correct` は client tally で参照しない (client 判定値を使う)。
- **submit タイミング (両モード共通方針)**: 解説表示前に submitReview を呼び、
  pending を解説表示中に隠す。 通常モードは「回答ボタン押下 → 判定 + 即 submit
  (rating=3 or 1) → 解説表示」、 「次へ」は純遷移のみで submit を含まない。
  FSRS モードは「回答ボタン押下 → 判定 + 解説表示 (未 submit)」、 「Again/Hard
  /Good/Easy 押下 → 即 submit + 成功後自動で次 card へ」。 これにより通常モード
  では user が解説を読む間に server 書き込みが完了し、 「次へ」 tap での待機を
  ゼロにする。 FSRS モードは rate 選択を待ってから 1 度だけ submit する。
- **B2 fix 方針**: `opt.text` 先頭に ID prefix (`"1"`, `"1. "`, `"1) "` 等) が
  混入している既存 data に対し、 表示時に `text` 先頭の `^\d+\s*[\.\)）]?\s*` を
  strip。 DB 側 data は触らない (data migration なし)。 ID 自体は先頭に太字 1 回のみ表示。
- **scope 外** (kickoff 明示): 完了画面 UI / streak / study_days 列構造の変更なし。
  FSRS 数値計算 (rate / FSRS card update) は S2.1 のまま。 desiredRetention 設定不追加。

## 全体ルール (各 task 共通、 再掲しない)

- TDD: 失敗 test → 最小実装 → green → commit
- 各 feat task で `superpowers:requesting-code-review` skill canonical 経路
  (general-purpose subagent、 template 改変なし) を通す
- 完了条件 (各 task 共通):
  - 関係 test green、 `pnpm test` 全 pass、 `pnpm build` pass、 `pnpm tsc --noEmit` clean
  - review Critical 0、 Important は fix or OT 承認握り潰し
  - commit message 末尾に `[reviewed]` tag
- `lib/clerk.ts` / `lib/stripe.ts` / `lib/auth/ensure-user.ts` の auth/tenant
  分離は変更しない。 全 DB query は `WHERE user_id = ?` で絞る前提。
- 環境変数追加なし (本 sprint で `.env.example` 更新は発生しない)

## File Structure (touch 予定)

- Modify: `lib/db/schema.ts` — `userSettings.fsrsMode` 列追加 (T1)
- Create: `drizzle/migrations/0010_*.sql` — `ALTER TABLE user_settings ADD COLUMN fsrs_mode` (T1)
- Modify: `app/(app)/app/settings/_actions/save-session-limit.ts` —
  fsrs_mode UPSERT 用 sibling action 追加 or 同 action 拡張 (T2)
- Create: `app/(app)/app/settings/_actions/save-fsrs-mode.ts` (+ test) (T2)
- Modify: `app/(app)/app/settings/_components/session-limit-form.tsx` —
  number input の先頭ゼロ除去 (B1) (T2)
- Create: `app/(app)/app/settings/_components/fsrs-mode-form.tsx` (+ test) (T2)
- Modify: `app/(app)/app/settings/page.tsx` — toggle 配置 (session_limit の下) (T2)
- Modify: `app/(app)/app/study/smart/page.tsx` — 「現在の設定: XX 枚」表示 (T3)
- Modify: `app/(app)/app/study/smart/page.test.tsx` (T3)
- Modify: `app/(app)/app/study/smart/session/page.tsx` — fsrs_mode を server で取得し
  `SessionRunner` に prop で渡す (T4)
- Modify: `app/(app)/app/study/smart/session/_components/session-runner.tsx` —
  選択 state / 回答ボタン / 集合一致判定 / mode 分岐 / B2 prefix strip (T4)
- Modify: `app/(app)/app/study/smart/session/_components/session-runner.test.tsx` (T4)
- Update: `docs/02-tech-spec.md` (T5 closure)
- Create: `docs/superpowers/sessions/2026-05-23-s2-2-fsrs-mode-and-s2-1-bugfix.md` (T5)

---

## Tasks

### T1: schema migration — user_settings.fsrs_mode 追加

- **目的**: user 単位で FSRS rating 直接入力モードの ON/OFF を保持する列を追加。
- **制約**: `boolean not null default false`、 既存行は default で false。
  drizzle-kit `pnpm db:generate` で migration 0010 生成、 ファイル名は generator 任せ。
  既存 `userSettings` type export は再生成不要 (`$inferSelect` で自動追従)。
- **完了条件**: `pnpm db:migrate` がローカル DB で適用成功、 既存 test 全 green、
  `pnpm tsc --noEmit` clean。 commit `chore(db): T1 user_settings.fsrs_mode 列追加`。
  schema-only / 実装ロジック変更なしのため CLAUDE.md §Review 例外条項により review skip 可
  (commit に `[no-review]` tag)。

### T2: 設定画面 — B1 fix + FSRS toggle + saveFsrsMode action

- **目的**: B1 (session_limit 自由入力欄の先頭ゼロ残り) を fix し、 同 page に
  FSRS モード toggle を追加する。
- **制約**:
  - B1: input `onChange` で `value.replace(/^0+(?=\d)/, '')` 適用。
    空文字 / "0" は保つ。 既存 saveSessionLimit action 側のバリデーション (1-200) は変更しない。
  - toggle: `<input type="checkbox">` ベース (`<Switch>` 既存 component あれば再利用)。
    label「FSRSモード (上級)」、 デフォルト OFF、 session_limit form の下に配置。
  - `saveFsrsMode(boolean)`: server action。 `user_settings` を UPSERT で更新、
    既存 saveSessionLimit と同じ lazy init pattern (行不在時は INSERT)。
    **重要**: drizzle の `$onUpdate(() => new Date())` は `onConflictDoUpdate`
    では発火しない (S2.1 T5 review I-1 で発覚)。 conflict branch の `set` に
    `updatedAt: new Date()` を **明示的に含める** こと。 既存 `saveSessionLimit`
    が `set: { sessionLimit: value, updatedAt: new Date() }` としているのと同様、
    `set: { fsrsMode: value, updatedAt: new Date() }` とする。 test 側も
    `expect(conflictSet.updatedAt).toBeInstanceOf(Date)` で assert。
  - UI は server component (`page.tsx`) で現在値を取得、 form は client component。
- **完了条件**: 新規 test (saveFsrsMode true/false UPSERT / session-limit input ゼロ
  ストリップ / fsrs-mode-form 初期値反映 + toggle 操作) green、 既存 test 全 pass、
  `pnpm build` pass。 review Critical 0 → `[reviewed]` 付与で commit
  `feat(settings): T2 FSRS モード toggle + session_limit 入力先頭ゼロ fix (S2.2)`。

### T3: 入口画面 — 現在の設定値表示

- **目的**: `/app/study/smart` に「現在の設定: XX 枚」を Button の上に表示する。
- **制約**:
  - server component で `user_settings.sessionLimit` を取得 (行不在は default 20)。
  - 現状の entry page は client component のため、 表示部分のみ server に切り出すか
    page 全体を server 化して既存 `revalidateAppPath` onClick の wrapper を別 client
    component に逃がす (どちらでも可、 review 観点で過剰分割しない)。
  - fsrs_mode 値の表示は本 task では行わない (T4 で session 内挙動に効くのみ)。
- **完了条件**: `page.test.tsx` に「session_limit=20 で 20 枚と表示」「session_limit=50
  で 50 枚と表示」を追加 green。 `pnpm build` pass。 review Critical 0 →
  `[reviewed]` 付与で commit `feat(study): T3 スマート復習入口に現在の session_limit
  表示 (S2.2)`。

### T4: セッション画面 — B2/B3 fix + 回答フロー再設計 + mode 分岐

- **目的**: 選択肢クリック選択 → 回答ボタンで判定 → 解説表示 → rate (mode 分岐) →
  次へ、 のフローに再設計し、 同時に B2 (ID 重複表示) を fix する。
- **制約 (UI / phase machine)**:
  - SessionRunner の phase を `selecting → judged → finished` に変更。
    判定後の解説表示 / rate 待ち / 次へ待ちは全て `judged` phase 内に内包
    (mode で UI 分岐)。
  - state 追加: `selectedIds: string[]` (現在 card の選択 opt id 配列)、
    `currentCorrect: boolean | null` (判定結果 cache)。
  - card 切替時に `selectedIds` / `currentCorrect` を reset。
  - props 追加: `fsrsMode: boolean` (server から渡す)。
- **制約 (選択 UI)**:
  - 各 opt は button 風 li で click 可能、 `selectedIds` に含まれていれば
    border-emerald + bg-emerald-50 のハイライト、 `judged` phase 以降は click 無効。
  - 複数選択可能 (toggle on/off)。
- **制約 (判定)**:
  - correct = `equalSet(selectedIds, options.filter(o => o.is_correct).map(o => o.id))`。
    順序非依存の集合一致。 client 側 helper 関数として記述、 単体 test を T4 内で書く。
  - judged 後: `○ 正解` / `× 不正解` 表示 + 既存の正答 emerald ハイライト + 解説。
- **制約 (mode 分岐 / submit タイミング)**:
  - 通常 (`fsrsMode=false`): selecting で「回答する」押下 → 集合一致判定 →
    その場で `submitReview(card.id, currentCorrect ? 3 : 1)` を呼び、 成功で
    judged phase 遷移。 judged phase は「正解/不正解 + 解説」 + 「次へ」 1 個。
    「次へ」は **submit を含まない純遷移** (次 idx に進めるか finished へ)。
    submit pending 中は「回答する」を disabled。
  - FSRS (`fsrsMode=true`): selecting で「回答する」押下 → 集合一致判定 →
    judged phase 遷移 (この時点では submit しない)。 judged phase は「正解/不正解
    + 解説 + Again/Hard/Good/Easy 4 ボタン」。 ボタン押下で
    `submitReview(card.id, rating)` を呼び、 成功後に自動で次 card へ
    (次へ button 不要)。 mobile では 2x2 grid。 submit pending 中は 4 ボタン disabled。
  - tally の `correct` インクリメントは client 判定値 (`currentCorrect`) を使用。
    server 戻り値 `data.correct` は参照しない (rating mapping 不一致を避けるため、
    本 sprint 設計判断の §Architecture 参照)。
  - エラー時の挙動: submit 失敗で判定結果と解説の表示は維持し、 error UI を出す。
    通常モードは「再試行」button、 FSRS モードは「もう一度 rate を押す」を案内。
- **制約 (B2 fix)**:
  - opt 描画前に `opt.text.replace(/^\d+\s*[\.\)）]?\s*/, '')` で先頭の数値 prefix を strip。
  - ID は selecting phase / judged phase 共に `<span class="font-medium mr-2">{opt.id}</span>`
    で先頭に 1 回だけ太字表示。 既存の `○/×` mark は ID の前に出す。
- **制約 (test)**:
  - 集合一致 helper: 空一致 / 1 要素一致 / 順序逆 / 部分一致 不正解 / 余剰一致 不正解 / 完全不一致。
  - SessionRunner: opt click で selectedIds 更新 / 「回答する」 disabled (selecting で 0 件選択時) /
    通常モードで「回答する」押下時点 で submitReview(rating=3) 呼出 (correct ケース) /
    通常モードで「回答する」押下時点 で submitReview(rating=1) 呼出 (incorrect ケース) /
    通常モードで「次へ」押下は submit を呼ばず idx を進めるのみ /
    FSRS モードで「回答する」押下時点では submitReview 未呼出、 4 rate button 表示 /
    FSRS モードで Hard 押下時点で submitReview(rating=2) + 自動次へ /
    B2 prefix 入りの text を表示時に strip / 3 枚連続終了で完了画面遷移 / error 時 UI 表示。
- **完了条件**: 上記 test 群 green、 既存 SessionRunner test (S2.1 由来) は仕様変更で
  書き換えるが「ある場合は green / 無くなる場合は削除」のいずれか明示。
  `pnpm test` 全 pass、 `pnpm build` pass、 Chrome DevTools モバイルビューで崩れない。
  review Critical 0 → `[reviewed]` 付与で commit
  `feat(study): T4 セッション回答フロー再設計 + B2/B3 fix + FSRS モード分岐 (S2.2)`。

### T5: tech-spec 更新 + session log (closure)

- **目的**: schema (fsrs_mode) と回答フロー (mode 分岐) を tech-spec に反映、
  session log で sprint 完了を残す。
- **制約**:
  - `docs/02-tech-spec.md` の §2 schema (user_settings) / §3 routes (settings / smart) /
    §8 Logic (FSRS rating mapping) / §2.10 ER を実装に合わせて更新。
  - session log は既存 S2.1 closure log と同 format (結論 / 達成事項 / review 集計 /
    確定設計判断 / 既知 Minor / scope 外 / 判断必要 / 詳細 path)。
  - sprint 達成 task 一覧と各 commit hash を session log に記載。
- **完了条件**: `pnpm build` pass。 docs 専用 commit (CLAUDE.md §Review 例外条項により
  review skip 可)。 commit `chore(docs): T5 S2.2 closure — tech-spec 更新 + session log`
  に `[no-review]` tag。

---

## Spec coverage self-review

| Spec 項目 (kickoff) | 対応 task |
|---|---|
| B1 自由入力欄ゼロ残り | T2 (input 先頭ゼロ strip) |
| B2 選択肢 ID 重複表示 | T4 (opt.text prefix strip + ID 単一描画) |
| B3 選択肢クリック選択不可 | T4 (selectedIds state + click handler) |
| user_settings.fsrs_mode 列追加 + migration | T1 |
| 設定画面 FSRS toggle (label / 配置 / default) | T2 |
| 入口画面に現在の session_limit 表示 | T3 |
| 通常モード回答フロー (選択→回答→判定→解説→自動 Good/Again→次へ) | T4 |
| FSRS モード回答フロー (選択→4 rate→判定→解説→次) | T4 |
| 実装順序 migration → 設定 → 入口 → セッション | T1→T2→T3→T4 順 |
| scope 外: 完了画面 / streak / study_days | 各 task の制約節で明示的に「変更しない」 |

## scope 外 (本 sprint 不実施、 改めて記載)

- 完了画面 UI 改変 / streak 表示 / study_days 列構造変更
- FSRS desiredRetention や per-user パラメータ最適化
- tag / exam による card 絞り込み
- カスタム演習 `/app/study/custom` (S2.3 想定)

## 想定 plan 行数

本 file 最終: 約 175 行 / 上限 250 (CLAUDE.md §plan 規律)。
