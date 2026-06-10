# 依存ターゲット版マトリクス (Step 0 確定調査)

date: 2026-06-10
scope: 調査のみ (実装・commit なし)。 Next 16 移行 + 今後 sprint 見据えて全依存の「最も安定するターゲット版」 を 1 枚に確定。 出力は claude.ai レビュー → OT + 他 AI cross-check 用。

source of truth:
- 版番号: `pnpm info <pkg> version` / `pnpm info <pkg> peerDependencies` (registry 直)
- 移行/挙動: Context7 (`/vercel/next.js/v16.2.2`, `/facebook/react/v19_2_0`, `/clerk/clerk-docs`)
- pin: package.json + pnpm-lock.yaml

---

## 0. TL;DR

- **claude.ai 固定制約 6 件のうち 4 件が registry 真値と矛盾**: (i) ESLint 9.x → **ESLint 10.x が現行**、 (ii) TypeScript ≥5.1 → **6.0.3 が現行 & 既に install 済**、 (iii) zod v3 → **既に v4.4.x install 済**、 (iv) Node 22 LTS → **Node 24 が 2025-10 から新 LTS** (devcontainer も v24.13.0)。 詳細 red flag §6。
- **整合制約 2 件は事実通り**: (v) @dnd-kit legacy 線 (6.3.1/10.0.0/3.2.2 全て installed と registry 最新が一致)、 (vi) React Compiler OFF (next.config.ts に reactCompiler:true 不在)。
- **TanStack v8 / react-virtual / babel-plugin-react-compiler はそもそも未 install**。 将来追加時の制約として記憶のみ、 マトリクスには含めない。
- **Next 16 + React 19.2 + Clerk 7.x の互換 OK**: 現 install `@clerk/nextjs@7.2.9` の peer に既に `next: ^16.0.10 || ^16.1.0-0` あり (= Clerk 上げなくても Next 16 移行可能)。 最新 7.4.3 で更に安全。

---

## 1. 全依存マトリクス (直接 dep / devDep)

凡例: 「installed」 = `pnpm-lock.yaml` の実 resolve 版、 「latest」 = `pnpm info` 結果、 「target pin」 = 本調査が提案する `^X.Y.Z`。 種別 D=`dependencies`、 V=`devDependencies`、 T=transitive。

### 1.1 dependencies (実 runtime)

