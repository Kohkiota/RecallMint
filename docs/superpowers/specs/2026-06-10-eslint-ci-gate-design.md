# ESLint 9 flat config + lefthook + CI gate — 波2 sprint design

date: 2026-06-10
status: design (user review gate 待ち)
正本: 依存ベースライン `recallmint-deps-target-matrix-2026-06-10-v1.1` 波2
前提調査: `docs/superpowers/sessions/2026-06-10-eslint-ci-gate-step0-investigation.md` (Step 0) / Step 0.5 (違反実測 57 件 / 27 file、 rules-of-hooks 0 件) / Step 0.6 (サンプル fix で set-state-in-effect +3 行・refs simple net 0 行 を実証)

---

## 1. 背景・スコープ

Step 0 で lint gate が全 5 経路 (script `next lint` 対話 stuck / direct eslint config 不在 / CI workflow `.github/` 自体不在 / git hook `.sample` のみ / next build = config 不在で事実上 dead) で機能していない事実が確定した。 結果として T3 hook order regression (b02c072 hotfix) 級の crash を静的解析で事前 catch できない状態が続いていた。

本 sprint は **(i) eslint.config.mjs (flat) で config 配備、 (ii) lefthook (local pre-commit) と (iii) GitHub Actions (merge gate) の 3 層**で lint gate を立て、 同時に Step 0.5 で実測した 57 件の違反を全件 error gate に通せる状態まで repo を整える。

Next 16 / 依存全体 bump (波1) は本 sprint 範囲外。 波 2 完了時点では Next 15.5 / eslint-config-next 16.2.4 の **一時状態**で gate を運用し、 波1 で next・config を同時に 16.2.9 へ昇格させて解消する。 `@next/eslint-plugin-next` は next への hard peer を持たないため、 本ズレは実害ほぼなし。

## 2. 確定事項 (覆さない)

| 項目 | 確定値 | 根拠 |
|---|---|---|
| eslint | **9.39.4 維持** | eslint-config-next 同梱 plugin が peer `^9` 頭打ち、 vercel/next.js#91702 open。 10 採用は波 2 では不採用 |
| eslint-config-next | **16.2.4 維持** | bump 16.2.9 は波1。 next との一時ズレは hard peer なしで実害軽微 |
| eslint-plugin-react-hooks | **direct devDep ^7.1.1** | 現状 transitive、 drift 事故回避 |
| lefthook | **新 devDep ^2.1.9** | pre-commit (local 迅速性) |
| GitHub Actions | **新 `.github/workflows/ci.yml`** | merge gate |
| 違反処理 | **全件 error gate** (`--max-warnings=0`) | 段階導入なし、 57 件僅少 |
| Task 分割 | **3 commit** (OT 確定) | 挙動変更 fix / 機械 fix / gate 設置 を厳格分離 |
| lefthook scope | **lint のみ** (OT 確定) | typecheck/test/build は CI に寄せる、 役割分離 |
| **pnpm 版** | **`package.json` `"packageManager": "pnpm@10.33.0"` を Single Source of Truth** | devcontainer 実 pnpm = 10.33.0、 lockfile 9.0 形式と整合。 CI は `pnpm/action-setup@v4` の `version` 引数を **省略** し packageManager field を自動読み、 SSoT 1 箇所で全環境同期 |

## 3. `eslint.config.mjs` (新設)

flat config、 ESM、 `eslint-config-next/core-web-vitals` + `/typescript` extend + rule overrides + file overrides + ignores。 **named const → export default** 形 (`import/no-anonymous-default-export` 違反回避、 default 形は Step 0.6 暫定実走で自己言及違反として検出済)。

