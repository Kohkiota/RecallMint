# 波1 (Next 16 核) 実装 plan

- 日付: 2026-06-11
- branch: `develop` (commit のみ、 push は OT 判断 — 既定方針)
- spec source: `docs/superpowers/specs/2026-06-11-wave1-next16-design.md` (commit `6953cc2`)
- 正本 matrix: `docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md` (commit `17ff88b`)
- 予備 Step 0: `docs/superpowers/sessions/2026-06-11-wave1-next16-step0-investigation.md` (commit `db6a180`)
- 実装方式: `superpowers:subagent-driven-development` (task 単位 fresh subagent + task 間 review、 CLAUDE.md §「実装方式 (既定)」 既定)

## Goal

prod 稼働中の `next 15.5.15` に存在する 13 件の Next.js CVE (高 7 / 中 4 / 低 2、 Step 0 §2.1.2) を解消し、 Next 16.2.9 LTS + React 19.2.7 + Clerk 7.4.3 + Node 24 LTS への移行を **6 commits** で実行する。 `middleware.ts` → `proxy.ts` 化と周辺整合 (overrides / webpack 削除 / pg dead weight / corepack) を同 sprint 内で完結。

## Architecture / 設計判断 (sprint 全体共通)

- **codemod は使わない**: Step 0 dry-run でソース変換 0 件と確認済、 package.json 書換は手で正確 pin。 `pnpm.overrides` block は workspace.yaml SSoT 方針と衝突するため codemod 出力を採用しない。
- **overrides 4 件 SSoT = `pnpm-workspace.yaml`**: `react / react-dom / uuid / postcss`。 codemod 提案の `@types/react` / `@types/react-dom` は移植しない (C2 の exact pin 自身で peer drift を防ぐ最小手で十分、 spec §6.1)。
- **runtime 移行**: `proxy.ts` は Node runtime 固定 (Next 16)。 RecallMint の edge runtime 利用は実質ゼロ (`runtime = 'nodejs'` 配備済 9 routes、 Step 0 §1.6 G-7) のため移行コスト 0。
- **Clerk 7.4.3 は core bump 同 commit に含む**: Next 16 + proxy.ts 公式 base、 smoke #1 (#8302 回帰) で fail した場合のみ follow-up commit で `^7.2.9` へ revert (spec §4.2)。
- **commit 順序** (実装中改訂、 2026-06-11): C1 (overrides 床) → **C4 (webpack 削除、 C2 の前提)** → C2 (核 bump) → C3 (proxy 化) → C5 (pg 削除) → C6 (corepack)。 C2 build gate (`pnpm build` Turbopack default) で Next 16 breaking を検出 — Step 0 §1.6 G-5 の評価「影響軽微」 は Next 15 前提で、 16 では「webpack config 検出 + turbopack config 不在 → build fail」 ガードに昇格していた。 C4 を C2 の pre-step として運用、 C3/C5/C6 は C2 後の独立 cleanup で順不同可。

## 全体ルール (各 task 共通、 再掲しない)

- **絶対ルール参照**: CLAUDE.md §Stripe / §Clerk / §AI は本 sprint で変更しない (依存 bump 経路のみ)。 認証経路 (Clerk middleware) は smoke で挙動連続性を担保。
- **review 経路**: feat(_) commit は CLAUDE.md §Review 必須経路 (`superpowers:requesting-code-review` skill canonical + general-purpose subagent + 厳格 prompt + template 改変なし)。 review checklist に **whole-repo `pnpm lint --max-warnings=0` exit 0 確認**を必ず含める。 chore(_) [no-review] は実装ロジック変更なしのみ。
- **commit tag**: spec §2 通り。 feat(_) は review pass 後に `[reviewed]`、 chore(_) は `[no-review]`。 `--no-verify` 使用禁止 (CLAUDE.md §「Sprint 完了 gate」)。
- **完了 gate**: 全 task 完了後 (C1-C6 累積後) に sprint 完了 gate を 1 回実行 (本 plan 末尾参照)。 各 task 内は task 単位 test + lint で十分。
- **CC が触れない領域**: secret rotate (deploy 後 OT)、 Vercel Project Settings Node version (OT)、 Stripe webhook 実機 smoke (OT)。 plan からこれらは除外。
- **絶対 rule 変更時の停止**: matrix v1.3 / spec のいずれかと矛盾する選択を迫られたら subagent 自己判断せず stop して OT 確認。

---

## Tasks

### C1: pnpm-workspace.yaml overrides に react/react-dom 19.2.7 追加

- **目的**: C2 install で react peer 解決が割れない床を先行整備する。 `pnpm-workspace.yaml` SSoT 方針 (spec §6.1) を確立する commit。
- **制約**:
  - `pnpm-workspace.yaml` の `overrides:` セクションに `react: 19.2.7` と `react-dom: 19.2.7` の 2 行を追加。 既存 `uuid: ^14.0.0` / `postcss: ^8.5.10` は **そのまま維持** (順序自由)。
  - yaml syntax (`  key: value`、 indent 2 spaces) を既存に合わせる。 caret / 文字列クォート不要。
  - `package.json` には `pnpm.overrides` block を**追加しない** (codemod 提案不採用、 spec §6.2)。