| # | パッケージ | 現状 pin | installed | latest stable | target pin | 種別 | peer 互換メモ | 備考 / red flag |
|---|---|---|---|---|---|---|---|---|
| 1 | next | ^15.5.15 | 15.5.x | 16.2.9 | **^16.2.9** | D | react ^18.2 \|\| ^19.0 / sass optional / babel-plugin-react-compiler `*` (使用時のみ) | Next 16 移行対象 (codemod 1 発) |
| 2 | react | ^19.2.5 | 19.2.5 | **19.2.7** | **^19.2.7** | D | — | 2 patch 遅延 (4/8 → 6/1)、 19.2.x は RSC fix 継続中、 bump 推奨 |
| 3 | react-dom | ^19.2.5 | 19.2.5 | **19.2.7** | **^19.2.7** | D | react ^19.2.7 (= 同 patch pair 必須) | react と必ず同 version 合わせ |
| 4 | @clerk/nextjs | ^7.2.4 | **7.2.9** | 7.4.3 | **^7.4.3** | D | next 7.2.9 peer = `^15.2.8 \|\| … \|\| ^16.0.10 \|\| ^16.1.0-0` → **7.2.9 でも Next 16 OK**。 react ^18 \|\| ~19.0.3 \|\| ~19.1.4 \|\| **~19.2.3** \|\| ~19.3.0-0 | 上げなくても動くが、 7.4.3 が公式 Next 16 + proxy.ts 公式例の base |
| 5 | @google/genai | ^1.50.1 | 1.50.x | 2.8.0 | **^1.50.1 維持** | D | optional @modelcontextprotocol/sdk ^1.25.2 | 1.x → 2.x は major、 別議論 (red flag §6.6) |
| 6 | stripe | ^22.0.2 | 22.0.x | 22.2.0 | **^22.2.0** | D | @types/node >=18 (= 24 LTS で OK) | minor bump |
| 7 | svix | ^1.91.1 | 1.91.x | 1.95.2 | **^1.95.2** | D | — | minor bump |
| 8 | zod | ^4.4.1 | 4.4.x | 4.4.3 | **^4.4.3** | D | — | **既に v4**、 patch のみ。 claude.ai の「v3 か」 想定は誤り (red flag §6.3) |
| 9 | drizzle-orm | ^0.45.2 | 0.45.2 | 0.45.2 | **^0.45.2** | D | optional: @neondatabase/serverless, @libsql/client-wasm, @planetscale/database 等 | 最新、 pg + postgres-js driver 採用済 |
| 10 | pg | ^8.20.0 | 8.20.x | 8.21.0 | **^8.21.0** | D | optional pg-native >=3.0.1 | minor bump (pg-native は未使用) |
| 11 | postgres (postgres-js) | ^3.4.9 | 3.4.9 | 3.4.9 | **^3.4.9** | D | — | 最新、 Date serialization は 3.4.x で安定 (3.0-3.3 系 bug は対象外) |
| 12 | dexie | ^4.4.2 | 4.4.x | 4.4.3 | **^4.4.3** | D | — | patch bump |
| 13 | dexie-react-hooks | ^4.4.0 | 4.4.0 | 4.4.0 | **^4.4.0** | D | dexie `>=4.2.0-alpha.1 <5.0.0` / react `>=16` | 最新 |
| 14 | ts-fsrs | ^5.3.2 | 5.3.x | 5.4.1 | **^5.4.1** | D | — | minor bump |
| 15 | @dnd-kit/core | ^6.3.1 | 6.3.1 | 6.3.1 | **^6.3.1** | D | react/react-dom >=16.8 | legacy 線最新 (制約合致) |
| 16 | @dnd-kit/sortable | ^10.0.0 | 10.0.0 | 10.0.0 | **^10.0.0** | D | @dnd-kit/core ^6.3.0 / react >=16.8 | 同上 |
| 17 | @dnd-kit/utilities | ^3.2.2 | 3.2.2 | 3.2.2 | **^3.2.2** | D | react >=16.8 | 同上 |
| 18 | radix-ui | ^1.4.3 | 1.4.3 | 1.5.0 | **^1.5.0** | D | react ^16.8 \|\| … \|\| ^19.0 (^19.0.0-rc 含む) | minor bump |
| 19 | lucide-react | ^1.14.0 | 1.14.x | 1.17.0 | **^1.17.0** | D | react ^16.5 \|\| … \|\| ^19.0 | minor bump |
| 20 | class-variance-authority | ^0.7.1 | 0.7.1 | 0.7.1 | **^0.7.1** | D | — | 最新 |
| 21 | clsx | ^2.1.1 | 2.1.1 | 2.1.1 | **^2.1.1** | D | — | 最新 |
| 22 | tailwind-merge | ^3.5.0 | 3.5.x | 3.6.0 | **^3.6.0** | D | — | minor bump |
| 23 | tw-animate-css | ^1.4.0 | 1.4.0 | 1.4.0 | **^1.4.0** | D | — | 最新 |
| 24 | browser-image-compression | ^2.0.2 | 2.0.2 | 2.0.2 | **^2.0.2** | D | — | 最新 |
| 25 | server-only | ^0.0.1 | 0.0.1 | 0.0.1 | **^0.0.1** | D | — | Next 公式 helper、 最新 |
| 26 | shadcn | ^4.6.0 | 4.6.x | 4.11.0 | **^4.11.0** | D | — | CLI ツール、 runtime 影響なし (components 追加用)。 dep ではなく devDep が本来 |
| 27 | bufferutil | ^4.1.0 | 4.1.0 | 4.1.0 | **^4.1.0** | D | — | 最新 (ws optional speedup) |
| 28 | utf-8-validate | ^6.0.6 | 6.0.6 | 6.0.6 | **^6.0.6** | D | — | 同上 |

### 1.2 devDependencies (build / test / lint tooling)