```js
// recallmint flat ESLint config (波2)。
// 詳細: docs/superpowers/specs/2026-06-10-eslint-ci-gate-design.md
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `_` prefix の意図的 unused (test mock 等) を許容。 preset は default で
      // ignore しないため明示。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // React Compiler OFF 制約 (recallmint-deps-target-matrix v1.1) と紐づく
      // 一時 off。 Compiler 採用 sprint で再有効化 + 手動 memo 修正。
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    // TODO(Sync-fix-1): inline-option-row.tsx の refs structural fix は
    // optimistic 経路収束 (event handler 書換) と同 working set のため波2 では
    // 直さない。 Step 0.6 で本 file の refs 違反は L115 単独 = `optionsRef.current
    // = options` の 1 行のみと裏取り済。 Sync-fix-1 完了後この override block を削除。
    // glob の `(...)` `[...]` は minimatch では alternation / character class と
    // 解釈されるため、 Next route group と dynamic segment は `\\(...\\)` `\\[...\\]`
    // で escape する (escape 不在で silent に override 効かず → gate 立ち上げ時 fail)。
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_components/inline-option-row.tsx'],
    rules: { 'react-hooks/refs': 'off' },
  },
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'coverage/**'],
  },
]

export default config
```

不変条件:
- core-web-vitals + typescript 2 preset で a11y / next / react / typescript-eslint / import / react-hooks plugin 一式が load される (eslint-config-next 16.2.4 の transitive 経由)
- `--max-warnings=0` 運用前提のため不要 warn を残さない (`_` prefix で逃げ口確保)
- inline-option-row.tsx の rule off は Sync-fix-1 完了後削除を **spec / commit message / 該当 override コメントの 3 重明示**
- file override は **L115 単独**前提 (Step 0.6 裏取り済)、 将来同 file に別 refs 違反が湧いた場合は Sync-fix-1 完了前でも file override を見直す

## 4. `lefthook.yml` (新設、 pre-commit local)

```yaml
# recallmint lefthook config (波2)。 pre-commit は lint のみ (実走 11 秒)。
# typecheck / vitest / build は CI 側 (.github/workflows/ci.yml) に寄せる。
pre-commit:
  commands:
    lint:
      run: pnpm exec eslint --max-warnings=0 {staged_files}
      glob: '*.{ts,tsx,js,mjs,cjs}'
      stage_fixed: false
```

- `{staged_files}` で staged のみ流し、 commit 単位の高速性維持
- `glob` で TS/JS 関連のみ (md / json / yml の commit を遅延させない)
- `stage_fixed: false` で auto-fix 禁止 (作業者の明示意図を尊重)
- install: `pnpm install` 時に `lefthook install` が自走するよう `package.json` `scripts.prepare` に追加 (§ 6)

## 5. `.github/workflows/ci.yml` (新設、 merge gate)

```yaml
# recallmint CI (波2)。 main / develop への PR と push で gate を立てる。
name: CI
on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # pnpm/action-setup は version 引数を省略 → package.json の packageManager
      # field (pnpm@10.33.0) を自動読み。 pnpm 版の SSoT = packageManager field。
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      # build は波1 で Next 16 + Turbopack default に整合させる際に有効化。
      # 波2 時点では skip (Next 15 のまま、 lint/typecheck/test で gate は十分)。
```

設計判断:
- node 24 (active LTS、 devcontainer と同じ)
- pnpm 版指定は **`packageManager` 自動読み**で SSoT 1 本化 (drift 防止、 brief 要求)
- 順序 = brief 通り (install → lint → typecheck → test)、 **build は skip** (波1 で Next 16 化と同時有効化、 二度手間回避)
- secrets 不要 (lint / typecheck / test いずれも env 依存なし)、 branch protection との整合は OT 確認 (§ 10)

## 6. `package.json` 変更点

事前確認: `grep "prepare" package.json` = **0 件**、 既存 `scripts.prepare` なし → 新設で衝突なし。

```diff
   "scripts": {
     "dev": "next dev",
     "build": "next build",
     "start": "next start",
-    "lint": "next lint",
+    "lint": "eslint . --max-warnings=0",
+    "typecheck": "tsc --noEmit",
     "test": "vitest run",
+    "prepare": "lefthook install",
     ...
   },
   "devDependencies": {
+    "eslint-plugin-react-hooks": "^7.1.1",
+    "lefthook": "^2.1.9",
     ...
   }
