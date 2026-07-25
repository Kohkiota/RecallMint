# deps 再基線 sprint(matrix v2)Step 0 fact-finding

- **日付**: 2026-07-25 / branch `develop` / 調査 HEAD `76d4770`
- **性質**: 事実収集のみ(read-only)。**実装・変更・commit なし**。判断・推奨は**書かない**(方針は claude.ai + OT で議論して決める)。
- **方法**: CC subagent 4 体並列(A/B/C/D)。**全て registry(`pnpm view`)/ manifest / changelog / 公式 docs の現物**で取得(matrix v1.3 の「記憶ベース版断定で 5 件外し」教訓に従い記憶で断定しない)。**不明は「不明」明記**。
- **本 doc は Step 0 材料**。目標版選定・pin 方針・2 層化採否は未決(OT 議論待ち)。
- **注意(調査者所見)**: WebFetch 要約は日付を誤る例あり(tailwind で 2024 表記等)→ 日付は引用せず breaking の有無・内容のみ採用。

---

## A. ESLint 10 移行の成立条件(最重要 — 再基線の形を決める)

### 判定材料(事実のみ・判断は未記載)
**ESLint 10 を塞いでいるのは eslint-config-next@16.2.11 が `dependencies` として抱える 3 plugin**。config-next 本体 peer は解放済。

| 主体 | 現行/最新版 | peer eslint | ^10 |
|---|---|---|---|
| eslint-config-next(本体 peer) | 16.2.11(latest) | `>=9.0.0` | **可** |
| eslint-plugin-react | 7.37.5(latest) | `… \|\| ^9.7` | **不可** |
| eslint-plugin-import | 2.32.0(latest) | `… \|\| ^9` | **不可** |
| eslint-plugin-jsx-a11y | 6.10.2(latest) | `… \|\| ^9` | **不可** |
| @next/eslint-plugin-next | 16.2.11 | peer なし | 制約なし |
| eslint-plugin-react-hooks(direct devDep) | 7.1.1(latest) | `… \|\| ^10.0.0` | **可** |
| typescript-eslint / parser / plugin | 8.59.0 resolved(latest 8.65.0) | eslint `… \|\| ^10.0.0` / **TS `>=4.8.4 <6.1.0`** | **可**(TS 6.0.3 も範囲内) |

- **eslint-plugin-react@7.37.5 は peer だけでなく実行時破壊**: ESLint 10 で `context.getFilename()` 削除により `getFilename is not a function`(display-name rule)でクラッシュ。issue `jsx-eslint/eslint-plugin-react#3977` = **OPEN・最新 7.37.5 未修正**。ESLint 側の移行策は `@eslint/compat` 案内。
- **eslint core を 10 化しても v1 線(minimatch@3 → brace-expansion@1.1.16)は消えない**: `minimatch@3.1.5` の親は eslint9 の config-array/eslintrc/core **だけでなく** eslint-plugin-import / -jsx-a11y / -react が各々 `minimatch ^3.1.2` を独立宣言。eslint@10.8.0 は deps を `minimatch ^10.2.5` + `@eslint/config-array ^0.23.5` にし `@eslint/eslintrc` を除去するが、**上記 3 plugin(config-next の dep)が minimatch@3 を保持**。→ 台帳(GHSA-mh99)の撤去条件「ESLint 10 移行で v1 線消滅」は **eslint-core bump 単体では不成立**(3 plugin が eslint 10 対応するまで残る)。
- ESLint 10 breaking の当たり: Node 要件 `^20.19 || ^22.13 || >=24` = 24.x で**満たす** / flat config は既済 / 削除 API(getFilename 等)は plugin 側が踏む(上記) / minimatch bump の glob(POSIX character class 対応)= 本 repo の `eslint.config.mjs` は route group `\(app\)` / dynamic `\[id\]` を escape 済リテラルで使用・POSIX class や生 extglob paren 不使用ゆえ**該当薄**(下記不明あり)。getDb ban は `no-restricted-imports`(minimatch でなく ignore/regex 評価)ゆえ影響外。
- lefthook pre-commit(`pnpm exec eslint --max-warnings=0 --no-warn-ignored {staged}`)/ gate(`eslint . --max-warnings=0`)= flat config 前提の素 CLI・eslintrc/削除 API 不使用。
- **upstream**: `vercel/next.js#91702`(config-next の eslint v10 対応)= **Closed(duplicate)**(同梱 plugin peer が v10 除外と記載)/ `jsx-eslint/eslint-plugin-react#3977`(v10 実行時破壊)= **OPEN** / `eslint/eslint#20594`(react plugin peer install 失敗)= Closed(npm 側 peer 解決の話・pnpm strict-peer 無効では挙動差)。
- **不明(要検証)**: ① minimatch10 下の `\(...\)` / `\[...\]` エスケープ挙動が v3 と同一か(未実証)② `--no-warn-ignored` の ESLint 10 存廃 ③ pnpm(strict-peer 無効)で eslint@10 + 上記 3 plugin install が warn 止まりか fail か ④ import/jsx-a11y が react と同種の実行時破壊を踏むか(個別報告未確認)。