| # | パッケージ | 現状 pin | installed | latest stable | target pin | 種別 | peer 互換メモ | 備考 / red flag |
|---|---|---|---|---|---|---|---|---|
| 29 | typescript | ^6.0.3 | 6.0.3 | 6.0.3 | **^6.0.3** | V | — | **既に最新 (TS 6 系)**。 claude.ai の「TS ≥5.1」 制約は stale (red flag §6.2) |
| 30 | eslint | ^9.39.4 | 9.39.4 | 10.4.1 | **^9.39.4 維持** (claude.ai 制約優先) / **^10.4.1 ⇄ 再検討** | V | eslint-config-next / eslint-plugin-react-hooks どちらも `>=9.0.0 \|\| ^10.0.0` を peer に含む | claude.ai「eslint = 9.x」 制約は最新 major 10 を除外 → 再決定 (red flag §6.1) |
| 31 | eslint-config-next | ^16.2.4 | 16.2.9 | 16.2.9 | **^16.2.9** | V | eslint >=9.0.0 / typescript >=3.3.1 | next と同 major、 OK |
| 32 | (transitive) eslint-plugin-react-hooks | — | 7.1.1 | 7.1.1 | T (eslint-config-next 経由 install 済) | T | eslint `^9.0.0 \|\| ^10.0.0` | T3 hook order 検出 + useEffectEvent lint の plugin、 既に install 済で「flat config 書けば即動く」 |
| 33 | (transitive) @next/eslint-plugin-next | — | 16.2.4 → bump で 16.2.9 | 16.2.9 | T (同上) | T | — | eslint-config-next 配下、 next と同期 |
| 34 | drizzle-kit | ^0.31.10 | 0.31.10 | 0.31.10 | **^0.31.10** | V | — | 最新 |
| 35 | vitest | ^4.1.5 | 4.1.5 | 4.1.8 | **^4.1.8** | V | optional: @vitest/coverage-v8 = **4.1.8 exact** + browser variants | minor bump、 coverage と版同期必須 |
| 36 | @vitest/coverage-v8 | ^4.1.5 | 4.1.5 | 4.1.8 | **^4.1.8** | V | vitest 4.1.8 exact / @vitest/browser 4.1.8 (使用時) | vitest と pair upgrade |
| 37 | @vitejs/plugin-react | ^6.0.1 | 6.0.1 | 6.0.2 | **^6.0.2** | V | **vite ^8.0.0** / @rolldown/plugin-babel optional / babel-plugin-react-compiler optional | vitest 4 内蔵 vite 8 と整合 (red flag §6.7) |
| 38 | @tailwindcss/postcss | ^4.2.4 | 4.2.x | 4.3.0 | **^4.3.0** | V | — | minor bump、 tailwindcss と版同期 |
| 39 | tailwindcss | ^4.2.4 | 4.2.x | 4.3.0 | **^4.3.0** | V | — | 同上 |
| 40 | @testing-library/jest-dom | ^6.9.1 | 6.9.1 | 6.9.1 | **^6.9.1** | V | — | 最新 |
| 41 | @testing-library/react | ^16.3.2 | 16.3.2 | 16.3.2 | **^16.3.2** | V | @testing-library/dom ^10 / react ^18 \|\| ^19 | 最新 |
| 42 | tsx | ^4.21.0 | 4.21.x | 4.22.4 | **^4.22.4** | V | — | minor bump |
| 43 | jsdom | ^29.1.1 | 29.1.1 | 29.1.1 | **^29.1.1** | V | optional canvas ^3.0.0 | 最新 |
| 44 | fake-indexeddb | ^6.2.5 | 6.2.5 | 6.2.5 | **^6.2.5** | V | — | 最新 |
| 45 | dotenv | ^17.4.2 | 17.4.2 | 17.4.2 | **^17.4.2** | V | — | 最新 |
| 46 | @types/node | ^25.6.0 | 25.6.x | 25.9.2 | **^24.7.0 推奨** ⇄ (Node 24 LTS と整合) | V | — | 現 25 = Node 25 (current/odd)、 Node 24 LTS と乖離。 dt 25.x は機能差 OK だが整合のため 24 推奨 (red flag §6.4) |
| 47 | @types/pg | ^8.20.0 | 8.20.0 | 8.20.0 | **^8.20.0** | V | — | 最新 |
| 48 | @types/react | ^19.2.14 | 19.2.14 | 19.2.17 | **^19.2.17** | V | — | patch bump |
| 49 | @types/react-dom | ^19.2.3 | 19.2.3 | 19.2.3 | **^19.2.3** | V | @types/react ^19.2.0 | 最新 |

### 1.3 transitive (lockfile から拾った主要分)

