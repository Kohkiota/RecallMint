# 波1 (Next 16 核) — design spec

date: 2026-06-11
scope: prod の 13 件 Next CVE (高 7 / 中 4 / 低 2、 Step 0 §2.1.2) を解消する Next 16 核 upgrade。 ESLint 9 gate (波2、 commit `edf3cab`) 完了済を前提に、 prod 稼働中の `next 15.5.15` を `16.2.9 exact` まで上げる + middleware → proxy 化 + 周辺整合。
正本: 依存マトリクス v1.3 (`docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md`、 commit `17ff88b`)
予備: 波1 Step 0 調査レポート (`docs/superpowers/sessions/2026-06-11-wave1-next16-step0-investigation.md`、 commit `db6a180`)

---

## 1. scope

### 1.1 含める (matrix v1.3 §3.1 + Step 0 §4)

- **核 bump** (exact pin、 caret 外す):
  - `next 16.2.9`、 `react 19.2.7`、 `react-dom 19.2.7`、 `@types/react 19.2.17`、 `@types/react-dom 19.2.3`、 `eslint-config-next 16.2.9`、 `@clerk/nextjs 7.4.3`、 `@types/node ^24.13.2`
- **構成**: `engines.node = "24.x"` 明示、 `packageManager = "pnpm@10.33.0"` 維持
- **runtime**: `middleware.ts` → `proxy.ts` rename + `config.matcher` に `/__clerk/(.*)` 追加
- **overrides**: `pnpm-workspace.yaml` に `react: 19.2.7` / `react-dom: 19.2.7` を**追加**。 既存の `uuid` / `postcss` 維持 = 計 **4 件**
- **config**: `next.config.ts` の `webpack: (config, { dev }) => {...}` block 削除
- **dead weight**: `pg` / `@types/pg` を `package.json` から削除
- **devcontainer**: `.devcontainer/post-create.sh:22-24` の `npm install -g pnpm` を corepack 化

### 1.2 含めない (本 sprint scope 外)

- secret rotate (deploy 後 OT 手順、 §5 で 1 行)
- transitive audit 残 24 件 (next bump 後の再 audit、 残存分は別 spec)
- `next/image` 化 (`upload-form.tsx:638` TODO、 別 sprint)
- TS6 migration / Stripe 22.2.0 / minor 群 (= 波3)

---

## 2. task = commit 分割 (6 commits、 変更源ごと)

順序 **C1 → C2 → C3 → C4 → C5 → C6** (C1 は C2 install の床、 C3-C6 は C2 後の独立 cleanup で順不同可)。 全 commit に commit tag を付与。

### C1. `chore(deps): pnpm-workspace.yaml overrides に react/react-dom 19.2.7 を追加 [no-review]`

- **目的**: C2 install で react peer 解決が割れない床を先行整備
- **変更**: `pnpm-workspace.yaml` `overrides:` セクションに `react: 19.2.7` と `react-dom: 19.2.7` の 2 行追加。 既存 `uuid` / `postcss` 維持 (計 4 件)
- **完了条件**: yaml syntax OK、 lefthook pre-commit pass、 ts/lint/build 影響なし
- **rollback**: 単 commit revert
- **note**: review なし可 (yaml 2 行追加、 実装ロジック変更なし、 CLAUDE.md §Review 例外)

### C2. `feat(deps): Next 16 + React 19.2 + Clerk 7.4.3 + Node 24 core bump [reviewed]`

- **目的**: prod CVE 13 件解消 + Next 16 LTS への移行 + Clerk proxy.ts 公式 base 整合
- **変更** (`package.json` exact pin、 codemod は使わず手で書く):
  - dependencies: `next 16.2.9` / `react 19.2.7` / `react-dom 19.2.7` / `@clerk/nextjs 7.4.3`
  - devDependencies: `@types/react 19.2.17` / `@types/react-dom 19.2.3` / `eslint-config-next 16.2.9` / `@types/node ^24.13.2` (24 系 caret は patch 追随、 §6.1 参照)
  - 新規 field: `"engines": { "node": "24.x" }` 追加
  - `packageManager = "pnpm@10.33.0"` 維持 (波2 SSoT)