出典: `pnpm view`(2026-07-25)/ `pnpm-lock.yaml` / `eslint.config.mjs` / `lefthook.yml` / `pnpm why minimatch` / eslint.org migrate-to-10.0.0 / 上記 issue URL。

---

## B. 波3 の 12 件 + pin drift 棚卸し

**12 件すべて major 跨がず(現行 major = 最新 major)。changelog 上いずれも明示 breaking なし。** 要注意は stripe apiVersion と radix root-import のみ。

| pkg | 宣言 | 解決 | latest | breaking | 使用面(smoke) |
|---|---|---|---|---|---|
| stripe | `^22.0.2` | 22.0.2 | 22.3.2 | 非破壊。**SDK pinned apiVersion が minor で変化**(22.0.2=`2026-03-25.dahlia` → 22.3.0=`2026-06-24.dahlia`)。フラグ①参照 | 課金 Checkout/webhook/subscription(import 14)。smoke=webhook+subscription+downgrade |
| svix | `^1.91.1` | 1.91.1 | 1.99.1 | **changelog 未取得(404)=不明**。`Webhook.verify` は 1.91.1 で存在確認、diff 未検証 | Clerk webhook 署名検証(1 箇所)。smoke=Clerk webhook |
| vitest | `^4.1.5` | 4.1.5 | 4.1.10 | 4.1.6–4.1.10 bug-fix のみ | test runner(gate=test/test:iso) |
| @vitest/coverage-v8 | `^4.1.5` | 4.1.5 | 4.1.10 | 同 patch 群 | カバレッジ。**vitest と exact-lockstep 必須**(フラグ②) |
| dexie | `^4.4.2` | 4.4.2 | 4.4.4 | bug-fix。**4.4.4 = useLiveQuery の in-place mutate+put キャッシュ不検出 fix**(RecallMint 直撃領域だが修正) | client mirror + useLiveQuery(8 comp)。smoke=live view |
| ts-fsrs | `5.3.2`(exact) | 5.3.2 | 5.4.1 | 非破壊(NaN clamp / FSRSValidationError 追加 / relearning ceiling) | 復習スケジュール中核。smoke=study/review。**唯一 exact** |
| radix-ui(umbrella) | `^1.4.3` | 1.4.3 | 1.6.7 | 使用 primitive に破壊なし。1.6.0 breaking=未使用の Password Toggle のみ。**1.6.4=root import が型を any に消す regression の fix**(root umbrella import ゆえ関連) | Dialog/Popover/Tabs/Label/Slot。smoke=dialog/side-peek/popover |
| lucide-react | `^1.14.0` | 1.14.0 | 1.26.0 | アイコン追加中心・API 破壊なし | アイコン(15 file)。smoke=視覚 |
| tailwindcss | `^4.2.4` | 4.2.4 | 4.3.3 | CSS出力/@import/plugin breaking なし | build-time CSS。smoke=build+視覚 |
| @tailwindcss/postcss | `^4.2.4` | 4.2.4 | 4.3.3 | tailwind と同版 lockstep(フラグ③) | PostCSS plugin。smoke=build |
| tailwind-merge | `^3.5.0` | 3.5.0 | 3.6.0 | 非破壊(Tailwind v4.3 対応追加) | `cn` helper(全 UI 波及)。smoke=視覚 |
| tsx | `^4.21.0` | 4.21.0 | 4.23.1 | esbuild 0.28 化+性能改善・非破壊 | ops script 実行器。runtime 非混入=smoke 対象外 |