| パッケージ | installed | 経路 | 備考 |
|---|---|---|---|
| @dnd-kit/accessibility | 3.1.1 | @dnd-kit/core 6.3.1 | core 経由 transitive、 直接 install 不要 |
| @clerk/backend | 3.4.3 | @clerk/nextjs 7.2.9 | Node runtime auth 内部 |
| @clerk/react | 6.4.7 | @clerk/nextjs 7.2.9 | client hooks 内部 |
| @clerk/shared | 4.8.7 | @clerk/nextjs 7.2.9 | 共通 utils |
| @radix-ui/react-* (40+ primitives) | 1.1.x / 1.2.x / 1.3.x | radix-ui 1.4.3 → bump で 1.5.0 | radix-ui umbrella 経由、 個別 install なし |
| @next/eslint-plugin-next | 16.2.4 | eslint-config-next | next の codemod 後 16.2.9 に追従 |
| eslint-plugin-react-hooks | 7.1.1 | eslint-config-next | 上記 1.2 #32 と同 |

### 1.4 pnpm-workspace.yaml overrides (固定)

```yaml
overrides:
  uuid: ^14.0.0
  postcss: ^8.5.10
```

- `uuid ^14.0.0`: 何かの transitive を pin している。 root の dependencies に uuid 直接記載なし (= 推移依存の overrides)。 14 は最新 major で問題なし。
- `postcss ^8.5.10`: tailwindcss 4 + Next 系の build を pin。 8.5.x が現行で OK (postcss 9 は未 release)。

### 1.5 future addition candidates (未 install、 制約のみ記憶)

| パッケージ | 制約 (claude.ai) | 補足 |
|---|---|---|
| @tanstack/react-table | v8 安定線 | 未 install。 追加時 v8 系 (v9 alpha は不採用) |
| @tanstack/react-virtual | v8 と組む現行安定 | 未 install。 同上 |
| babel-plugin-react-compiler | React Compiler OFF 維持 | next.config.ts に reactCompiler:true なし → 不要 (= 入れない) |
| eslint-plugin-react-hooks (direct) | latest (= 7.1.1) | eslint-config-next 経由で transitive install 済、 direct devDep にする必要は flat config 設計次第 |
| lefthook | 2.1.9 (最新 stable) | 新 devDep、 pre-commit hook 用 (claude.ai 推奨) |
| husky | 9.1.7 | lefthook の代替案、 lint-staged 17.0.7 と pair |

---

## 2. 特殊ケース 4 件の判定結果

### 2.1 @clerk/nextjs

- **install 中 `7.2.9` で既に Next 16 公式対応**: peer に `next: ^16.0.10 || ^16.1.0-0` 含む (実 `pnpm info @clerk/nextjs@7.2.9 peerDependencies` で確認)
- proxy.ts 公式サンプル: Clerk docs (`docs/reference/nextjs/clerk-middleware.mdx`) で `clerkMiddleware()` を `proxy.ts` に置く例あり。 matcher は `/__clerk/(.*)` 追加が新形 (現 middleware.ts に未含み、 OT 判断)
- **runtime**: proxy.ts は **Node 固定** (edge 非サポート)。 Clerk の `clerkMiddleware()` は Node でも問題なし。 latency 影響は Vercel hnd1 region で軽微 (= cold start 微増は実害ほぼなし、 auth gate のみで perf critical でない)
- 推奨 pin: **`^7.4.3`** (= Next 16 + proxy.ts 公式 base)。 ただし**現 7.2.9 のままでも Next 16 動作する**ため、 「Clerk 上げ」 と「Next 16 化」 を別 commit に分離可能。 順序自由。

### 2.2 zod

- **既に v4** (`^4.4.1` pin → installed 4.4.x → latest 4.4.3): claude.ai の「現状 v3 か」 想定は **誤り**
- v3 → v4 migration は **完了済**、 現状 v4 patch level での維持で十分
- drizzle-zod など peer 連携 dep は **未 install** (lockfile に痕跡なし、 `grep "drizzle-zod"` 0 件) → peer 衝突なし
- 推奨 pin: **`^4.4.3`** (patch のみ bump、 sync-fix-1 の schema 追加で v4 API のまま継続)

### 2.3 Gemini SDK

- **既に新 SDK** (`@google/genai ^1.50.1`、 旧 `@google/generative-ai` は未 install): grep で SDK consumer は `lib/ai/clients/gemini.ts` の 1 ファイルのみ (`import { GoogleGenAI } from '@google/genai'`)、 test は `lib/ai/clients/gemini.test.ts` で mock
- 旧 → 新 SDK 移行は **完了済**
- 1.x → 2.x は **major bump** (registry latest 2.8.0)。 1 ファイル + 1 test 範囲だが SDK 内部 API (ApiError class / GenerateContentConfig 等) の変更可能性あり
- 推奨 pin: **`^1.50.1` 維持** (Step 0 では 1.x のままを target)。 2.x は別 spec で OT 判断 (red flag §6.6)