```

- `"lint"` を `next lint` (Next 16 で削除予定 + 対話 prompt stuck) → `eslint . --max-warnings=0` に置換
- `"typecheck"` 新設 (CI gate で呼ぶ)
- `"prepare"` 新設 (`pnpm install` 時に lefthook hooks を `.git/hooks` に install、 衝突なし裏取り済)
- `eslint-plugin-react-hooks` を direct devDep 化 (drift 事故回避)
- `lefthook` 新 devDep
- **`packageManager: "pnpm@10.33.0"` は touch しない** (SSoT、 § 2 確定事項)

## 7. 違反 fix 配置 (3 commit)

| commit | 名前 | 内容 | 影響 file | review 性質 |
|---|---|---|---|---|
| **C1** | `fix(lint): React 19 hook rule 違反を解消 (set-state-in-effect 6 + refs 1)` | hook fix 7 件 (prev-render pattern 6 + ref 撤去 1) + **状態遷移 test 補充** (§ 8 完了条件) | category-row / option-row / card-tag-edit-fields / card-tag-option-list / inline-option-row / inline-text-field の 6 ファイル touch + 該当 test ファイル | 挙動変更あり、 review **重点** ([reviewed] tag) |
| **C2** | `chore(lint): 機械的な lint 違反を一括解消 (prefer-const 1 / no-img disable / unused-disable 3)` | 機械 fix **5 件**: `const` 化 1 (err) + upload-form.tsx:638 に `// eslint-disable-next-line @next/next/no-img-element TODO(波1): next/image 化` 1 + unused eslint-disable 削除 3。 **unused-vars 43 件は既に `_` prefix 済**で正式 config の `argsIgnorePattern: '^_'` により silently 消化 (code fix 不要、 Task 2 BLOCKED 報告 2026-06-10 で判明) | 4 file (route.ts / card-tag-edit-fields / replay-card × 2 / upload-form) | 機械的、 review **軽** ([reviewed] tag) |
| **C3** | `feat(lint): ESLint 9 flat config + lefthook + CI gate 配備 (波2)` | `eslint.config.mjs` 新設 / `lefthook.yml` / `.github/workflows/ci.yml` / `package.json` script + devDep。 gate が立った瞬間 0 違反 (前 commit で fix 済) | 4 新 file + package.json + pnpm-lock.yaml | 設定、 review **中** ([reviewed] tag) |

### C3 まで lint コマンドを叩かない運用 (明記)

- **C1 / C2 commit 時点では `eslint.config.mjs` 不在**のため `pnpm lint` (= 現状 `next lint`) は対話 prompt で stuck (Step 0 で実証済)。 また lefthook も devDep 未追加 = pre-commit hook 走らない。 → **C1 / C2 commit 時の gate は CC が手動で `pnpm exec tsc --noEmit` + `pnpm test` のみ実行**、 `pnpm lint` は呼ばない
- **C3 commit 作成手順**: (i) ファイル編集 → (ii) `pnpm install` (lefthook を node_modules に追加、 `scripts.prepare` で `.git/hooks/pre-commit` 配備) → (iii) `git add` + `git commit`。 (iii) の瞬間に **lefthook が初めて起動**し、 C3 自身の staged file (eslint.config.mjs / package.json / lefthook.yml / ci.yml のうち `.{ts,tsx,js,mjs,cjs}` 該当 = eslint.config.mjs 1 件) を lint。 eslint.config.mjs 自身がクリーンなら pass、 これが gate 初活性
- **C3 完了後**は `pnpm lint` がクリーン pass (`--max-warnings=0`)、 以降の commit は lefthook で都度 gate

## 8. 完了条件 (全 commit 共通 + commit 別の追加条件)