### 要注意フラグ(事実のみ)
- **① stripe apiVersion**: `lib/stripe/client.ts:79` は `apiVersion` **未指定**(全 repo で `apiVersion`/`Stripe-Version` 参照 0 件)。matrix doc は「apiVersion 変更は実質なし」と想定するが SDK CHANGELOG では minor で pinned 版が変化 → **食い違い**。未指定時に SDK pinned 版が送られるか Dashboard 既定版かは**コードだけでは判定不能=不明**(要検証)。
- **② vitest ↔ coverage-v8**: `@vitest/coverage-v8@X` の peer = `{ vitest: 'X'（exact）}`。**片方だけ上げると peer 不整合 → 必ず同版**。
- **③ tailwindcss ↔ @tailwindcss/postcss**: 同版で揃える運用(postcss plugin の peer は空宣言だが matrix もペア扱い)。
- **④ engines**: dexie `>=20` / ts-fsrs `>=18` / tsx `>=18` / vitest peer `@types/node ^20||^22||>=24` / stripe engines 宣言なし → Node 24 と抵触なし。

### radix import 実態(v1.3 積み残しの確定)
- **umbrella `radix-ui` のみ(6 箇所)。個別 `@radix-ui/react-*` の直接 import は 0 件**。umbrella が内部 pin する実 primitive(参考): react-dialog 1.1.15 / react-popover 1.1.15 / react-tabs 1.1.13 / react-label 2.1.7 / react-slot 1.2.3。→ matrix「個別か umbrella か」は **umbrella 一本で確定**。

### pin 様式 drift の実態
- **(a) matrix 定義の「drift 4 件」= matrix `[exact]` 指定に対し package.json が caret**: `typescript`(`^6.0.3` vs `6.0.3`)/ `eslint`(`^9.39.4` vs `9.39.4`)/ `@types/node`(`^24.13.2` vs `24.x`)/ `drizzle-kit`(`^0.31.10` vs `0.31.10`)。**波3 12 件には含まれない**横断事項。doc 曰く「lockfile で解決版 pin ゆえ機能影響なし」。
- **(b) 波3 内の逆 drift**: 12 件中 **ts-fsrs だけ exact 宣言**(`5.3.2`)・他 11 は caret。matrix 意図は `^5.4.1`(caret)ゆえ実物と逆。
- **(c) package.json 全 exact-pin(15 件)**: dep = @clerk/nextjs 7.5.1 / @tanstack/react-table 8.21.3 / @tanstack/react-virtual 3.14.5 / next 16.2.11 / photoswipe 5.4.4 / react 19.2.7 / react-dom 19.2.7 / react-markdown 10.1.0 / remark-gfm 4.0.1 / remark-parse 11.0.0 / ts-fsrs 5.3.2 / unified 11.0.5。dev = @types/react 19.2.17 / @types/react-dom 19.2.3 / eslint-config-next 16.2.11。他は全 caret。**exact 理由が doc に明記あるのは react系/types/next/clerk のみ・@tanstack/photoswipe/react-markdown/remark/unified/ts-fsrs の exact 理由は不明**。
- **参考**: matrix(2026-06)の目標版は registry latest に既に追い越されている(例 stripe 22.2.0 目標 vs latest 22.3.2)→ 再基線の目標版は matrix 値そのままでは古い。

出典: `pnpm view`(2026-07-25)/ `pnpm-lock.yaml` / `package.json` / 各 GitHub releases・CHANGELOG / `lib/stripe/client.ts` / matrix doc(line 235/237)。

---

## C. matrix 未記載の新規 dep

