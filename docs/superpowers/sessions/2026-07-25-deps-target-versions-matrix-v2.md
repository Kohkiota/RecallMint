# RecallMint 依存ターゲット版 確定マトリクス (2026-07-25 v2)

> **本 file が依存 pin の正本(v2)**。改訂時は repo 側を更新し、OT が claude.ai プロジェクトナレッジへ同期する。
> **v1.3(`docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md`)は superseded**。v1.3 は Next16/ESLint9/波1-2 のクローズ記録として履歴保持するが、pin 方針・目標版・audit gate 構造の正本は本 v2。
> **経緯**: deps 再基線 sprint(matrix v2)。Step 0 fact-finding = `docs/audit/2026-07-25-deps-rebaseline-matrix-v2-step0-factfinding.md`(現物調査)。台帳 = `docs/audit/dependency-audit-ledger.md`。

---

## 1. pin 規則(v2 で確立・恒久)

1. **direct 依存は全 exact**(dependencies / devDependencies に caret を使わない)。lockfile 消失時の patch ドリフト防止 + 送信版・解決版の決定性。
2. **版の更新は明示 sprint のみ**(exact ゆえ `pnpm install` では動かない = 意図しない bump が起きない)。更新は対象 package を指定した `pnpm update --latest <pkg>` or 直接編集で行う。
3. **transitive は lockfile + `pnpm-workspace.yaml` の overrides で管理**(direct には出さない)。

**判定基準(1 行)**: 「**バージョン・挙動が動く = 触る**」/「**宣言形式のみ(caret→exact・版不変)= 触らない**」。後者は「触らないもの」制約(eslint 系 / @google/genai / shadcn 等)と両立する — v2 で全 direct を exact 化した際、これら含む全 caret を現行解決版で exact 化したが版は不変(lockfile 差分ゼロ=解決不変が「触っていない」ことの証明)。

> 実測注記(v2 の exact 化時): exact specifier は pnpm の再解決を誘発し、caret が grandfather していた stale 重複下位 transitive を既存の上位/direct 版へ集約する(benign dedup)。**dedup で集約された transitive はすべて lockfile に既存の解決版への統合であり、新規版の install/導入はゼロ**(reused のみ・downloaded 0 を実測)。direct 解決版は不変(importers version 変化ゼロ)。

---

## 2. audit gate の新構造(v2 で wrapper 化・2026-07-25)

gate = `pnpm run audit` = **wrapper `scripts/audit-gate.mjs`**(旧: `check-audit-config.mjs && pnpm audit --audit-level high`)。

- **prod 無条件**: `pnpm audit --prod --audit-level high --json` で high/critical が 1 件でもあれば fail。**allowlist を一切適用しない**(optional 依存も含む=`--no-optional` を付けない)。公開面の脆弱性受容ゼロ。
- **dev allowlist**: `pnpm audit --dev --audit-level high --json` を `scripts/audit-allowlist.json` と **version-aware** で照合。未受容 high/critical / 期限切れ / range 外は fail。
- **fail-closed 3 点**(pass 判定の前に検証・欠けたら fail): ① exit code の健全性(0/1 のみ・内容整合)② JSON.parse 成否 ③ 期待構造(`advisories` / `metadata.vulnerabilities.high|critical`)。registry 障害・出力破損を「脆弱性なし」と誤認しない。
- **tripwire**: wrapper 冒頭で `check-audit-config.mjs` の `checkAuditConfig` を実行。**受容が JSON へ移行したため `pnpm-workspace.yaml` の `auditConfig` は用途を失い、auditConfig 行があれば無条件 fail**(pnpm は auditConfig を wrapper へ渡す前に advisory を沈黙 filter する = allowlist 迂回。indented-root も `^\s*` で捕捉)。層1 の `ignoreCves` substring 検出は継続(`--ignore` CLI 書込経路)。

> 補足: CLAUDE.md「Sprint 完了 gate(audit gate)」の記述は wrapper 化前の旧構造(`check-audit-config.mjs + pnpm audit --audit-level high` / `auditConfig.ignoreGhsas` 受容)のまま = **stale**。更新は OT 判断の follow-up(constitution ゆえ本 sprint では触らず・下記「OT follow-up」)。

---

## 3. allowlist 設計原則(受容 = `scripts/audit-allowlist.json`)

OT 裁定(2026-07-25・Codex r4 P1 対応)で確立:

