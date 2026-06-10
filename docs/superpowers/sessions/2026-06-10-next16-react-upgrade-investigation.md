# Next 15 → 16 アップグレード + React バージョン現状調査

date: 2026-06-10
scope: 調査のみ (実装・commit なし)。 (1) 過去の IDB ローカルファースト化で引っ掛かった Next 機能を実 doc/code で特定、 (2) Next 16 への上げ労力見積もり、 (3) React 19.2.5 が現状 latest かを確認。
result:
- 過去引っ掛かり = `<Link>` default `prefetch={true}` + `experimental.staleTimes.dynamic` の 2 系統。 どちらも IDB local-first 方向への倒し込みで解消済 (撤回も含む)。
- Next 16 上げ労力 = **0.5〜1 dev day**。 codemod 1 発で大半自動、 手作業は `middleware.ts → proxy.ts` の design judgment と Vercel smoke のみ。 ESLint CI gate 設置 (別 Step 0 で発覚) と **同 sprint 推奨** (`next lint` 削除対応が両方の前提)。
- React = **上げ不要**。 `react ^19.2.5` は Context7 documented 最新 19.2.1 (2025-12-03) より新しい patch、 既に current。

---

## 1. 過去 IDB ローカルファースト化で引っ掛かった Next 機能

### 1.1 `<Link>` default `prefetch={true}` による server 負荷増幅 (S-perf-1)

**lesson**: `docs/superpowers/lessons/2026-05-25-link-prefetch-amplifies-server-load.md`
**session**: `docs/superpowers/sessions/2026-05-25-stg-perf-rsc-prefetch-amplification.md`

**症状**: stg navigation 1 回ごとに `?_rsc=…` GET が **5〜9 並列**で server に飛び、 各 page を full SSR して RSC payload を返却 (TTFB 400-650ms、 cold 1000-2000ms)。 dashboard 体感遅延の主因は dashboard 自身ではなく **header 5 link の prefetch 並列**。

**原因**: `<Link>` default `prefetch={true}` × Clerk middleware 経由で全 page dynamic 化 → prefetch 1 件あたり「`auth()` + `users` SELECT + page 固有 DB query」 一式が server で並列発火。

**対処**: 全 dynamic page Link に `prefetch={false}` 配備 (commit `a261f8e chore(perf): (app) dynamic page への Link 7 箇所に prefetch={false} 追加`)。 invariant 化 (`docs/superpowers/sessions/2026-05-27-prefetch-leak-audit.md`)。 既存コード現状 (`grep "staleTimes\|prefetch="` で確認) は維持済。

### 1.2 `experimental.staleTimes.dynamic` 試行と撤回 (S-cache-2b)

**session**: `docs/superpowers/sessions/2026-05-25-s-cache-2b-staletimes-verification.md` (失敗実験として close)
**関連 commit**: `1beb915` を amend で全 staleTimes 変更撤回、 source は `a941b7c` 状態に巻き戻し

**試行**: `next.config.ts` に `experimental.staleTimes.dynamic = 30` を入れ「通常 navigation 再訪問で `?_rsc=` fetch 0 本」 を期待。

**結果 FAIL**: N1/N2/N3 全シナリオで 1 fetch 発生 (1772-2505 ms)。 公式 docs では「staleTimes.dynamic で normal navigation も cache hit」 と読めるが、 RecallMint の構成 (全 Link `prefetch={false}` + 全 page `auth()` 経由 implicit dynamic + Clerk middleware) では effective でない。

**判明した制約**:
- `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` (Vercel 強制、 server-side dynamic 由来)
- `x-vercel-cache: MISS` (CDN cache 不使用)
- back/forward navigation の cache は default で動作するが、 通常 Link click 再訪問の cache が staleTimes では効かない

**結論**: prefetch={true} に部分復活して staleTimes を effective 化する案は S-perf-1 で解消した RSC prefetch 並列爆発を再導入するリスクが高いため不採用 → **IDB local-first (Dexie pre-sync) で server fetch 自体を縮小する中期方針に倒した**。

### 1.3 `unstable_cache` の検討 (採用見送り)

**session**: `docs/superpowers/sessions/2026-05-26-cache-auth-idb-wiring-audit.md` §1.5

「users 行を request 跨ぎ cache する (Next.js 15 の `unstable_cache` か Vercel edge KV / Upstash)」 を選択肢として検討、 ただし plan / billingInterval / deletedAt が頻繁に変わらない前提なら 60s 程度の cache でも実害なし、 と書かれているのみで **採用には至らず**。 現状 `unstable_cache` 使用 0 (`grep` 確認: usage は app-header.tsx / save-session-limit.ts の **コメント言及のみ**)。