- **完了条件**: lefthook pre-commit pass (yaml 修正のみ、 lint skip)、 yaml syntax error なし。 commit `chore(deps): C1 pnpm-workspace.yaml に react/react-dom overrides 追加 [no-review]`。 yaml 2 行追加 + 実装ロジック変更なしのため CLAUDE.md §Review 例外で skip 可。

### C2: Next 16 + React 19.2 + Clerk 7.4.3 + Node 24 core bump

- **目的**: prod CVE 13 件解消 + Next 16 LTS 移行 + Clerk proxy.ts 公式 base 整合。 本 sprint の核 commit。
- **制約**:
  - `package.json` の以下を **exact pin** (caret 外す) で書換 (matrix v1.3 §3.1):
    - `dependencies`: `next: "16.2.9"` / `react: "19.2.7"` / `react-dom: "19.2.7"` / `@clerk/nextjs: "7.4.3"`
    - `devDependencies`: `@types/react: "19.2.17"` / `@types/react-dom: "19.2.3"` / `eslint-config-next: "16.2.9"` / `@types/node: "^24.13.2"` (24 系のみ caret 維持、 spec §6.3)
  - 新規 field `"engines": { "node": "24.x" }` を `package.json` 末尾に追加 (matrix v1.3 §3.5)。 `packageManager: "pnpm@10.33.0"` は維持。
  - codemod を**使わない** (手で書く、 spec §6.2)。 `pnpm install` で lockfile 更新 (初回は `--frozen-lockfile` 付けない)。
  - **lint gate 分岐**: install 後 `pnpm lint` で `eslint-config-next 16.2.4 → 16.2.9` の rule 差分による**新規違反**が出た場合、 **C2 内 fix せず stop**。 chat に件数 + rule 別内訳 (例: `react-hooks/exhaustive-deps × 3`, `@next/next/no-img-element × 1`) を報告、 波2 と同じ仕分け (機械 fix / rule off / override) を OT 判断で確定してから follow-up commit で対応。 stop 時点までの package.json + lockfile 変更は維持。
- **完了条件**: install 完走、 `pnpm-lock.yaml` `overrides:` セクションに **4 件全件存在** (`react / react-dom / uuid / postcss` を grep 確認、 spec §3.2)、 `pnpm lint` exit 0 (or 上記分岐で stop)、 `pnpm typecheck` exit 0、 `pnpm test` 全 pass、 `pnpm build` (Turbopack default) 完走。 review 経路通過後に commit `feat(deps): C2 Next 16 + React 19.2 + Clerk 7.4.3 + Node 24 core bump (波1) [reviewed]`。

### C3: middleware.ts → proxy.ts 化 + matcher 拡張