- **`vulnerableRange` は advisory の affected 範囲の転記ではなく『受容している現物の系列』を書く**。受容根拠が「その系列に patched 版が無い」ことなら、受容範囲もその系列と一対一。例: brace-expansion GHSA-mh99 は v1 系に patched が無いゆえ受容範囲 = **`<2.0.0`**(v1 系)。v2〜5.0.7 は patched(5.0.8=v5)への道がある版なので、新規混入したら **fail させて bump 誘導**するのが正しい挙動(初期案 `<=5.0.7`=affected 転記は over-accept)。
- **過度に絞らない(`=1.1.16` にしない)**: backport 無しのまま v1 系の新 patch(例 1.1.17)が出る可能性があり(1.1.14→1.1.16 実績)、その都度 allowlist を触ると version-aware の利点を損なう。**「patched 不在の系列」単位で受容**する。
- **path は照合キーにしない**(記述フィールド): 依存木の良性再構成で path が変わり誤 fail する brittleness を避ける。経路(eslint 系 dev 等)は人間向けの記述に留める。残余 = 同系列版が別 dev 経路から入っても受容されるが、その系列が patched 不在である限り受容根拠(bump 先が無い)は経路に依らず不変。
- **prod は allowlist 不適用**(dev 限定受容)。**expiry は全 entry 無条件強制**(advisory 未検出でも期限切れなら fail)+ 暦日実在検証(`2026-13-01` 等の shape だけ通る値を弾く)。
- 追加/変更時は GHSA/CVE・理由・再検討条件を台帳にセット記録 + JSON にエントリ(ghsa + module + vulnerableRange + expiry + path)。

現行エントリ = GHSA-mh99-v99m-4gvg / brace-expansion / `<2.0.0` / expiry 2026-08-22 / eslint plugin 系 dev。

---

## 4. 全 direct 依存 確定版一覧(2026-07-25 bump 後・全 exact)

### dependencies (D)

| package | pin | 備考 |
|---|---|---|
| @clerk/nextjs | 7.5.1 | 認証核・触らない(別領域) |
| @dnd-kit/core | 6.3.1 | legacy 線最新・触らない |
| @dnd-kit/sortable | 10.0.0 | 同上 |
| @dnd-kit/utilities | 3.2.2 | 同上 |
| @google/genai | 1.50.1 | 1.x 維持(2.x は OCR sprint 同梱・触らない) |
| @tanstack/react-table | 8.21.3 | v9 は alpha 不採用 |
| @tanstack/react-virtual | **3.14.8** | v2 bump |
| aws4fetch | 1.0.20 | R2 presigned・ゼロ依存・server 専用・2.x なし |
| browser-image-compression | 2.0.2 | — |
| bufferutil | 4.1.0 | onlyBuiltDependencies |
| class-variance-authority | 0.7.1 | — |
| clsx | 2.1.1 | — |
| dexie | **4.4.4** | v2 bump(useLiveQuery in-place mutate fix 含む) |
| dexie-react-hooks | 4.4.0 | — |
| drizzle-orm | 0.45.2 | drizzle-kit とペア |
| lucide-react | **1.26.0** | v2 bump(アイコン追加中心) |
| next | 16.2.11 | 核・触らない(security patch 済) |
| photoswipe | 5.4.4 | 6.x 情報なし・tapAction カスタム関数 API 前提 |
| postgres | 3.4.9 | app runtime driver |
| radix-ui | **1.6.7** | v2 bump(umbrella・使用 primitive に破壊なし) |
| react | 19.2.7 | 核・overrides 固定・触らない |
| react-dom | 19.2.7 | react とペア・overrides 固定 |
| react-markdown | 10.1.0 | unified 11 line 相互ピン |
| remark-gfm | 4.0.1 | 同上 |
| remark-parse | 11.0.0 | 同上 |
| server-only | 0.0.1 | — |
| shadcn | 4.6.0 | **bump 保留**(CSS `@import` のみ・JS import なし・重 transitive 回避) |
| stripe | **22.3.2** | v2 bump(apiVersion=下記§6) |
| svix | **1.99.1** | v2 bump(Clerk webhook 署名検証) |
| tailwind-merge | **3.6.0** | v2 bump |
| ts-fsrs | **5.4.1** | v2 bump(復習スケジュール核) |
| tw-animate-css | 1.4.0 | — |
| unified | 11.0.5 | remark line の中心 |
| utf-8-validate | 6.0.6 | onlyBuiltDependencies |
| zod | 4.4.1 | v4(migration 完了済) |