### 全 commit 共通
- `pnpm exec tsc --noEmit` exit 0
- `pnpm test` 全 file pass (b02c072 の hook regression pin test 含む)
- code review: `superpowers:requesting-code-review` canonical 経路 (general-purpose subagent + template 改変なし) で Critical 0 / Important 0
- [reviewed] tag 付与 (CLAUDE.md 規律、 重要 Fix 裏取り対象外 = review pass で即 [reviewed])

### C1 追加完了条件 (格上げ): **状態遷移 test の存在**

prev-render pattern fix (set-state-in-effect 6 件) は「編集中の prop 変化 → local state 同期挙動」 を変える。 C1 commit に **以下の test (rerender 経路で prop 遷移を踏むもの) が含まれていること**:

| fix 対象 file | 既存 test file | 必須 test 観点 |
|---|---|---|
| category-row.tsx | `category-row.test.tsx` 内 (新設可) | (a) editing=true で `category.name` 外部変化 → local value 維持、 (b) editing=false で外部変化 → local value 同期 |
| option-row.tsx | `option-row.test.tsx` 内 | 同上 (option.name 軸) |
| card-tag-edit-fields.tsx | `card-tag-edit-fields.test.tsx` | 同 file 内 prop 遷移経路 |
| card-tag-option-list.tsx | `card-tag-option-list.test.tsx` | 同上 |
| inline-option-row.tsx (L483) | `inline-option-row.test.tsx` (Stage 4 cutover 時) | option `value` prop の rerender 経路 |
| inline-text-field.tsx (L124 set-state + L96 refs) | `inline-text-field.test.tsx` | `initialValue` prop rerender 経路 |

既存 fixture で踏んでいる経路は再利用、 踏んでいない component は **C1 内で test を新設**する (b02c072 が `option-list.test.tsx` で hook regression pin を補充した前例と同形)。 test 不在のまま挙動変更 fix を merge しない。

### C2 追加完了条件
- `// TODO(波1): next/image 化` コメントが `upload-form.tsx:638` の disable directive 直上に存在 (波1 sprint 着手時に grep で拾える形)

### C3 追加完了条件
- C3 commit 直後の `pnpm lint` が `--max-warnings=0` でクリーン pass
- lefthook 初動作の 1 回 smoke (devcontainer 内、 適当な `.tsx` 編集 → stash → commit → 復元、 stop & 報告 if fail)
- `.git/hooks/pre-commit` が `pnpm install` 後に存在

## 9. red flag (検出時 stop & 相談)

1. set-state-in-effect 6 件のうち、 prev-render pattern が **+3 行を超える file** 出現 → file 名 + 規模を報告 (Step 0.6 で 1 件 only サンプル、 残 5 件で構造変更必要なケースが出る可能性)
2. lefthook が devcontainer (root user / named volume) で hook 登録失敗 → 詳細 + 代替 (husky / git hook 直配置) を報告
3. CI workflow 新設で既存 GitHub Actions secret / branch protection と衝突 → 詳細を OT へ
4. inline-option-row.tsx に L115 以外の refs 違反が湧いた場合 (将来コード追加で) → file override 見直しを spec で再検討

## 10. OT 依頼項目

- (a) **GitHub Actions secret / branch protection 現状**: 本リポジトリは `.github/` 自体不在 = 設定 0 想定。 OT が手動で別途配備済の secret / protection があれば事前共有
- (b) **devcontainer post-create.sh の `npm install -g pnpm`** は version 未指定で latest 取得 = drift リスクあり。 本 spec scope 外、 **波1 で corepack 化 or pnpm version 明示**を検討。 波2 時点では `packageManager` field の自動読みで CI と実環境を揃える形に倒す (drift 顕在化したら OT へ報告)
- (c) **CI 初回 PR で gate を smoke**: C3 commit を含む PR で CI が実走、 lint/typecheck/test の 3 step pass を確認 (push は OT)
