# 依存脆弱性台帳(dependency audit ledger)

**allow-list(`pnpm-workspace.yaml` の `auditConfig.ignoreGhsas`)の用途は「patched 版が存在しない」or「理由ある真の受容」のみ — bump で解消できる検出は受容せず本台帳の「bump 待ち」に置く。**

## 運用(正本 = CLAUDE.md「Sprint 完了 gate」)

- gate = `pnpm run audit`(= `pnpm audit --audit-level critical`)。**二段階制: 現在は critical** — 下記「bump 待ち」16 件の transitive bump sprint(別途)完了を条件に `--audit-level high` へ引き上げる。
- exit code 意味論(pnpm 10.33.0 実測・docs は exit code 無記載): `--audit-level` **以上**の advisory が 1 件でも存在 → exit 1 / 無ければ 0。
- builtin `pnpm audit` は同名 script より優先され level 未指定(low)で走る → gate は必ず `pnpm run audit`。
- `--ignore-registry-errors` は使わない(fail-closed 確定・registry 障害は見えて止まる方を選ぶ)。障害時は約 70 秒+の retry(10s→1min backoff)の後 exit 1 で止まる(実測)— hang ではない。
- CLI `--ignore` flag は **使用禁止**(10.33.0 実測: audit でなく ignore 登録モードで、`pnpm-workspace.yaml` に `auditConfig.ignoreCves` を**無断書込**し、high 残存でも exit 0 を返す = fail-open + 規律外の並行 suppression 経路。書込が commit されると **以後の全 gate 実行で抑止が持続する** — 通常 report 経路も `ignoreCves` を読む・pnpm source 確認済)。受容は必ず `ignoreGhsas` config で行う。**検出規律: `auditConfig` 配下に `ignoreGhsas` 以外の key(`ignoreCves` 等)が現れたら、禁止 `--ignore` 実行の痕跡 = 無許可 suppression として revert し、必要なら `ignoreGhsas` 経路で再登録する。**
- 器の検証注意: `pnpm audit --json` の metadata 件数は **ignore filter 前の値**。`ignoreGhsas` が効いているかは表出力の「(N ignored)」注記と exit code で確認する(実証 2026-07-21: high 15 GHSA 全登録で `--audit-level high` exit 1→0 反転・「16 high (16 ignored)」表示を確認後、空 list へ復元)。
- 記録規律: moderate 以下 = gate 対象外・本台帳に follow-up 記録 / high・critical = 「bump 待ち」記載 or `ignoreGhsas` 追加(追加時は GHSA/CVE・理由・再検討条件をセットで本台帳に記録)。
- 受容エントリ書式: `- GHSA-xxxx(CVE-xxxx)/ module / 理由 / 再検討条件(例: patched 版リリース時・依存元の major 更新時)`

## 受容済(ignoreGhsas 登録済)

(なし — 初期状態。登録時は上記書式で追記)

## スナップショット(2026-07-21・`pnpm audit` 全 48 advisories: high 16 / moderate 26 / low 6)

high 16 件は **bump 待ち**(全て transitive・patched 版リリース済・受容ではない)。bump sprint で解消後、gate を high へ引き上げ、本 section を更新する。

### critical(0 件)

(なし)

### high(16 件)