### 2.4 eslint-plugin-react-hooks

- **install 済** (eslint-config-next 16.2.9 → eslint-plugin-react-hooks 7.1.1 transitive)
- React 19.2 の `useEffectEvent` lint 対応版は 7.0+ から、 7.1.1 = 最新
- peer: `eslint: '^3.0.0 || … || ^9.0.0 || ^10.0.0'` (= ESLint 9 / 10 両対応)
- 推奨: direct devDep 化 (`^7.1.1`) するかは flat config 設計次第。 eslint-config-next 経由 transitive のままでも `eslint.config.mjs` で `import reactHooks from 'eslint-plugin-react-hooks'` できる (pnpm の peer resolution が transitive 直接 import を許容する設定なら)。 厳密には direct devDep 化が安全 (= deps drift で外れる事故回避)

### 2.5 postgres (postgres-js)

- **install 済の `^3.4.9` が latest**: registry 確認で 3.4.9 が最新 stable (Date serialization 関連の修正は 3.4.x で stabilized、 3.3.x 以前にあった bigint/Date round-trip bug は無関係)
- 推奨 pin: **`^3.4.9`** (現状維持)

### 2.6 lefthook (新規候補)

- 最新 stable: **2.1.9** (`pnpm info lefthook version`)
- 新 devDep として install: `pnpm add -D lefthook` (binary は npm が install 時に download)
- 単一設定ファイル `lefthook.yml` で pre-commit / pre-push を定義
- husky 9.1.7 + lint-staged 17.0.7 の代替案あり (claude.ai 推奨は lefthook)
- 推奨: ESLint CI gate sprint で lefthook ^2.1.9 を devDep 追加 + lefthook.yml を新設 (CI gate と二段構え用)

---

## 3. Node / TypeScript 確定

### 3.1 Node

| 項目 | 値 |
|---|---|
| devcontainer base image | `mcr.microsoft.com/playwright:v1.58.2` |
| **devcontainer 実行 Node** | **v24.13.0** (`node --version` で確認) |
| package.json `engines` field | **不在** (空) |
| vercel.json `runtime` | **不在** (Vercel default 任せ) |
| 2026-06 時点の Node LTS | **Node 24** (2025-10〜、 active LTS)、 Node 22 は maintenance LTS |
| Next 16 minimum Node | (Next docs より) Node ≥20.9 |

**推奨**:
- **Node 24 LTS に統一**: devcontainer は既に Node 24、 Vercel もデフォルトで Node 24 系を選択する想定 (2026-06 時点)
- package.json に `engines.node = ">=22.0.0"` を**明示**追加 (Vercel build / pnpm install の guard)
- claude.ai の「Node 22 (≥20.9)」 制約は **stale**: 22 は maintenance LTS、 24 が active LTS に移行済

### 3.2 TypeScript

| 項目 | 値 |
|---|---|
| 現 pin | `^6.0.3` |
| installed | 6.0.3 |
| latest stable | **6.0.3** |
| claude.ai 制約 | 「TypeScript 5.x」 |

**推奨**:
- **既に最新 6.0.3、 上げ作業不要**
- claude.ai の「TS 5.x」 制約は **stale**: TS 6 が現行 major で、 repo は既に TS 6 で運用中 (`tsconfig.tsbuildinfo` も TS 6 生成物)
- eslint-config-next 16.2.9 peer は `typescript: >=3.3.1` で TS 6 を許容、 drizzle-orm / vitest / Next / Clerk いずれも TS 6 と peer 衝突なし

---

## 4. 集約推奨 (sprint 順)

1. **Next 16 + ESLint CI gate 同 sprint** (前 Step 0 報告通り):
   - next ^16.2.9 / eslint-config-next ^16.2.9 / @clerk/nextjs ^7.4.3
   - react ^19.2.7 / react-dom ^19.2.7
   - eslint **^10.4.1 または ^9.39.4 維持** (red flag §6.1 の判断待ち)
   - lefthook ^2.1.9 (新 devDep) + eslint.config.mjs (新 file) + .github/workflows/ci.yml (新 file)
   - package.json `engines.node = ">=22.0.0"` (明示)、 `"lint": "eslint ."` (codemod 経由)