- **install**: `pnpm install` (lockfile 更新)。 `--frozen-lockfile` は付けない (初回は lock 更新が必要)
- **完了条件**: install 完走、 lockfile `overrides:` セクションに 4 件 (`react / react-dom / uuid / postcss`) 全件存在を grep で確認、 `pnpm lint / typecheck / build / test` 全 pass
- **rollback**: 単 commit revert で全 bump 取消。 Clerk のみ問題なら follow-up commit で `@clerk/nextjs ^7.2.9` に戻す (§4 縮退)
- **review 経路**: `superpowers:requesting-code-review` skill (canonical)、 general-purpose subagent。 whole-repo `pnpm lint --max-warnings=0` 確認を checklist に含める

### C3. `feat(runtime): middleware.ts → proxy.ts 化 + matcher 拡張 [reviewed]`

- **目的**: Next 16 推奨 path への移行 (Node runtime 固定)、 Clerk proxy.ts 公式 matcher 整合
- **変更**:
  - `git mv middleware.ts proxy.ts` (file rename)
  - 内容: `export default clerkMiddleware(...)` はそのまま (codemod の rename 対象外形態のため手動不要、 Step 0 §1.2)
  - コメント: 「env prefix validation (side-effect, **Edge** runtime)」 → 「(side-effect, **Node** runtime)」、 「Phase 1 G-baseline-3 ... ` middleware.ts` の」 → 「`proxy.ts` の」 等の文言更新
  - `config.matcher` 配列の末尾に `/__clerk/(.*)` を追加 (matrix v1.3 §5 #8、 Clerk 7.4.3 公式 proxy.ts 例の matcher)
  - `lib/clerk.ts` 冒頭コメントの「Imported as a side-effect from middleware.ts (Edge runtime) and lib/auth/ensure-user.ts (Node runtime) for dual-runtime fail-fast」 を「Imported as a side-effect from proxy.ts (Node runtime) and lib/auth/ensure-user.ts (Node runtime) for fail-fast」 に書換 (Step 0 M-4)
  - `skipMiddlewareUrlNormalize` 系 config の rename 該当は **0 件** (Step 0 §1.6 G-6 grep 確認済) → 追加変更なし
- **完了条件**: ts/lint/build 全 pass、 dev で `/app` への未ログインアクセスが `/sign-in` に redirect される (= Clerk auth gate 連続性)
- **rollback**: 単 commit revert で middleware.ts に戻る
- **review 経路**: C2 と同じ canonical 経路

### C4. `chore(next): next.config.ts webpack block 削除 (Turbopack default) [reviewed]`

- **目的**: Next 16 で Turbopack が default、 webpack 設定があると build fail / 警告が出るリスク。 dev watch ignored は Turbopack default で不要 (Step 0 §1.6 G-5)
- **変更**: `next.config.ts` の `webpack: (config, { dev }) => { if (dev) { config.watchOptions = { ... ignored: [...] } } return config }` block を丸ごと削除。 上の `securityHeaders` / `async headers()` 部は維持
- **完了条件**: `pnpm build` が Turbopack default で完走、 dev も起動可
- **rollback**: 単 commit revert
- **review 経路**: 軽微だが build 経路に影響するため canonical review

### C5. `chore(deps): pg / @types/pg 削除 (dead weight) [no-review]`

- **目的**: `import 'pg'` 0 件 (Step 0 §2.3.1)、 app runtime は postgres-js 単独、 drizzle-kit も pg 不要。 削除で bundle / install 時間を縮小
- **変更**:
  - `package.json` `dependencies` から `"pg": "^8.20.0"` 削除
  - `package.json` `devDependencies` から `"@types/pg": "^8.20.0"` 削除
  - `pnpm install` で lockfile 反映
- **完了条件**: `pnpm typecheck` / `pnpm build` / `pnpm test` 全 pass (型エラー / runtime エラーが出ないこと)
- **rollback**: 単 commit revert
- **note**: 実装ロジック変更なし (使われてない dep を消すだけ)、 [no-review] 可

### C6. `chore(devcontainer): post-create.sh の pnpm install を corepack 化 [no-review]`

- **目的**: `npm install -g pnpm` は latest を taking → `packageManager = "pnpm@10.33.0"` declaration と version drift リスク。 corepack で SSoT 化
- **変更**: `.devcontainer/post-create.sh:22-24` を以下に置換:
  ```bash
  echo "==> [2/8] pnpm (via corepack、 packageManager field 準拠)"
  corepack enable
  corepack prepare pnpm@10.33.0 --activate
  pnpm config set store-dir ~/.local/share/pnpm-store
  ```
- **完了条件**: 本 commit 自身では効果検証不可 (現コンテナは既に pnpm 10.33.0 稼働中)
- **commit body 明記**: 「**検証は次回 devcontainer rebuild 時、 `pnpm -v` = `10.33.0` 一致を OT 確認**」
- **rollback**: 単 commit revert
- **note**: shell script 修正のみ、 [no-review] 可

---

## 3. 完了条件 (sprint 完了 gate + stg smoke)

### 3.1 コンテナ内 gate (matrix v1.3 §6、 C1-C6 累積後に 1 回)

```bash
pnpm install --frozen-lockfile   # lockfile が固まっていることを再確認
pnpm lint                         # eslint . --max-warnings=0 (波2 gate)
pnpm typecheck                    # tsc --noEmit
pnpm build                        # Turbopack default、 切り分け時のみ next build --webpack
pnpm test
```

### 3.2 lockfile overrides 検査 (overrides clobber 検知、 Step 0 §1.5)

`pnpm-lock.yaml` の `overrides:` セクションに **4 件全件存在**を grep で確認:

```bash
grep -A 6 "^overrides:" pnpm-lock.yaml | head -7
# 期待出力:
# overrides:
#   react: 19.2.7
#   react-dom: 19.2.7
#   uuid: ^14.0.0
#   postcss: ^8.5.10
```

4 件揃わない場合は C2 install 過程で何かが clobber している → 調査して fix。

### 3.3 stg smoke (matrix v1.3 §5、 OT 実行)

1. **[筆頭] 未ログインで保護ルート直アクセス** (`/app`, `/app/exams/{id}`, `/api/review-events/bulk`) → **sign-in に飛ぶ** (現 URL に留まらない = Clerk #8302 回帰確認)
2. ログイン後 `/app` 表示 / カード編集 / **タグ並べ替え** (dnd-kit が Next 16 で動くか)
3. 5問回答 → **bulk flush** (`/api/entity-mutations/bulk` 同期)
4. Stripe **plan 変更 / downgrade** (波3 で Stripe bump 時は再実行)
5. **OCR upload** (画像 → Gemini → カード生成)
6. **R2 画像表示** ※ matrix v1.3 §5 #6 は `next/image` 経路だが、 RecallMint は**現行 `<img>` 経路** (Step 0 G-4)。 本 sprint では「現行 img 経路で R2 画像が引き続き表示される」 を確認。 `next/image` 化は scope 外
7. **`?_rsc` prefetch 数の再計測** (Resource Timing): Next 16 後も dynamic Link 並列爆発が再発しない (`prefetch={false}` 維持)
8. **matcher 確認** ※ C3 で**設計判断として既に proxy.ts に反映済**。 smoke 時は `config.matcher` に `/(api|trpc)(.*)` と `/__clerk/(.*)` が存在することを目視 + 動作確認。 `skipMiddlewareUrlNormalize` rename は本 repo 0 件 (Step 0 §1.6 G-6 grep 確認済) のため smoke 対象外

### 3.4 deploy 操作

- **初回 stg deploy** = Vercel build cache 無効で 1 回 (matrix v1.3 §2)。 OT 操作
- **Stripe webhook smoke** = OT 課金実機 (CLAUDE.md OT 規律)
- **Vercel Project Settings の Node version = 24.x** を deploy 前に OT 確認 (matrix v1.3 §4 OT 確認)

---

## 4. 失敗基準 / 縮退方針 (matrix v1.3 §5 末尾)

### 4.1 失敗 = 即縮退

(a) `pnpm install` peer 警告解消不能 / (b) `auth.protect()` が未ログインを通す (smoke #1 fail) / (c) `pnpm build` (Turbopack) で client/server import 境界エラー / (d) Stripe webhook smoke 落ち

### 4.2 縮退手段

- **Clerk 7.4.3 起因 smoke #1 失敗** (= #8302 回帰): C2 内の `@clerk/nextjs` のみ `^7.2.9` へ revert する follow-up commit (`revert(deps): @clerk/nextjs を 7.2.9 に戻す [reviewed]`)、 stg 再 smoke。 Next 16 自体は 7.2.9 でも動作 (Step 0 §1.3.2 lock 確認済)
- **Turbopack 起因 build 失敗 (c)**: `pnpm build --webpack` を**一時許可**で切り分け (恒久回避にしない、 matrix v1.3 §5 末尾)
- **大域失敗**: C1-C6 を順次 revert で develop 戻し、 別 spec で部分再着手

---

## 5. deploy 後 OT 手順 (CC は触れない)

prod deploy で CVE 13 件解消後、 OT が以下を順次:
- **P0**: Clerk session 系 (`CLERK_SECRET_KEY` rotate + Clerk Dashboard で全 active session 強制 sign-out)
- P1-P3: 後続 sprint で別議論 (Step 0 §2.1.4 順位順、 Stripe Webhook signing / Gemini API key / DATABASE_URL)

---

## 6. design 判断記録

### 6.1 overrides を 4 件に絞る判断 (確定判断 B の本意)

- 確定判断 B の本意 = **SSoT を `pnpm-workspace.yaml` に 1 本化** であって codemod 出力の全移植ではない
- codemod が `package.json` `pnpm.overrides` に追加する `@types/react` / `@types/react-dom` は移植しない。 理由:
  - C2 で `@types/react` `19.2.17` / `@types/react-dom` `19.2.3` を **exact pin** で書くため、 transitive 経由の peer drift は package.json の exact pin 自身で実質防げる
  - overrides は最終手段 (lockfile 全域に効く強制) ゆえ必要最小限に抑える
  - 万一 C2 install 後の `pnpm-lock.yaml` diff で `@types/react*` の重複 resolve が見えた場合のみ、 follow-up commit で workspace.yaml に追加検討

### 6.2 codemod を C2 で使わない判断

- Step 0 dry-run で codemod のソース変換は 0 件、 package.json 書換のみと判明
- codemod が package.json に追加する `pnpm.overrides` block は workspace.yaml 集約方針と衝突 → 手で正確 pin を書く方が safer + diff が読める
- codemod 自身は Step 0 で「自動変換ゼロ確認」 の役割を終えた、 本 sprint では再走させない

### 6.3 `@types/node` のみ caret pin 維持

- 他 core dep は exact だが `@types/node ^24.13.2` のみ caret。 理由 = Node 24 LTS は patch line で型修正が継続、 24.x patch は SemVer 範囲内で追随した方が型 drift が起きにくい (matrix v1.3 §3.1 `[exact*]` 表記の意図に整合)

### 6.4 `/__clerk/(.*)` matcher 追加の根拠

- Clerk 7.4.3 公式 proxy.ts 例の matcher に含まれる (matrix v1.3 §5 #8)
- 未追加だと Clerk 内部の OAuth callback / SSO 経路で 404 になり得る (Clerk docs `clerk-middleware.mdx`)
- C3 で proxy 化と同時に追加 = rename と matcher の整合を 1 commit で完結

---

## 7. 進め方

- 本 spec 完成 → chat に要点要約 (commit 構成 / 順序 / 完了 gate / smoke) → OT 承認待ち
- OT 承認後、 `superpowers:writing-plans` skill で実装 plan に展開
- 実装は CLAUDE.md §「実装方式 (既定)」 に従い `superpowers:subagent-driven-development` で task 単位の fresh subagent + task 間 review