- **目的**: Next 16 推奨 path への移行 (`proxy.ts` Node runtime)、 Clerk 7.4.3 公式 matcher 整合 (`/__clerk/(.*)`)。
- **制約**:
  - `git mv middleware.ts proxy.ts` で file rename。 中身の `export default clerkMiddleware(...)` はそのまま (codemod 検出外形態、 Step 0 §1.2)。
  - `proxy.ts` 冒頭コメント: `// env prefix validation (side-effect, Edge runtime)` → `// env prefix validation (side-effect, Node runtime)`。 「`middleware.ts` の」 を「`proxy.ts` の」 に書換。
  - `config.matcher` 配列の末尾に `'/__clerk/(.*)'` を追加 (matrix v1.3 §5 #8、 Clerk 7.4.3 公式 proxy.ts 例)。 既存 2 行 (`/((?!_next|...).*) ` / `/(api|trpc)(.*)`) はそのまま。
  - `lib/clerk.ts` 冒頭コメント `Imported as a side-effect from middleware.ts (Edge runtime) and lib/auth/ensure-user.ts (Node runtime) for dual-runtime fail-fast` を `Imported as a side-effect from proxy.ts (Node runtime) and lib/auth/ensure-user.ts (Node runtime) for fail-fast` に書換 (Step 0 M-4)。
  - `skipMiddlewareUrlNormalize` 系 config の rename 該当は**追加変更なし** (Step 0 §1.6 G-6 grep で 0 件確認済)。
  - 既存の `clerkMiddleware()` matcher / `contentSecurityPolicy: {}` default mode は変更しない (CLAUDE.md §Clerk「保護ルート設定」 維持)。
- **完了条件**: `pnpm typecheck` / `pnpm lint` / `pnpm build` 全 pass、 dev で `/app` 未ログインアクセスが `/sign-in` に redirect される (= auth gate 連続性)。 review 経路通過後に commit `feat(runtime): C3 middleware.ts → proxy.ts 化 + matcher 拡張 (波1) [reviewed]`。

### C4: next.config.ts webpack block 削除 (Turbopack default 化)

- **目的**: Next 16 で Turbopack が default、 webpack 設定残置による警告 / build fail を回避。 dev watch ignored 5 path は Turbopack default で不要 (Step 0 §1.6 G-5)。
- **制約**:
  - `next.config.ts` の `webpack: (config, { dev }) => { ... watchOptions.ignored = [...] ... return config }` block を**丸ごと削除**。
  - 上の `securityHeaders` 配列と `async headers()` は維持 (Phase 1 G-baseline-3 security header 配備、 CLAUDE.md と無関係に既設)。
  - `reactStrictMode: true` も維持。
- **完了条件**: `pnpm build` (Turbopack default) 完走、 `pnpm dev` 起動可。 `pnpm lint` exit 0、 `pnpm typecheck` exit 0。 review 経路通過後に commit `chore(next): C4 next.config.ts webpack block 削除 (Turbopack default) [reviewed]`。

### C5: pg / @types/pg 削除 (dead weight)

- **目的**: `import 'pg'` 0 件 (Step 0 §2.3.1)、 app runtime は postgres-js 単独、 drizzle-kit も pg 不要。 削除で install 時間 / lockfile 軽量化。
- **制約**:
  - `package.json` `dependencies` から `"pg": "^8.20.0"` 行を削除。
  - `package.json` `devDependencies` から `"@types/pg": "^8.20.0"` 行を削除。
  - `pnpm install` で lockfile 反映。
  - `lib/db/index.ts` (postgres-js 経由) / `drizzle.config.ts` は触らない。 `import 'server-only'` guard も維持。
- **完了条件**: `pnpm typecheck` / `pnpm build` / `pnpm test` 全 pass (型 / runtime エラーゼロ)。 `pnpm lint` exit 0。 commit `chore(deps): C5 pg / @types/pg 削除 (dead weight) [no-review]`。 使われてない dep の削除のみ、 [no-review] 可。

### C6: post-create.sh の pnpm install を corepack 化

- **目的**: `npm install -g pnpm` (version 未指定 = latest) は `packageManager: "pnpm@10.33.0"` declaration との drift リスク。 corepack 経由で SSoT 化 (matrix v1.3 §4 #6 積み残し消化)。
- **制約**:
  - `.devcontainer/post-create.sh:22-24` を以下に置換 (3 行 → 4 行):
    ```bash
    echo "==> [2/8] pnpm (via corepack、 packageManager field 準拠)"
    corepack enable
    corepack prepare pnpm@10.33.0 --activate
    pnpm config set store-dir ~/.local/share/pnpm-store
    ```
  - 他の `==> [3/8] Claude Code` 以降は触らない。
  - **commit body に明記**: 「本 commit 自身では効果検証不可。 検証は次回 devcontainer rebuild 時、 `pnpm -v` = `10.33.0` 一致を OT 確認」。
- **完了条件**: shell script syntax error なし (bash -n でパース可)、 `pnpm lint` 影響なし。 commit `chore(devcontainer): C6 post-create.sh の pnpm install を corepack 化 [no-review]`。 commit body に上記検証メモを含める。

---

## Sprint 完了 gate (C1-C6 累積後、 1 回実行)

matrix v1.3 §6 + spec §3.1 準拠。 コンテナ内で全 exit 0:

```bash
pnpm install --frozen-lockfile   # lockfile 固定確認 (GHA 不採用ゆえこれが frozen の代替)
pnpm lint                         # eslint . --max-warnings=0 (波2 gate)
pnpm typecheck                    # tsc --noEmit
pnpm build                        # Turbopack default。 切り分け時のみ next build --webpack
pnpm test                         # vitest run
```

加えて lockfile overrides 4 件 grep (spec §3.2):

```bash
grep -A 6 "^overrides:" pnpm-lock.yaml | head -7
# 期待: overrides: + react / react-dom / uuid / postcss の 4 行
```

完了報告 chat に「**whole-repo lint exit 0 確認済**」 を 1 行明記 (CLAUDE.md §「Sprint 完了 gate」)。 4 件揃わない場合は調査して fix、 揃わないまま sprint 完了報告しない。

## Smoke / deploy

spec §3.3 (stg smoke 8 項目)、 §3.4 (Vercel cache 無効初回 deploy)、 §4 (失敗縮退)、 §5 (deploy 後 OT rotate 手順) を参照。 plan からは詳細を割愛 (spec 側が正本)。

## Stop 条件 (sprint 内、 OT 確認待ち)

- C2 lint 新規違反検出 → C2 stop、 件数 + rule 別内訳報告
- smoke #1 (#8302 回帰) → 7.2.9 revert follow-up commit を sprint 内で作成、 再 smoke
- 上記以外で matrix v1.3 / spec と矛盾する判断要 → 即 stop して OT 確認
