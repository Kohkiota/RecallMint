# ESLint 9 flat config + lefthook + CI gate (波2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** lint gate を 3 層 (eslint flat config + lefthook + CI workflow) で配備し、 Step 0.5 で実測した 57 件の違反を全件 error gate に通せる状態まで repo を整える。

**Architecture:** 3 commit に分割 (C1: hook fix 7 件 + 状態保存 pin test、 C2: 機械 fix 48 件、 C3: gate 設置)。 C3 まで `pnpm lint` を叩かない (C1 / C2 は手動 `tsc` + `test` のみ)、 C3 commit が gate 初活性。

**算数の閉じ** (Step 0.5 raw 集計 58 件、 内訳の振り分け):
- C1 fix 7 = set-state-in-effect 6 + refs simple 1 (inline-text-field:96)
- C2 fix 48 = err 1 (prefer-const) + warn 47 (unused-vars 43 + no-img-element 1 + unused-disable directive 3)
- rule off 1 = preserve-manual-memoization (Compiler OFF 制約と紐づく、 spec § 3)
- file override 1 = refs structural (inline-option-row:115、 Sync-fix-1 送り、 spec § 3)
- self-reference 1 = import/no-anonymous-default-export (Step 0.5 の暫定 config 自己言及、 本 plan の正式 config は named const → export default 形で再発しない、 spec § 3)

合計 = 7 + 48 + 1 + 1 + 1 = 58 ✓ (Step 0.5 raw と一致)。 self-reference 1 を除いた repo 内本物違反 = **57 = 7 + 48 + 1 + 1**。 Task 1 Step 1 で実走対照表を取って消し込み、 期待値と一致しなければ stop & 原因究明。

**Tech Stack:** ESLint 9.39.4 / eslint-config-next 16.2.4 (flat) / eslint-plugin-react-hooks ^7.1.1 / lefthook ^2.1.9 / GitHub Actions (Node 24 LTS、 pnpm@10.33.0 SSoT)。

**Source spec:** `docs/superpowers/specs/2026-06-10-eslint-ci-gate-design.md` (OT 承認済、 修正なし)。 各 file の中身詳細は spec § 3 / § 4 / § 5 / § 6 を参照 (本 plan では再貼付しない、 CLAUDE.md plan 規律)。

---

## 全体規律 (各 task 共通、 冒頭 1 度のみ)

- **pin test 規律**: Task 1 は **挙動保存 refactor** (prev-render pattern も refs 撤去も既存挙動を変えない)。 pin test は **fix 前後で両方 pass** = 挙動保存の証明。 **fix 前 fail = 既存バグ発見の可能性 = red flag、 即 stop & OT 相談** (歪めて pass させない)。 Task 2 / 3 は code-only。
- **review canonical 経路**: 各 task で `superpowers:requesting-code-review` skill + general-purpose subagent + template 改変なし、 Critical 0 / Important 0 まで詰める。
- **commit tag**: 全 commit に `[reviewed]` 付与 (重要 Fix 裏取り対象外 = review pass で即 [reviewed])。
- **task 間 stop checkpoint**: 各 task 完了で停止、 OT 判断待ち (CLAUDE.md sprint 境界規律)。
- **red flag 検出時即 stop**: spec § 9 の 4 件いずれか検出 → 即 stop & OT 相談。
- **C3 まで `pnpm lint` 禁止**: C1 / C2 commit 時は `next lint` が対話 stuck のため呼ばない。 手動 gate は `pnpm exec tsc --noEmit` + `pnpm test` のみ。
- **CC は commit のみ、 push は OT** (CLAUDE.md OT 規律)。
- **state guard**: 全 task で `git status` clean 状態から開始。 暫定 config 等は task 内で revert (commit に含めない)。

---

### Task 1: C1 commit — React 19 hook rule 違反 7 件解消 + 状態遷移 test

**目的**: spec § 7 C1 = set-state-in-effect 6 件 (prev-render pattern) + refs simple 1 件 (ref 撤去) を fix、 6 file の prop 遷移挙動を test で pin (b02c072 hook regression pin と同形)。

