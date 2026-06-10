# ESLint CI gate Step 0 ファクト調査レポート

date: 2026-06-10
scope: 調査のみ (実装・commit なし)。 Codex 指摘「lint が CI/land 経路で機能していない」 が事実かを実コードで裏取り。
result: **Codex 指摘は事実**。 ESLint 設定ファイル 0 / CI workflow 0 / git hook 0 / Vercel build 経路の lint も config 不在のため事実上 dead。 ただし依存 (`eslint-config-next` + plugin 一式) は install 済で、 「config を書けば即動く」 状態。 `next lint` 自体が Next 16 で削除される deprecation も判明。

---

## 1. ESLint 設定の現状

### 1.1 config ファイルの有無

- `.eslintrc*` / `eslint.config.*` (project root + maxdepth 3): **0 件**。
  ```
  $ find /workspaces/RecallMint -maxdepth 3 \( -name ".eslintrc*" -o -name "eslint.config.*" \) | grep -v node_modules
  (empty)
  ```
- `package.json` の `eslintConfig` フィールド: **不在** (`scripts` / `dependencies` / `devDependencies` の 3 block のみ)。
- `docs/setup-notes.md` の lint 言及: **0 件** (eslint / lint で grep 0)。

→ 立ち上げ時からプロジェクトに **ESLint 設定は一度も書かれていない**。

### 1.2 依存と plugin 一式

`package.json` devDependencies:

- `eslint`: ^9.39.4 (ESLint 9.x、 **flat config 必須**)
- `eslint-config-next`: 16.2.4

`eslint-config-next@16.2.4` が transitively 引っ張る plugin (node_modules/eslint-config-next/package.json):

- `@next/eslint-plugin-next` 16.2.4 ← Next 公式 rule
- `eslint-plugin-react` ^7.37.0
- **`eslint-plugin-react-hooks` ^7.0.0** ← `rules-of-hooks` 含む (T3 違反検出に必要)
- `eslint-plugin-jsx-a11y` ^6.10.0
- `eslint-plugin-import` ^2.32.0
- `typescript-eslint` ^8.46.0
- `eslint-import-resolver-{node,typescript}`

`node_modules/.pnpm/` で実 install 確認:

```
@next+eslint-plugin-next@16.2.4
eslint-config-next@16.2.4_…
eslint-plugin-react-hooks@7.1.1_eslint@9.39.4_…
```

→ **plugin は全て揃っている、 config 不在のため発火していないだけ**。

### 1.3 rule 設定の現状

設定ファイル不在のため:

- `react-hooks/rules-of-hooks` (T3 違反 = `Rendered more hooks than during the previous render` 検出 rule) は **load されていない / 設定上 default 任せにすらなっていない**。
- 他 plugin 群 (react / next / jsx-a11y / typescript-eslint) も全部 dormant。

### 影響範囲

「設定書けば動く」 段階だが、 「素直に書く」 にはまだ次の決断が要る:
- ESLint 9 flat config 形式 (`eslint.config.{js,mjs,cjs,ts,mts,cts}`) で書く (旧 `.eslintrc.*` は ESLint 9 で deprecated)。
- `eslint-config-next` の compat 経路 (`FlatCompat` + extends) か flat config-native の `next/core-web-vitals` / `next/typescript` を import するか (Next 16 公式は flat config-native 推奨)。
- どの rule を error / warn / off にするか (recommended プリセットでスタートか custom か)。

### red flag

- **中**: ESLint 9 flat config 自体が新しい (~2024 以降)、 `eslint-config-next` の flat config 対応 API は version で揺れる (16 で flat 対応強化)。 採用形は次工程 spec 必須。

---

## 2. lint が実際に走る経路の有無

### 2.1 package.json scripts

```json
"lint": "next lint"
```

実走:

```
$ pnpm lint
> next lint
`next lint` is deprecated and will be removed in Next.js 16.
For new projects, use create-next-app to choose your preferred linter.
For existing projects, migrate to the ESLint CLI:
npx @next/codemod@canary next-lint-to-eslint-cli .

? How would you like to configure ESLint? https://nextjs.org/docs/app/api-reference/config/eslint
❯ Strict (recommended)
   Base
   Cancel
 ELIFECYCLE  Command failed with exit code 1.
```

- **対話プロンプト**で stuck (config 不在のため初回 setup 案内)、 非対話環境 (CI) では即時 fail で抜ける。
- 上部の deprecation warning: **`next lint` は Next 16 で削除**、 ESLint CLI への codemod (`npx @next/codemod@canary next-lint-to-eslint-cli .`) を案内。

### 2.2 直 ESLint 呼び出し

```
$ pnpm exec eslint --version
v9.39.4

$ pnpm exec eslint .
From ESLint v9.0.0, the default configuration file is now eslint.config.js.
If you are using a .eslintrc.* file, please follow the migration guide
to update your configuration file to the new format:
https://eslint.org/docs/latest/use/configure/migration-guide
```