### devDependencies (V)

| package | pin | 備考 |
|---|---|---|
| @tailwindcss/postcss | **4.3.3** | tailwindcss と lockstep |
| @testing-library/jest-dom | 6.9.1 | — |
| @testing-library/react | 16.3.2 | — |
| @types/node | 24.13.2 | Node 24 と整合 |
| @types/react | 19.2.17 | react とペア |
| @types/react-dom | 19.2.3 | react とペア |
| @vitejs/plugin-react | 6.0.1 | vite override と関連(台帳) |
| @vitest/coverage-v8 | **4.1.10** | vitest と exact lockstep |
| dotenv | 17.4.2 | — |
| drizzle-kit | 0.31.10 | orm とペア |
| eslint | 9.39.4 | **9 維持**(下記§7) |
| eslint-config-next | 16.2.11 | next と lockstep |
| eslint-plugin-react-hooks | 7.1.1 | direct 化済(drift 事故回避) |
| fake-indexeddb | 6.2.5 | — |
| jsdom | 29.1.1 | — |
| lefthook | 2.1.9 | pre-commit gate |
| tailwindcss | **4.3.3** | postcss と lockstep |
| tsx | **4.23.1** | v2 bump(ops script 実行器) |
| typescript | 6.0.3 | TS6・typescript-eslint range 内 |
| vitest | **4.1.10** | coverage-v8 と exact lockstep |

**lockstep(必須ペア)**: vitest ↔ @vitest/coverage-v8(同版 4.1.10)/ tailwindcss ↔ @tailwindcss/postcss(同版 4.3.3)/ react ↔ react-dom ↔ @types/react ↔ @types/react-dom / drizzle-orm ↔ drizzle-kit / next ↔ eslint-config-next。

**v2 bump 対象(13 件)**: stripe 22.3.2 / svix 1.99.1 / vitest 4.1.10 / @vitest/coverage-v8 4.1.10 / dexie 4.4.4 / ts-fsrs 5.4.1 / radix-ui 1.6.7 / lucide-react 1.26.0 / tailwindcss 4.3.3 / @tailwindcss/postcss 4.3.3 / tailwind-merge 3.6.0 / tsx 4.23.1 / @tanstack/react-virtual 3.14.8。全て major 跨がず・changelog 上明示 breaking なし(Step 0 fact-finding 領域 B)。

---

## 5. 新規 dep 9 件の固定制約(v1.3 未記載・v2 で記録)

| package | 制約 |
|---|---|
| photoswipe | 5.4.4=latest・**6.x のリリース/roadmap 公開情報なし**。`tapAction` の **カスタム関数**は公式 docs 記載の正式サポート値(image-ux2 実装が依拠)。5.x に明示 breaking なし。exact 維持 |
| @tanstack/react-table | 8.21.3=latest。**v9 は alpha/beta のみ = 不採用**(安定優先)。exact 維持 |
| @tanstack/react-virtual | 3.14.8。table v8 と組む現行安定線 |
| aws4fetch | 1.0.20=latest・**2.x なし・ゼロ依存・server 専用**(R2 S3 互換 presigned 署名) |
| react-markdown / remark-gfm / remark-parse / unified | **remark 系 4 点は全 ESM-only・unified 11 line に相互ピン**(react-markdown 10→`remark-parse ^11`/`unified ^11`、remark-gfm 4→`unified ^11`)。**単独 major 昇格は unified 11 line と desync する構造**ゆえ exact 固定。この生態系は major 毎に ESM 化 / Node 要求 / 型・API breaking を伴う実績(react-markdown v7 ESM化・v9 React18必須・v10 className削除 / unified v10 ESM化・v11 Buffer→Uint8Array / remark-gfm v2 ESM化・v4 unified11) |
| shadcn | **CSS `@import "shadcn/tailwind.css"` のみ使用・JS import なし**。CLI は実行時 import されない。4.6.0→4.14.1(minor×8 gap)。bump すると重 transitive(ts-morph / @babel/core / @modelcontextprotocol/sdk / recast / execa 等)を引き brace-expansion の由来を増やすため **bump 保留・現行維持** |

---

## 6. stripe apiVersion(明示 pin しない・根拠)