| pkg | 現行 | latest | major跨ぎ | pin | type | 使用面 |
|---|---|---|---|---|---|---|
| photoswipe | 5.4.4 | 5.4.4 | なし | exact | ESM | 画像ズームモーダル(1 file・dynamic import) |
| @tanstack/react-table | 8.21.3 | 8.21.3(9.x alpha/beta のみ) | なし | exact | CJS | exam カードテーブル群 |
| @tanstack/react-virtual | 3.14.5 | 3.14.8 | なし | exact | ESM | 行仮想化(2 file) |
| aws4fetch | 1.0.20 | 1.0.20(2.x なし) | なし | caret | dual(type欠落) | R2 presigned 署名(1 file・server 専用・ゼロ依存) |
| react-markdown | 10.1.0 | 10.1.0 | なし | exact | ESM | MD テーブル描画(1 file) |
| remark-gfm | 4.0.1 | 4.0.1 | なし | exact | ESM | GFM(2 file) |
| remark-parse | 11.0.0 | 11.0.0 | なし | exact | ESM | MD→mdast(1 file) |
| unified | 11.0.5 | 11.0.5 | なし | exact | ESM | markdown pipeline(2 file) |
| shadcn | 4.6.0 | 4.14.1 | なし(minor×8 gap) | caret | ESM | **CSS `@import "shadcn/tailwind.css"` のみ**(JS import なし) |

### 固定制約(事実)
- **photoswipe**: 5.4.4=latest・5.x 最新も 5.4.4・**6.x のリリース/roadmap 公開情報になし=不明**。`tapAction` の **カスタム関数は公式 docs 記載の正式サポート値**(列挙値 + Custom function)。image-ux2 実装は内部 `optionValue.call(pswp, point, originalEvent)` に依拠(公開 API 対応)。過去 5.x に明示 breaking フラグは可視範囲になし(5.4.1=trapFocus/preventPointerEvent 追加等の additive)。
- **@tanstack**: react-table 8.21.3=latest(9.x は alpha/beta のみ)・react-virtual latest 3.14.8。両 peer が react 19 許容(table `>=16.8` / virtual `^16.8||^17||^18||^19`)。
- **remark 系 4 点**: **全 ESM-only**・**unified 11 line に相互ピン**(react-markdown 10 → `remark-parse ^11`/`unified ^11`、remark-gfm 4 → `unified ^11`、remark-parse 11 → `unified ^11`)。**単独 major 昇格は unified 11 line と desync する構造**。exact 既定の裏取り = この生態系は major 毎に **ESM 化 / Node 要求 / 型・API breaking を毎回伴う実績**(react-markdown v7 ESM化・v9 React18必須・v10 className削除 / unified v10 ESM化・v11 Buffer→Uint8Array / remark-gfm v2 ESM化・v4 unified11 移行)。react-markdown peer react `>=18`(19 可)。
- **aws4fetch**: 1.0.20=latest(2.x なし・beta 1.0.18-beta.2)・ゼロ依存・R2 S3互換 presigned 署名(server 専用)。
- **shadcn**: CLI が**実行時 import されない**(CSS @import のみ)。4.6.0→4.14.1(minor×8 gap)。重 transitive を引く: `ts-morph ^26` / `@babel/core ^7.28` / `@modelcontextprotocol/sdk ^1.26` / `recast` / `execa` 等。**brace-expansion@5.0.8 の 2 由来の 1 つ**(`@ts-morph/common ← ts-morph ← shadcn`(dependencies)/ もう 1 つは typescript-estree ← config-next(dev))。
- **不明**: photoswipe 6.x 予定 / remark-parse 単独 major changelog 逐条 / remark・unified 系 published `engines.node` は空欄(changelog は Node 16 要求記載だが manifest 未宣言)。

出典: `pnpm view`(2026-07-25)/ `pnpm-lock.yaml` / `package.json` / photoswipe.com docs + GitHub releases / remarkjs・unifiedjs changelog / `pnpm why ts-morph`・`pnpm why brace-expansion`。

---

## D. audit gate の prod/dev 分離の実装可否