→ config 不在で直 invoke も走らない。

### 2.3 CI workflow

```
$ ls -la /workspaces/RecallMint/.github
ls: cannot access '/workspaces/RecallMint/.github': No such file or directory
```

- **`.github/` ディレクトリ自体が存在しない** → CI workflow 0。
- → 「CI 経路で lint は走っていない」 ではなく **そもそも CI 経路自体が存在しない**。 test / tsc / build いずれも未配備。

### 2.4 git hook / pre-commit / pre-push

- `.git/hooks/`: `.sample` ファイルのみ (`applypatch-msg.sample` 等 14 件、 actual hook 無し)。
- `.husky/`: **不在**。
- `.lefthook*` / `lefthook*`: **不在**。
- CLAUDE.md 言及の `.claude/hooks/check-review.sh` は Claude Code hook (Stop hook) であり git hook ではない。

→ pre-commit / pre-push 経路 0。

### 2.5 next build 時の lint 挙動

- `next.config.ts` (43 行) に `eslint` セクション無し:
  ```
  $ grep -n "eslint\|ignoreDuringBuilds" /workspaces/RecallMint/next.config.ts
  (empty)
  ```
- Next 15 デフォルトは `eslint.ignoreDuringBuilds: false` (= build 時に lint 実行)。
- ただし **ESLint config 不在のため build 時の lint も初回 setup 案内 or skip** に倒れる (実走 build は未検証)。
- 経験事実: CLAUDE.md「本番初回 deploy 成功」 から、 **Vercel build は lint で fail せず通過した** ことが判る。 →「build 時 lint も事実上 dead」 と判定。 厳密な内部挙動は Next 15 実装依存で本調査では裏取り未完。

### 影響範囲

- **5 経路 (script / direct / CI / git hook / build) すべて lint gate として機能していない**。
- 配備対象は: (i) CI workflow 新設、 (ii) ESLint config 作成、 (iii) `next lint` → `eslint .` 移行、 (iv) 任意で pre-commit hook。

### red flag

- **高**: 全経路 dead。 1 経路でも復活させれば次回 PR からは網に乗るが、 既存違反の総量 (項目 3) が不明な状態で gate を立てると merge 不能になる可能性。

---

## 3. 実害の裏取り (現状の hook-rules 検出可否)

### 3.1 「設定不在 vs 設定緩い」 の切り分け

- 上記 2.1 / 2.2 の通り、 **設定ファイル不在 + script の対話 prompt で stuck** のため、 **現状の lint 実走は不能**。
- 「設定はあるが走らせる経路が無いだけ」 ではなく、 **設定そのものが不在**。

### 3.2 件数測定

- 設定不在のため自動経路で測定不能。
- `pnpm exec eslint .` 直叩きでも config 不在 hint で抜ける。
- ESLint 9 flat config は CLI フラグだけで全 plugin を load する経路が無い (旧 `.eslintrc.*` を `--rulesdir` で代用する手は ESLint 9 で廃止)。
- → **件数把握には暫定 config 配備が必要** (= 次工程 spec で「Strict プリセット試走で件数把握 → 修正方針決定」 を組む)。

### 3.3 ただし plugin 自体は揃っている (項目 1.2 参照)

`eslint-plugin-react-hooks@7.1.1` を含む全 plugin が `node_modules/.pnpm/` に存在。 config に `'plugin:react-hooks/recommended'` 相当を入れれば `rules-of-hooks` (error) が即発火する。

### red flag

- **高**: 件数 unknown。 暫定 config 試走の前に「想定 100+ 件出たらどう scope を切るか」 を決めておかないと、 別 sprint「既存違反一斉修正」 を誘発。 brief の red flag #1 がそのまま該当。

---

## 4. T3 crash の再現条件と検出可否

### 4.1 T3 違反の構造 (b02c072 commit より)

修正 commit: `b02c072e1688fd63ee674660ad0549742041bc44`
- 元違反: T3 commit `bcc53b1` で `app/(app)/app/tags/_components/option-list.tsx` の `useSensors` を **早期 return より後** に追加。
- 結果: `activeCategoryId` null → non-null 遷移で hook 数 3 → 4 に変化、 React が「Rendered more hooks than during the previous render」 を throw。
- 既存 fixture は `activeCategoryId='cat-1'` 固定で初回から non-null 経路 (= 4 hook) に入っていたため test を unfair に通過、 stg smoke で初発覚。

### 4.2 ESLint で検出される rule

- `eslint-plugin-react-hooks` の `react-hooks/rules-of-hooks` rule。
- recommended preset で error 設定 (公式 default)。
- 「早期 return / 条件分岐の後に hook を呼ぶ」 パターンを **static analysis で検出**。

### 4.3 現状検出されるか

- **検出されない**。 理由は **rule off ではなく、 ESLint config 不在で plugin そのものが load されていない** (項目 1 + 3.1)。
- ↑ Codex 指摘「lint が CI/land 経路で機能していない」 の **物的証拠**。