- `lib/stripe/client.ts:79` は `new Stripe(key, { maxNetworkRetries: 2, timeout: 10000 })` で **`apiVersion` を未指定**。
- **未指定時は SDK が pinned した版を送信する**(v12+ 仕様)。出典 = SDK core `node_modules/stripe/cjs/stripe.core.js:169` = `version: props.apiVersion || DEFAULT_API_VERSION` / `:98` `DEFAULT_API_VERSION = ApiVersion`。この `ApiVersion` は SDK が固定する定数(Dashboard 既定版ではない)。→ Step 0 fact-finding 領域 B① の「不明(SDK pinned か Dashboard 既定か)」は **SDK pinned 版送信**で確定。

### SDK 版 ↔ 送信 apiVersion 対応

| stripe SDK | pinned `Stripe-Version`(送信版) |
|---|---|
| 22.3.2(v2 確定) | **`2026-06-24.dahlia`**(`node_modules/stripe/esm/apiVersion.js` 実測) |
| 22.0.2(v2 前) | `2026-03-25.dahlia`(参考・Step 0) |

- **明示 pin はしない**方針。理由 = 全 direct exact により SDK 版が決定的(22.3.2 固定)ゆえ、送信版も決定的(`2026-06-24.dahlia`)になる。明示 `apiVersion` を足すと「SDK 実装と送信版の二重管理」になり drift 源が増える。SDK bump 時に送信版が変わる点は本表で追跡する。
- **webhook 検証**は送信版に依存しない(署名検証は event payload そのもの)。smoke = webhook/subscription/downgrade 再実行で足りる。
- **OT follow-up**: Stripe Dashboard の webhook endpoint 登録版が SDK 送信版(`2026-06-24.dahlia`)と齟齬ないかの棚卸しは OT のみ可能(Dashboard 確認)。台帳に起票。

---

## 7. ESLint 9 維持の根拠(v2 更新)

**結論: ESLint 9 維持(10 不採用)。10 は現状 upstream で塞がれている。**

- **v1.3 の理由(継続)**: `eslint-config-next@16.2.11` が `dependencies` として抱える 3 plugin(eslint-plugin-react / -import / -jsx-a11y)の peer が `eslint ^10` 未対応。config-next 本体 peer は `>=9.0.0` で解放済だが、同梱 plugin が頭打ち。flat config 化は 9 で達成済。
- **10 が塞がれている実態(v2 追記)**: eslint-plugin-react@7.37.5 は ESLint 10 で `context.getFilename()` 削除により **実行時クラッシュ**(`jsx-eslint/eslint-plugin-react#3977` = **OPEN・未修正**)。eslint core を 10 化しても 3 plugin が `minimatch@3`(→ brace-expansion@1.1.16)を保持するため **v1 線も消えない**(GHSA-mh99 撤去条件は eslint-core bump 単体では不成立)。
- **解除条件(3 つ全部)**: ① config-next 同梱 3 plugin の ESLint 10 peer 対応 ② plugin-react #3977 修正リリース ③ peer override なしで eslint@10 install が成立。→ 台帳「監視(watch)」に ESLint 10 watch として記録。

---

## 8. overrides(現状維持・transitive 管理)

`pnpm-workspace.yaml` の overrides は v2 で不変(矛盾なし・Step 0.5 実証):
`uuid ^14.0.0` / `postcss ^8.5.12`(GHSA-6g55 floor)/ `react 19.2.7` / `react-dom 19.2.7` / `vite 8.0.16`(GHSA-fx2h)/ `sharp ^0.35.0`(GHSA-f88m)。各撤去条件は台帳参照。

---

## OT follow-up(本 sprint 外・OT 作業)

1. **stripe webhook endpoint 版の棚卸し**: Dashboard 登録版 vs SDK 送信版(`2026-06-24.dahlia`)の齟齬確認(台帳に起票済)。
2. **CLAUDE.md audit gate 記述の更新**: 「Sprint 完了 gate(audit gate)」段落が wrapper 化前の旧構造(`check-audit-config.mjs + pnpm audit --audit-level high` / `auditConfig.ignoreGhsas` 受容)のまま stale。§2/§3 の新構造(wrapper / JSON allowlist / auditConfig 全拒否)へ 1 段落更新が要る(constitution ゆえ OT 判断)。tripwire error message が「受容は scripts/audit-allowlist.json のみ」と自己是正するため self-correcting(canonical review Minor)。