2. **patch / minor の細い bump** (Next 16 sprint と分離可、 chore 1 commit):
   - stripe ^22.2.0、 svix ^1.95.2、 radix-ui ^1.5.0、 lucide-react ^1.17.0、 tailwind-merge ^3.6.0、 ts-fsrs ^5.4.1、 pg ^8.21.0、 dexie ^4.4.3、 tsx ^4.22.4、 vitest ^4.1.8 / @vitest/coverage-v8 ^4.1.8 (pair)、 tailwindcss ^4.3.0 / @tailwindcss/postcss ^4.3.0、 @types/react ^19.2.17、 @types/node ^24.7.x (Node LTS 整合)
3. **将来 sprint (Tag-color 完了後)**:
   - @google/genai 1.x → 2.x の major upgrade スコープ判断 (lib/ai/clients/gemini.ts touch、 red flag §6.6)
   - eslint-plugin-react-hooks の direct devDep 化判断 (現状 transitive)

---

## 5. red flag 一覧

| # | level | 内容 |
|---|---|---|
| 6.1 | **高** | claude.ai 制約「eslint = 9.x」 は stale。 ESLint 10 が現行 major (10.4.1)、 eslint-config-next 16.2.9 / eslint-plugin-react-hooks 7.1.1 共に peer に `^10` 含む。 ESLint 9 維持か 10 へ昇格かの判断は **flat config の安定度** (10 は flat 専用) と **Vitest / Drizzle / Next 内部 linter usage との衝突有無**を確認の上で OT decide |
| 6.2 | **高** | claude.ai 制約「TypeScript 5.x」 は stale。 TS 6 が現行で repo は既に TS 6.0.3 install 済 (= 制約の前提が壊れている)。 制約を「TS ≥6.0」 に上書き要 |
| 6.3 | **高** | claude.ai 想定「zod は v3 か」 は誤り。 既に zod ^4.4.1 install 済 (10 file で usage)。 v3 → v4 migration スコープは不要、 v4 patch のみで進める |
| 6.4 | 中 | claude.ai 制約「Node 22 (≥20.9)」 は stale。 2025-10 から Node 24 が active LTS、 devcontainer も v24.13.0。 「Node 24 LTS」 に上書き推奨。 @types/node ^25 を ^24 に落とすかは整合判断 |
| 6.5 | 中 | @clerk/nextjs 現 install 7.2.9 で既に Next 16 peer 対応済 = **Clerk 上げ不要で Next 16 化可能**。 ただし 7.4.3 が公式 proxy.ts 例の base = upgrade 推奨。 「上げる/上げない」 を OT decide |
| 6.6 | 中 | @google/genai 1.50.1 → 2.x は major bump (lib/ai/clients/gemini.ts 1 file 範囲だが SDK 内部 API 変更可能性)。 Step 0 では 1.x 維持を target、 2.x 評価は別 spec |
| 6.7 | 低 | @vitejs/plugin-react 6.0.2 peer = `vite: ^8.0.0`。 vitest 4.1.8 が内部で vite 8 を持つ前提なら OK。 別途 vite を direct 入れていないため衝突は確認 (lockfile resolve 結果を 1 発確認推奨) |
| 6.8 | 低 | shadcn (^4.6.0 → 4.11.0) は CLI ツール、 runtime 影響なし。 dependencies ではなく devDependencies が本来 (将来整理可、 今回は触らない) |
| — | なし | CVE / セキュリティ: registry 公開の未 patch 脆弱性は本調査範囲では確認なし (= 「ある」 とも「ない」 とも未裏取り)。 必要なら `pnpm audit` を別途実施 |

---

## 6. 次の判断材料

1. ESLint 9 維持か 10 昇格か (red flag §6.1) — flat config の安定度 + 他 dep 衝突有無
2. Node 22 → 24 LTS 上書き是非 (red flag §6.4) — @types/node を ^25 → ^24 に落とすかと同時判断
3. @clerk/nextjs 7.2.9 維持 vs 7.4.3 へ bump (red flag §6.5) — Next 16 化と同 sprint か分離か
4. @google/genai 1.x → 2.x major upgrade スコープ (red flag §6.6) — 別 spec 起草要否