### 4.4 検出を効かせるための最小条件

1. `eslint.config.mjs` (flat) 新設、 `react-hooks` plugin + `rules-of-hooks: 'error'` を有効化
2. `pnpm exec eslint .` を CI step か pre-commit hook に通す

→ いずれも次工程 spec で配備。

### red flag

- **無し** (現状の事実確認結果、 検出可否の論点は技術的に明確)。

---

## 5. 導入余地

### 5.1 monorepo か単一 package か

`pnpm-workspace.yaml`:
```yaml
onlyBuiltDependencies:
  - bufferutil
  - utf-8-validate
overrides:
  uuid: ^14.0.0
  postcss: ^8.5.10
```

→ `packages:` セクション無し、 `onlyBuiltDependencies` + `overrides` のみ。 **単一 package** (pnpm workspace 機能を build 制御に流用しているだけ)。

### 5.2 CI workflow 配備候補

- `.github/workflows/` 自体不在 → 新規作成。 候補ファイル名: `ci.yml` / `lint.yml` / `pull-request.yml` 等。
- 統合する step 候補: lint + tsc + vitest (既存 `pnpm test` / `pnpm exec tsc --noEmit` を組合せ)。
- Vercel 連携: 現状 Vercel deploy は GitHub push trigger で自走 (vercel.json 参照、 ただし build step に lint gate なし)。 CI gate と Vercel build を二段にするのが標準。

### 5.3 pre-commit / pre-push hook 配備

- 既存依存: husky / lefthook / simple-git-hooks **すべて未 install**。 新規 dep。
- 単一 package + 既存に lint-staged 系 dep 無しなので、 王道は:
  - **husky + lint-staged**: npm dep 2 個、 `package.json` scripts + `.husky/pre-commit` 設置
  - **lefthook**: 単一 npm dep、 `lefthook.yml` 単一設定ファイル、 binary 配布で高速
- どちらでも単一 package 想定で素直に組める。 既存依存とぶつからない。
- pre-commit は任意 (CI gate と二段構え)。 CI のみで足りるなら hook 不要。

### red flag

- **無し** (単一 package 確定、 候補は技術的にいずれも素直)。

---

## 6. 別件 red flag: `next lint` deprecation (要 OT 注意)

Next 15.5.15 → `next lint` 実行で公式 deprecation warning が出る:

```
`next lint` is deprecated and will be removed in Next.js 16.
…
For existing projects, migrate to the ESLint CLI:
npx @next/codemod@canary next-lint-to-eslint-cli .
```

意味:
- Next 16 で `next lint` 削除。 現在依存 `"next": "^15.5.15"` だが、 既に next pull で 16.x が降ってくる可能性 (semver caret ^15 は 15.x の上限のみ縛るので 16 には飛ばないが、 次回 Next 16 upgrade で確実に死ぬ)。
- 配備時の選択肢:
  - (a) `"lint": "eslint ."` (直 invoke) — Next 16 対応、 codemod 推奨経路
  - (b) `"lint": "next lint"` 維持 — Next 16 まで猶予あるが将来確実に書き換え
- → **(a) を採用すべき**。 spec で確定させる。

---

## 全体 red flag 評価

| 項目 | level | 内容 |
|---|---|---|
| 1 ESLint 設定の現状 | 中 | flat config + eslint-config-next の API 形 (compat vs native) を spec で確定 |
| 2 lint が走る経路 | **高** | 全 5 経路 (script / direct / CI / git hook / build) dead |
| 3 実害件数 | **高** | 設定不在で測定不能、 暫定 config 試走 → 件数把握 → 修正 scope 決定が要 |
| 4 T3 検出可否 | 低 | rule 自体は plugin 揃ってる、 config で enable すれば即動く |
| 5 導入余地 | 低 | 単一 package、 候補は素直 (CI = GitHub Actions、 hook = husky or lefthook) |
| 6 next lint deprecation | **高** | Next 16 で削除予告、 採用方針は `eslint .` 直 invoke 推奨 (codemod あり) |

---

## 次の判断材料

1. **gate 経路の優先**: (a) CI workflow 新設 (.github/workflows/) のみ / (b) CI + pre-commit hook の二段 / (c) Vercel build 時 lint も活かす (eslint.ignoreDuringBuilds=false 明示) のうちどこまで含めるか
2. **lint 命令の形**: `next lint` 維持 (Next 16 まで猶予) / `eslint .` 直 invoke に即移行 (codemod 利用) のどちらを選ぶか
3. **既存違反の scope**: 暫定 config 試走 → 件数把握 → 「(i) 全件即修正、 (ii) 段階導入 (warn から start)、 (iii) 特定 rule (rules-of-hooks 含む A-list) のみ error、 残り warn」 のどれを採用するか
4. **pre-commit hook の要否と manager**: 不要 / husky+lint-staged / lefthook のいずれか