- **pnpm 10.33.0 に `--prod`(-P)/ `--dev`(-D)フラグ実在**(公式 docs pnpm.io/10.x/cli/audit)。実測: `--prod --audit-level high` = high 0(exit 0)/ `--dev --audit-level high` = high 1(`1 ignored`・exit 0)。受容中 brace-expansion(dev のみ)ゆえ prod は high 0。
- **単一 config で prod/dev に別 audit-level を課す手段は無い**: `--audit-level` / `auditLevel`(pnpm-workspace.yaml)は **1 実行 1 グローバル閾値**。→ 2 層化は **audit を 2 回別実行**するしかない(`--prod --audit-level high` と `--dev --audit-level high` を `&&` 連結等)。
- **`--json` に dev/prod field は無い**(全 advisory で `dev` bool 不在)。scope 判別材料は `advisories.<id>.findings[].paths`(依存チェーン文字列)のみ。`--prod`/`--dev` フラグが「どの path を含めるか」で scope を実現。`metadata.devDependencies` は default 実行で 0(判別に使えない)。`metadata.vulnerabilities.high` は **ignore 前**の値を数える。
- **ignoreGhsas は advisory 単位・経路非依存で沈黙**(docs: 「the pnpm audit command」全体・scope 限定子なし)。default/`--dev` で ignore が効くのは実証。**`--prod` が ignoreGhsas を読むかは直接実証不可=不明**(受容対象の脆弱版 1.1.16 が prod tree に無く filter 対象ゼロ → 「読むが対象なし」と「読まない」を区別できない)。
- **「受容 GHSA が許容経路以外(prod)から入っていないこと」の機械検査は version-aware 必須**(最重要): brace-expansion は **patched 5.0.8 が prod tree に存在**(shadcn 経由)・脆弱 1.1.16 は dev-only。→ **名前一致検査は必ず false-positive**。version 照合手段 = `pnpm why <pkg> --prod --json`(各 node に name/version・機械可読)or `pnpm ls --prod --depth Infinity`(version まで grep)。
- **期限管理(dev 例外の再検討期限)を強制する機構は pnpm に無い**=不明(現状は台帳テキスト管理のみ・`ledger:19` に `2026-08-22` 記載)。
- 現行 prod advisory(参考・全て非 high): moderate=ip-address / qs / @hono/node-server、low=@babel/core / body-parser(主に `@google/genai>@modelcontextprotocol/sdk` chain)。dev=esbuild(mod+low)/ @babel/core(low)。

出典: `pnpm audit --prod/--dev`(実出力)/ `pnpm audit --help` / `pnpm why brace-expansion --prod` / `package.json`(scripts.audit)/ `scripts/check-audit-config.mjs` / `pnpm-workspace.yaml` / pnpm.io/10.x/cli/audit。

---

## 横断 不明/要検証(OT 議論前に潰すか判断が要る点)
1. **A**: ESLint 10 は Next 同梱 3 plugin(react/import/jsx-a11y)が upstream で塞ぐ(react は実行時破壊・#3977 OPEN)。→ eslint-core 単独 bump では v1 線も消えず GHSA 撤去条件も不成立。移行は upstream 待ち。
2. **A 不明**: minimatch10 の escape 挙動 / `--no-warn-ignored` 存廃 / pnpm strict-peer 無効時の install 挙動。
3. **B①**: stripe apiVersion 未指定の実効送信版(SDK pinned か Dashboard 既定か)=コードで判定不能・要検証。matrix 想定と CHANGELOG が食い違い。
4. **B**: svix 最新 breaking = changelog 404 で未取得=不明。
5. **C**: photoswipe 6.x 予定不明 / remark 系は unified 11 line 相互ピンで単独昇格不可(exact 妥当の構造的裏付け)。
6. **D**: prod/dev 2 層は 2 回実行で機構的に可能・per-scope level は不可・受容の経路限定保証は version-aware 検査必須・期限強制は pnpm 非対応(台帳運用のみ)。

**判断・推奨は本 doc に記載しない**(方針は claude.ai + OT 議論で決定)。