| module | GHSA | CVE | vulnerable | patched | 経路(代表) |
|---|---|---|---|---|---|
| brace-expansion | GHSA-3jxr-9vmj-r5cp | CVE-2026-13149 | `<1.1.16` | `>=1.1.16` | `.>eslint>minimatch>brace-expansion` |
| brace-expansion | GHSA-3jxr-9vmj-r5cp | CVE-2026-13149 | `>=3.0.0 <5.0.7` | `>=5.0.7` | `.>eslint-config-next>eslint-plugin-import>@typescript-eslint/parser>@typescript-eslint/typescript-estree>minimatch>brace-expansion` |
| fast-uri | GHSA-q3j6-qgpj-74h6 | CVE-2026-6321 | `<=3.1.0` | `>=3.1.1` | `.>@google/genai>@modelcontextprotocol/sdk>ajv>fast-uri` |
| fast-uri | GHSA-v39h-62p7-jpjc | CVE-2026-6322 | `<=3.1.1` | `>=3.1.2` | `.>@google/genai>@modelcontextprotocol/sdk>ajv>fast-uri` |
| hono | GHSA-88fw-hqm2-52qc | CVE-2026-54290 | `<4.12.25` | `>=4.12.25` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| js-yaml | GHSA-52cp-r559-cp3m | CVE-2026-59869 | `>=4.0.0 <4.3.0` | `>=4.3.0` | `.>eslint>@eslint/eslintrc>js-yaml` |
| protobufjs | GHSA-66ff-xgx4-vchm | CVE-2026-44293 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-685m-2w69-288q | CVE-2026-44289 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-75px-5xx7-5xc7 | CVE-2026-44291 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-jvwf-75h9-cwgg | CVE-2026-44290 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-wcpc-wj8m-hjx6 | CVE-2026-48712 | `<=7.6.0` | `>=7.6.1` | `.>@google/genai>protobufjs` |
| undici | GHSA-hm92-r4w5-c3mj | CVE-2026-6734 | `>=7.23.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |
| undici | GHSA-vmh5-mc38-953g | CVE-2026-9697 | `>=7.23.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |
| undici | GHSA-vxpw-j846-p89q | CVE-2026-12151 | `>=7.0.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |
| vite | GHSA-fx2h-pf6j-xcff | CVE-2026-53571 | `>=8.0.0 <=8.0.15` | `>=8.0.16` | `.>@vitejs/plugin-react>vite` |
| ws | GHSA-96hv-2xvq-fx4p | CVE-2026-48779 | `>=8.0.0 <8.21.0` | `>=8.21.0` | `.>@google/genai>ws` |

### moderate(26 件)

| module | GHSA | CVE | vulnerable | patched | 経路(代表) |
|---|---|---|---|---|---|
| @protobufjs/utf8 | GHSA-q6x5-8v7m-xcrf | CVE-2026-44288 | `<=1.1.0` | `>=1.1.1` | `.>@google/genai>protobufjs>@protobufjs/utf8` |
| brace-expansion | GHSA-jxxr-4gwj-5jf2 | CVE-2026-45149 | `>=5.0.0 <5.0.6` | `>=5.0.6` | `.>eslint-config-next>eslint-plugin-import>@typescript-eslint/parser>@typescript-eslint/typescript-estree>minimatch>brace-expansion` |
| esbuild | GHSA-67mh-4wv8-2f99 | - | `<=0.24.2` | `>=0.25.0` | `.>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild` |
| hono | GHSA-2gcr-mfcq-wcc3 | CVE-2026-47676 | `<4.12.21` | `>=4.12.21` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-3hrh-pfw6-9m5x | CVE-2026-47675 | `<4.12.21` | `>=4.12.21` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-f577-qrjj-4474 | CVE-2026-47673 | `<4.12.21` | `>=4.12.21` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-j6c9-x7qj-28xf | CVE-2026-54287 | `<4.12.25` | `>=4.12.25` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-p77w-8qqv-26rm | CVE-2026-44457 | `<4.12.18` | `>=4.12.18` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-qp7p-654g-cw7p | CVE-2026-44458 | `<4.12.18` | `>=4.12.18` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-rv63-4mwf-qqc2 | CVE-2026-54288 | `<4.12.25` | `>=4.12.25` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-wgpf-jwqj-8h8p | CVE-2026-54289 | `<4.12.25` | `>=4.12.25` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-wwfh-h76j-fc44 | CVE-2026-54286 | `<4.12.25` | `>=4.12.25` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| hono | GHSA-xrhx-7g5j-rcj5 | CVE-2026-47674 | `<4.12.21` | `>=4.12.21` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| ip-address | GHSA-v2v4-37r5-5v8g | CVE-2026-42338 | `<=10.1.0` | `>=10.1.1` | `.>@google/genai>@modelcontextprotocol/sdk>express-rate-limit>ip-address` |
| js-yaml | GHSA-h67p-54hq-rp68 | CVE-2026-53550 | `>=4.0.0 <=4.1.1` | `>=4.2.0` | `.>eslint>@eslint/eslintrc>js-yaml` |
| protobufjs | GHSA-2pr8-phx7-x9h3 | CVE-2026-44294 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-f38q-mgvj-vph7 | CVE-2026-54269 | `<=7.6.2` | `>=7.6.3` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-fx83-v9x8-x52w | CVE-2026-44292 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-j3f2-48v5-ccww | CVE-2026-59877 | `>=7.5.0 <=7.6.4` | `>=7.6.5` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-jggg-4jg4-v7c6 | CVE-2026-45740 | `<=7.5.7` | `>=7.5.8` | `.>@google/genai>protobufjs` |
| protobufjs | GHSA-q6x5-8v7m-xcrf | CVE-2026-44288 | `<=7.5.5` | `>=7.5.6` | `.>@google/genai>protobufjs` |
| qs | GHSA-q8mj-m7cp-5q26 | CVE-2026-8723 | `>=6.11.1 <=6.15.1` | `>=6.15.2` | `.>@google/genai>@modelcontextprotocol/sdk>express>qs` |
| undici | GHSA-p88m-4jfj-68fv | CVE-2026-9679 | `>=7.0.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |
| undici | GHSA-pr7r-676h-xcf6 | CVE-2026-9678 | `>=7.0.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |
| vite | GHSA-v6wh-96g9-6wx3 | CVE-2026-53632 | `>=8.0.0 <=8.0.15` | `>=8.0.16` | `.>@vitejs/plugin-react>vite` |
| ws | GHSA-58qx-3vcg-4xpx | CVE-2026-45736 | `>=8.0.0 <8.20.1` | `>=8.20.1` | `.>@google/genai>ws` |

### low(6 件)

| module | GHSA | CVE | vulnerable | patched | 経路(代表) |
|---|---|---|---|---|---|
| @babel/core | GHSA-4x5r-pxfx-6jf8 | CVE-2026-49356 | `<=7.29.0` | `>=7.29.6` | `.>eslint-plugin-react-hooks>@babel/core` |
| body-parser | GHSA-v422-hmwv-36x6 | CVE-2026-12590 | `>=2.0.0 <2.3.0` | `>=2.3.0` | `.>@google/genai>@modelcontextprotocol/sdk>express>body-parser` |
| esbuild | GHSA-g7r4-m6w7-qqqr | - | `>=0.27.3 <0.28.1` | `>=0.28.1` | `.>@vitejs/plugin-react>vite>esbuild` |
| hono | GHSA-hm8q-7f3q-5f36 | CVE-2026-44459 | `<4.12.18` | `>=4.12.18` | `.>@google/genai>@modelcontextprotocol/sdk>hono` |
| undici | GHSA-35p6-xmwp-9g52 | CVE-2026-6733 | `>=7.0.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |
| undici | GHSA-g8m3-5g58-fq7m | CVE-2026-11525 | `>=7.0.0 <7.28.0` | `>=7.28.0` | `.>jsdom>undici` |