### 1.4 影響範囲のまとめ

- 「ロード時間が長い」 系の戦線では Next の cache 系 experimental (staleTimes / unstable_cache) を試したが効かず、 **`prefetch={false}` 配備 + IDB local-first** で実害解消。
- 現状コード上の touch point:
  - `app/(app)/app/_components/app-header.tsx:18`: コメントで `staleTimes.dynamic=0` 言及
  - `app/(app)/app/settings/_actions/save-session-limit.ts:35`: 同上
  - `lib/sync/*` (IDB Dexie mirror) で server fetch を縮小済み
  - `next.config.ts` に **`eslint` / `experimental` section 一切なし** (全 default)

---

## 2. Next 15 → 16 の breaking change と RecallMint 影響

Context7 source: `/vercel/next.js/v16.2.2` (latest stable は v16.2.2、 16.0.x / 16.1.x / 16.2.x 3 系列が release 済)

### 2.1 breaking change マトリクス

| # | Breaking change | Codemod | RecallMint 影響 | 対応 |
|---|---|---|---|---|
| A | **`next lint` 削除** (Next 16 で完全削除、 `eslint` config option も不要に) | `npx @next/codemod@canary next-lint-to-eslint-cli .` | **要対応**。 ESLint Step 0 で発覚済の「設定 0 / CI 0」 と統合可能 | codemod + flat config 設置 |
| B | **`middleware.ts` → `proxy.ts` rename** + 関数名 `middleware` → `proxy` + config 名 (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize` 等) | `npx @next/codemod@latest middleware-to-proxy .` | **要対応**。 既存 1 ファイル `middleware.ts` (Clerk middleware + lib/clerk env validation)。 codemod 1 発で rename + config 名置換 | codemod + edge/node 判断 (下記 §2.2) |
| C | **Turbopack default 化** (15 まで opt-in、 16 で stable default)。 webpack 設定検出で build fail | upgrade codemod 自動変換 or `--webpack` opt-out flag | next.config.ts に webpack 設定あり (dev watchOptions、 1 block) → codemod が turbopack 互換に変換、 失敗時は `--webpack` でこのまま継続可能 | codemod 試行 → 失敗時 opt-out |
| D | **Async params (Promise)** | 15.0 で導入済 | **既に対応済**。 `app/(app)/app/exams/[id]/page.tsx:21,23` 等で `params: Promise<{...}>` + `await params` 採用 | なし |
| E | **fetch default `no-store` 化** | 15 で完了 | RecallMint は IDB-first で server fetch ほぼなし、 Clerk/Stripe SDK 内部 fetch のみ影響可能性。 軽微 | smoke で実害確認 |
| F | **`<Link>` prefetch behavior 変更なし** | なし | App Router default = `'auto'` (static = full prefetch、 dynamic = partial)。 RecallMint は `prefetch={false}` で全制御済 | なし |
| G | **`staleTimes` 依然 experimental** | なし | 16 でも `experimental.staleTimes` のまま (`config-shared.ts` に default 値 dynamic=0/static=300 残存)。 RecallMint は撤回済 = 影響なし | なし |
| H | **`unstable_cache` 動作継続、 `'use cache'` directive + `cacheLife` / `cacheTag` 推奨** | なし | RecallMint は `unstable_cache` 使用 0 = 影響なし。 新 cache API 採用は別議論 | なし |

### 2.2 middleware → proxy の design judgment (要 OT decide)

**重要差分**: `proxy.ts` は **Node.js runtime 固定、 edge runtime 非サポート**。 edge runtime を保持したい場合は `middleware.ts` のまま (deprecated 警告は出るが動く、 Next 17 で完全削除予定)。

**RecallMint の edge runtime 利用状況**:
- `middleware.ts` line 1 コメント: `// env prefix validation (side-effect, Edge runtime)`
- 中身: `clerkMiddleware()` + 自前 env validation
- `lib/clerk.ts` (env validation side-effect モジュール) は `process.env` のみ参照、 **edge-only API 不使用**。 lib/clerk.ts コメント明記: 「Imported as a side-effect from middleware.ts (Edge runtime) and lib/auth/ensure-user.ts (Node runtime) for dual-runtime fail-fast」 = **既に Node 両対応**

**選択肢**:
- **(A) proxy.ts に rename (Node runtime に切替)**: Next 16 公式 path、 Clerk 公式 `proxy.ts` 設定例あり (context7 確認済)。 edge → node でコールドスタート遅くなる可能性 (実害は Vercel deploy preview で smoke 必要)。 lib/clerk.ts は影響なし
- **(B) middleware.ts のまま維持**: deprecated 警告、 Next 17 で完全削除予定 (将来の必須対応を先送り)。 edge runtime キープ

**推奨**: (A) **proxy.ts 化**。 RecallMint の edge runtime は CSP header 配備 + auth gate のみで、 性能 critical でない。 Node runtime に倒しても実害なし、 codemod でファイル rename 1 発。

### 2.3 Clerk 側の Next 16 対応状況

Context7 source: `/clerk/clerk-docs`

- `clerkMiddleware()` を `proxy.ts` で配置する公式サンプル**あり** (`docs/reference/nextjs/clerk-middleware.mdx`、 `docs/_partials/frontend-api-proxy/basic-usage-nextjs.mdx`)
- matcher パターンも proxy.ts 用に最新化された例あり (RecallMint の matcher とほぼ同形、 `/__clerk/(.*)` 行を追加するか判断)
- 現 `@clerk/nextjs@^7.2.4` が Next 16 公式対応版か、 もしくはより新しい minor が必要かは clerk-nextjs の release notes 確認推奨 (本調査では実 npm 確認まで未実施。 spec 段階で `pnpm info @clerk/nextjs versions` を 1 発確認)

### 2.4 codemod の自動化範囲

Context7 引用 (`docs/01-app/02-guides/upgrading/version-16.mdx`):
> The Next.js upgrade codemod automates several migration tasks when moving to version 16. It updates configuration files to use the new Turbopack settings, migrates from the internal lint command to the ESLint CLI, and handles the transition from deprecated middleware conventions to proxies. Additionally, it removes experimental prefixes from stabilized APIs and cleans up route segment configurations in pages and layouts.

実行コマンド: `npx @next/codemod@canary upgrade latest`

自動化される 5 項目:
1. Turbopack 設定への変換
2. `next lint` → ESLint CLI 移行
3. `middleware.ts` → `proxy.ts` rename
4. 安定化済 experimental prefix 除去
5. route segment config 整理

→ **手作業は (i) Vercel deploy preview smoke、 (ii) middleware → proxy 化の選択判断 (上記 §2.2)、 (iii) webpack 設定の Turbopack 互換確認 のみ**

### 2.5 影響範囲のまとめ

- **コード touch 候補**: `middleware.ts` (rename + 内部関数名)、 `next.config.ts` (webpack section の turbopack 化判断)、 `package.json` (`"lint"` script の `eslint .` 化)
- **新規ファイル**: `eslint.config.mjs` (ESLint Step 0 でいずれにせよ必要)、 `proxy.ts` (codemod 出力、 middleware.ts は削除)
- **テスト / smoke**: tsc + vitest は packages 側変更なしなのでそのまま pass 想定、 Vercel deploy preview で auth 経路 (sign-in / sign-up / protected route gate) と API route の smoke 必須

### 2.6 労力見積もり

| 段階 | 内容 | 時間 |
|---|---|---|
| 1 | `pnpm info next versions` で 16 系最新確認 + `pnpm info @clerk/nextjs versions` で Next 16 対応 minor 確認 | 5 分 |
| 2 | branch 作成 + `pnpm dlx @next/codemod@canary upgrade latest` 実行 | 10 分 |
| 3 | diff レビュー (middleware → proxy / next.config / package.json の 3 ファイル想定) | 30 分 |
| 4 | tsc + vitest pass 確認 | 15 分 |
| 5 | `pnpm dev` + `pnpm build` ローカル動作確認 | 30 分 |
| 6 | preview deploy + Vercel preview で smoke (sign-in / protected route / API + Stripe webhook 動作) | 60-90 分 |
| 7 | OT 承認 → main / develop merge → 本番 deploy 監視 | 30 分 |

**合計: 3-4 時間 (= 0.5 dev day)、 Clerk 側で問題起きたら 1 day**

### 2.7 ESLint CI gate との sprint 統合推奨

Step 0 (`docs/superpowers/sessions/2026-06-10-eslint-ci-gate-step0-investigation.md`) で「ESLint config 0、 CI workflow 0、 `next lint` deprecated」 が発覚済。 これと Next 16 化を **同 sprint にまとめると効率的**:

- Next 16 codemod が `next lint` → `eslint .` 移行を自動化
- ESLint flat config 設置 (Step 0 の対策) は Next 16 codemod 後の post-step で 1 ファイル新設
- CI workflow 新設 (.github/workflows/ci.yml) も同 sprint で配備
- 順序: Next 16 codemod → ESLint config 設置 → CI gate 設置 → smoke

個別 sprint だと手戻り (e.g. ESLint 設置後に Next 16 で `next lint` 削除されると script の再書き換え) が出る。 まとめると 1 dev day で全完了見込み。

### red flag

- **中**: Clerk Next 16 対応 minor が `^7.2.4` 範囲内にあるか未確認。 範囲外なら Clerk の minor upgrade も同 sprint に。 確認 1 発 (`pnpm info @clerk/nextjs versions`)
- **低**: codemod が all-in-one なため、 自動化対象の細部に予想外の breaking がある可能性。 deploy preview smoke で吸収
- **低**: edge → node runtime 切替で auth gate のコールドスタートが微増する可能性。 Vercel hnd1 region なら実害ほぼなし想定

---

## 3. React のバージョン現状

### 3.1 現状

```json
"react": "^19.2.5",
"react-dom": "^19.2.5",
```

### 3.2 Context7 documented latest

`/facebook/react` バージョン list:
- v17.0.2
- v18_3_1
- **v19_1_1**
- **v19_2_0** ← 最新 documented major
- (changelog 内 19.2.1 言及あり、 2025-12-03 release)

→ React 19 系の最新 stable は **19.2.1** (2025-12-03 release per CHANGELOG)。 RecallMint は `^19.2.5` で **これより新しい patch line** に乗っている (caret で 19.x.x の最新を取る)。

### 3.3 React 19 breaking change の absorbed 状況

React 19.0 breaking changes (CHANGELOG 引用):
- 新 JSX Transform 必須
- `propTypes` 削除 (silently ignored)
- function `defaultProps` 削除
- `contextTypes` / `getChildContext` 削除
- string refs 削除
- `React.createFactory` 削除
- `react-dom/test-utils` 削除 (act は react へ移動)
- `ReactDOM.render` / `ReactDOM.hydrate` 削除 (`createRoot` / `hydrateRoot` 必須)
- `unmountComponentAtNode` 削除
- `ReactDOM.findDOMNode` 削除
- `react-test-renderer/shallow` 削除 (`@testing-library/react` 推奨)
- `forwardRef` optional 化 (ref は通常 prop で受け取り可)

RecallMint は **19.2.5 で動作中 = 19.0 breaking change は absorbed 済**。 これらの API を使うコードを書いていたら既に tsc / vitest で fail している (実際は 626 tests pass 確認済)。

### 3.4 React 19.2 新機能の利用状況

19.2 で追加された API (Context7 確認):
- `useEffectEvent` hook (非反応 logic を effect から抽出)
- `<Activity>` component (UI 可視性と state を独立管理)
- `resumeRequest` (Partial Pre-rendering の Server-side resume)
- Server Component の fixes (19.2.1 patch)

RecallMint がこれらを使っているか:
- `useEffectEvent` / `<Activity>` / `resumeRequest`: `grep` で**いずれも未使用** (本調査で確認)
- → 新機能未活用、 ただし利用の有無は upgrade とは独立 (利用は別議論)

### 3.5 結論

**上げる必要なし、 既に最新**:
- 19.2.5 は documented 19.2.1 (2025-12-03) より新しい patch
- 19.0 breaking changes は absorbed 済
- 19.2 新機能は available (利用するかは別議論)
- React 20 は未 release (最新 major は 19)

### red flag

- なし。

---

## 全体 red flag 評価

| 項目 | level | 内容 |
|---|---|---|
| 1 過去の引っ掛かり (prefetch / staleTimes) | 低 | 解消済 (prefetch={false} 配備 + IDB local-first 路線)、 Next 16 化で再燃なし |
| 2 Next 16 upgrade | 中 | codemod 強力だが Clerk minor 確認 1 発要、 middleware → proxy 化は edge→node runtime 切替を伴う |
| 3 React upgrade | なし | 既に最新 19.2.5、 上げ作業不要 |

---

## 次の判断材料

1. **Next 16 化を ESLint CI gate 設置と同 sprint にまとめるか**: 個別だと `next lint` 削除タイミングで手戻り、 まとめると 1 dev day で全完了見込み
2. **middleware → proxy 化の選択**: (A) proxy.ts に rename (Node runtime、 Next 16 公式 path、 codemod 1 発) / (B) middleware.ts 維持 (deprecated 警告、 Next 17 で削除予定、 edge runtime キープ)
3. **同 sprint scope の決定**: (i) Next 16 + ESLint + CI gate 三点 / (ii) Next 16 のみ先行 + ESLint CI gate は別 sprint / (iii) 何もしない (Next 17 で `next lint` 削除されるタイミングまで遅延)
4. **Clerk minor upgrade 要否**: `pnpm info @clerk/nextjs versions` で Next 16 公式対応 minor を 1 発確認 (spec 起草前)