**Files (touch):**
- Modify: `app/(app)/app/tags/_components/category-row.tsx` (L48-72 周辺、 prev-render pattern、 Step 0.6 sample #1 と同形)
- Modify: `app/(app)/app/tags/_components/option-row.tsx` (L87 周辺、 同 pattern)
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx` (L74 周辺、 同 pattern)
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (L163 周辺、 同 pattern)
- Modify: `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` (L483 周辺の set-state-in-effect 1 件のみ。 L115 refs は触らない = Sync-fix-1 送り、 file override は C3 で配備)
- Modify: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` (L96 refs simple = ref 撤去 + L213 consumer 直接参照 + L124 set-state-in-effect、 計 2 件)
- Test: 各 component の test file (該当 fixture 内に prop 遷移 test がない component は C1 内で新設)

**Steps:**

- [ ] **Step 1: 対照表作成 + 算数閉じ確認**。 暫定 eslint.config.mjs を 1 枚落として `pnpm exec eslint . --format json` 実走、 violations を file:line + rule で全件 dump し、 仕分け対照表を作る (列: file:line / rule / 振り分け先 ∈ {C1 fix, C2 fix, rule off, file override, self-ref})。 **本 Step の暫定 config = Step 0.5 と同一形 (anonymous default 形、 rule off / file override なし)** = self-ref 1 が再現する照合用 (正式 config preview を使うと self-ref 1 が消えて 57 になり raw 58 と照合できない)。 期待算数 = **C1 7 + C2 48 + rule off 1 + file override 1 + self-ref 1 = 58 (Step 0.5 raw)**、 self-ref 除外 **57 = 7 + 48 + 1 + 1**。 算数が合わなければ stop & 原因究明。 同時に spec § 8 C1 の 2 観点 ((a) editing=true で外部 prop 変化 → local state 維持 / (b) editing=false → local state 同期) を踏む既存 test を grep し、 不足 component を一覧化。 対照表 + 不足 list 確定後、 暫定 config を `rm` で revert (commit 含めない)。
- [ ] **Step 2: pin test 新設**。 挙動保存 refactor のため、 不足 component に対し 2 観点を `rerender(<Comp prop={new} editing={true|false} />)` で踏む test を新設、 **fix 前に `pnpm vitest run <該当 test>` で pass 確認 (= 現挙動の pin)**。 fix 前 fail = 既存バグ発見の可能性 = **red flag、 即 stop & OT 相談** (歪めて pass させない)。
- [ ] **Step 3: 各 file の fix を 1 件ずつ適用**。 prev-render pattern は spec § 3 / Step 0.6 sample #1 (`+8/-5` = net +3 行 / 構造変更なし) に従い、 refs simple は spec § 3 / Step 0.6 sample #2 (net 0 行) に従う。 各 fix 後に **pin test (Step 2 新設) + 既存 test の両方 pass を確認** (= 挙動保存の証明)。
- [ ] **Step 4: 全件 fix 完了後、 `pnpm exec tsc --noEmit` + `pnpm test` 全 file gate** (Step 0.5 時点 626 test + 補充分が全 pass)。
- [ ] **Step 5: review canonical 経路で dispatch** (上記 規律)。 prompt に「prev-render pattern が +3 行内に収まっているか」 「状態遷移 test が 6 file 全てを cover しているか」 を観点 list に含める。
- [ ] **Step 6: commit** (message `fix(lint): React 19 hook rule 違反を解消 (set-state-in-effect 6 + refs 1) [reviewed]`、 body に「Step 0.6 で実証した prev-render pattern を 6 file に適用、 inline-text-field の refs simple は ref 撤去で net 0 行、 inline-option-row.tsx の L115 refs structural は Sync-fix-1 へ送る (file override は C3 で配備)、 状態遷移 test 補充」)。 Co-Authored-By 付与。

**完了条件**: 7 fix + 必要 test 補充 / tsc クリーン / vitest 全 pass / review Critical 0 / Important 0 / 状態遷移 test が 6 file 全てを cover / [reviewed] tag。

**red flag #1**: 任意 file で prev-render pattern が +3 行を超え構造変更に振れた場合 → 即 stop、 file 名と規模を OT 報告 (該当 file の Sync-fix-1 送り検討)。

---

### Task 2: C2 commit — 機械 fix 48 件

**目的**: spec § 7 C2 = unused-vars 43 (warn) + prefer-const 1 (err) + no-img-element 1 (disable + TODO 波1) + unused-disable directive 3 を機械的に解消。 挙動変更ゼロ。

**Files (touch):**
- Modify: 17 test file (unused-vars 分布、 大半 mock の unused argument)
- Modify: `app/api/review-events/bulk/route.ts:128` (`let orphanFailed` → `const orphanFailed`)
- Modify: `app/(app)/app/upload/_components/upload-form.tsx:638` 直上 (`// TODO(波1): next/image 化 (loader / remotePatterns 設定 + Next 16 default 変更と同時)` + `// eslint-disable-next-line @next/next/no-img-element` の 2 行追加)
- Modify: `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx:96` (unused eslint-disable directive 削除)
- Modify: `lib/cards/replay-card.ts:77,98` (unused eslint-disable directive 削除 × 2)

**Steps:**

- [ ] **Step 1: 暫定 eslint.config.mjs を 1 枚落として `pnpm exec eslint . --format json` を実走し、 違反 **48 件** (err 1 = prefer-const + warn 47 = unused-vars 43 + no-img 1 + unused-disable 3) の file:line 一覧を抽出。 **本 Step の暫定 config = spec § 3 準拠の「正式 config preview」** (named const → export default 形、 `react-hooks/preserve-manual-memoization: 'off'`、 inline-option-row.tsx の `react-hooks/refs` file override 込み、 `@typescript-eslint/no-unused-vars` の `_` prefix ignore 込み)。 これにより rule off 1 + file override 1 + self-ref 1 が config 側で消え、 残違反が C2 fix 48 件と直接照合可能 (Task 1 同 config で実走すると 51 件残り食い違いが説明的になるため Task 1 と別物)。 副次効果: C3 で正式 config を新設する前に「rule overrides が機能して gate が C2 fix 48 件のみで clean になるか」 を事前検証。 `_` prefix 化 vs `// eslint-disable-next-line` の判断を 1 件ずつ確定 (test mock 引数は基本 `_` prefix、 production 側で意図的不使用は理由コメント付き disable)。 Task 1 の対照表 C2 列との照合で 48 件一致を確認、 食い違えば stop。**
- [ ] **Step 2: 機械 fix 適用**: (i) unused-vars 43 件 ← `_` prefix 化 第一選択、 prefix 不適切なら `// eslint-disable-next-line @typescript-eslint/no-unused-vars -- <理由>`、 (ii) prefer-const 1 件 ← `let` → `const`、 (iii) no-img 1 件 ← TODO + disable 2 行追加、 (iv) unused-disable 3 件 ← directive 行削除。
- [ ] **Step 3: 暫定 config を `rm` で revert** (commit に含めない、 C3 で正式版)。 `pnpm exec tsc --noEmit` + `pnpm test` 全 file gate。
- [ ] **Step 4: review canonical 経路で dispatch**。 prompt に「`_` prefix 化が意図的か (本当に未使用か、 mock 命名規約を壊していないか)」 を観点 list に含める。 機械的なので review は軽い想定。
- [ ] **Step 5: commit** (message `chore(lint): 機械的な lint 違反を一括解消 (unused-vars 43 / prefer-const 1 / no-img disable / unused-disable 3) [reviewed]`、 body に内訳 + 「暫定 config 不在のため `pnpm lint` は C3 まで叩かない、 手動 tsc + test で gate」 を明示)。

**完了条件**: 48 fix / tsc クリーン / vitest 全 pass / review pass / [reviewed] tag / 暫定 config 削除済で working tree clean。

---

### Task 3: C3 commit — gate 設置 (eslint.config.mjs + lefthook.yml + ci.yml + package.json)

**目的**: spec § 3 / § 4 / § 5 / § 6 の 4 設定を新設、 gate 初活性。 C3 commit 自身が lefthook の初 trigger を踏み、 self-clean を確認。

**Files (touch):**
- Create: `eslint.config.mjs` (spec § 3 完全準拠、 named const → export default、 anonymous default 違反回避)
- Create: `lefthook.yml` (spec § 4 完全準拠、 pre-commit lint のみ、 `{staged_files}` + glob)
- Create: `.github/workflows/ci.yml` (spec § 5 完全準拠、 checkout → pnpm/action-setup (version 省略 = packageManager 自動読み) → setup-node 24 → install/lint/typecheck/test、 build skip)
- Modify: `package.json` (spec § 6: scripts `lint`/`typecheck`/`prepare` + devDeps `eslint-plugin-react-hooks ^7.1.1` + `lefthook ^2.1.9`、 `packageManager` は touch しない = SSoT)
- Modify: `pnpm-lock.yaml` (`pnpm install` で自動更新)

**Steps:**

- [ ] **Step 0: pnpm 版 + packageManager field の現物確認**。 (a) `pnpm -v` 実行、 出力が `10.33.0` 一致を確認 (devcontainer 実版、 別 version なら stop & OT 相談 = lockfile 再生成リスク回避)。 (b) `grep '"packageManager"' package.json` で `"packageManager": "pnpm@10.33.0"` の存在を確認 (Step 0 投資調査時に裏取り済 = 既存)。 万一不在なら C3 の package.json 編集に `packageManager: "pnpm@10.33.0"` 追加を含める (現状は既存ゆえ touch しない)。 (a)(b) 両方 OK なら次へ。
- [ ] **Step 1: 4 ファイルを spec 完全準拠で作成** (eslint.config.mjs / lefthook.yml / .github/workflows/ci.yml / package.json 編集)。 中身は spec § 3〜§ 6 を 1:1 で写す、 改変しない。 inline-option-row.tsx の file override コメントには「Step 0.6 で L115 単独裏取り、 Sync-fix-1 完了後削除」 を明記。
- [ ] **Step 2: `pnpm install` 実行**。 lefthook が node_modules に追加、 `scripts.prepare` で `lefthook install` が自走し `.git/hooks/pre-commit` 配備。 `ls -la .git/hooks/pre-commit` で存在 + 実行権限を確認。 失敗 → red flag #2 で即 stop & OT 報告。
- [ ] **Step 3: `pnpm exec tsc --noEmit` + `pnpm test` 全 file pass を確認** (Task 1 / 2 で fix 済の前提)。
- [ ] **Step 4: `pnpm lint` (= 新 `eslint . --max-warnings=0`) を実走しクリーン pass 確認**。 違反 0 件、 exit 0。 失敗 → rule overrides 漏れ or fix 漏れ、 stop & 原因解析 (Task 1 / 2 へ戻る判断は OT 相談)。
- [ ] **Step 5: review canonical 経路で dispatch**。 prompt に「4 file が spec § 3 / § 4 / § 5 / § 6 に 1:1 一致しているか」 「`packageManager` SSoT が壊れていないか」 「CI step 順序 checkout → pnpm/action-setup → setup-node が守られているか」 を観点 list に含める。
- [ ] **Step 6: commit** (message `feat(lint): ESLint 9 flat config + lefthook + CI gate 配備 (波2) [reviewed]`、 body に「4 file 新設 + package.json + lock 更新、 packageManager `pnpm@10.33.0` SSoT 維持、 CI `build` は波1 で Next 16 化と同時に有効化、 inline-option-row.tsx の `react-hooks/refs` file override は Sync-fix-1 後に削除予定」)。 commit 実行時に lefthook が **初 trigger**、 staged 中の `eslint.config.mjs` 1 ファイルが lint 対象 = self-clean なら pass。 lint 失敗 → fix → 再 stage → **新 commit** (CLAUDE.md: amend 禁止、 hook 失敗は前 commit がそもそも完了していない扱い)。
- [ ] **Step 7: lefthook 1 回 smoke**。 (a) 適当な `.tsx` (or `.ts`) を 1 行編集 (例: コメント末尾に空白 1 つ追加)、 (b) `git add <file>` + `git commit -m "smoke"` で lefthook 起動、 pre-commit が pass することを確認、 (c) `git reset --hard HEAD~1` で smoke commit を取消 + 編集も revert。 履歴にも working tree にも残らない (stash 経由は自己矛盾のため不採用)。

**完了条件**: 4 file 新設 + package.json 更新 / `pnpm lint` クリーン pass / `.git/hooks/pre-commit` 存在 + 実行権限 / lefthook smoke pass / tsc / vitest pass / review pass / [reviewed] tag / `git status` clean。

**red flag #2**: lefthook が devcontainer (root user / named volume) で hook 登録失敗 → 即 stop、 詳細 + 代替案 (husky / git hook 直配置) を OT 報告。 **red flag #3**: CI 設定が想定外で push 後に fail → spec § 10 (a) の OT 確認待ち (本 task では検出不能、 Task 4 で push 後対応)。

---

### Task 4: sprint 完了報告 + OT 依頼項目の引き渡し

**目的**: 3 commit local 完了後、 push を OT に引き渡し + spec § 10 の OT 依頼 3 件を整理して提示。

**Steps:**

- [ ] **Step 1: 3 commit 順序 + SHA + 行数を chat に整理して報告** (例: `C1 <sha> fix(lint) … +X/-Y 行`、 `C2 <sha> chore(lint) … +X/-Y 行`、 `C3 <sha> feat(lint) … +X/-Y 行`、 `git status` clean、 develop ahead origin by 3)。
- [ ] **Step 2: OT 依頼項目を chat で提示** (spec § 10 a/b/c):
  - (a) GitHub Actions secret / branch protection 現状確認 (本リポは `.github/` 自体不在 = 設定 0 想定、 別途配備済があれば事前共有)
  - (b) devcontainer `post-create.sh:23` の `npm install -g pnpm` (version 未指定 = latest 取得 = drift リスク) → 波1 で corepack 化 or pnpm version 明示の TODO 引き継ぎ
  - (c) push 後の CI 初回 PR で `lint` / `typecheck` / `test` の 3 step pass を smoke (push は OT)
- [ ] **Step 3: CI 初回 fail 時の対応方針を 1 行で明示** (ローカル再現 → fix → fix-up commit で対応、 C3 の amend は禁止)。
- [ ] **Step 4: doc drift 訂正の引き継ぎ依頼**。 依存マトリクス v1.1 (正本、 claude.ai / OT 側保管) の `packageManager` 行を「不在 → 波1 で追加」 から **「既存 (`pnpm@10.33.0`)、 波2 で SSoT 確認済」** に訂正依頼を chat に明示。 Task 3 Step 0 で `package.json` 現物確認した結果を根拠として添える。 版は manifest (package.json) で取る原則を維持、 マトリクス側を実態に合わせる (CC が触れる Session log 側 `docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md` の表 1.4 行も同時に訂正提案)。

**完了条件**: 3 commit local 完了 / OT 依頼 3 件提示 / doc drift 訂正引き継ぎ / push 待ち状態で sprint 完了報告 / 次 sprint (波1: Next 16 化) への引き継ぎメモ用意。

---

## Self-review

- **spec coverage**: § 2 確定事項 → 全 task / § 3 config → Task 3 / § 4 lefthook → Task 3 / § 5 ci → Task 3 / § 6 package.json → Task 3 / § 7 3 commit → Task 1〜3 / § 8 完了条件 → 各 task / § 9 red flag → Task 1 (#1) + Task 3 (#2/#3) / § 10 OT 依頼 → Task 4。 全項目 cover ✓。
- **placeholder scan**: TODO 文言は spec が要求した in-code TODO marker のみ (波1 / Sync-fix-1)、 plan 内の placeholder なし。
- **type 整合**: spec の file:line / scripts 名 / package 名を踏襲、 ズレなし。
