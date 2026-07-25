# 依存脆弱性台帳(dependency audit ledger)

**受容 allow-list(`scripts/audit-allowlist.json`・wrapper `scripts/audit-gate.mjs` 管理・2026-07-25 matrix v2 で pnpm `auditConfig.ignoreGhsas` から移行)の用途は「patched 版が存在しない」or「理由ある真の受容」のみ — bump で解消できる検出は受容せず本台帳の「bump 待ち」に置く。受容は dev scope 限定(prod は allowlist 不適用 = high/critical で無条件 fail)。**

## 運用(正本 = CLAUDE.md「Sprint 完了 gate」)

- gate = `pnpm run audit`(= wrapper `scripts/audit-gate.mjs`)。**2026-07-25 の deps 再基線 sprint(matrix v2)で wrapper 化**(旧: `check-audit-config.mjs && pnpm audit --audit-level high`)。wrapper は prod/dev を別実行し、**prod = high/critical 1 件でも fail(allowlist 不適用)/ dev = `scripts/audit-allowlist.json` と version-aware 照合**。fail-closed(exit code 整合 + JSON.parse + 期待構造)を pass 判定前に検証。tripwire(`check-audit-config.mjs` の `checkAuditConfig`)は wrapper 冒頭で継続実行。閾値は high 据え置き(二段階制は 2026-07-21 で high へ引き上げ済・下記「解消済」)。詳細構造 = matrix v2 doc。
- **受容の唯一の置き場 = `scripts/audit-allowlist.json`**(pnpm の `auditConfig.ignoreGhsas` は撤去済)。追加/変更時は GHSA/CVE・理由・再検討条件を本台帳にセット記録し、allowlist JSON にエントリ(ghsa + module + vulnerableRange + expiry + path)を追加する。`pnpm-workspace.yaml` に `auditConfig` を置くと pnpm が wrapper へ渡す前に advisory を沈黙 filter するため置かない。
- 規律外 suppression 検査は機械化済: `check-audit-config.mjs`(wrapper 冒頭で実行)が `pnpm-workspace.yaml` に `auditConfig` 行(`ignoreGhsas`/`ignoreCves` いずれも)を検出したら非0 で gate を落とす(受容は JSON allowlist のみ・下記 `--ignore` 禁止の機械的裏付け)。**2026-07-25 に旧 `ignoreGhsas` whitelist を撤去し auditConfig 全拒否へ変更**(受容が JSON へ移行し auditConfig が用途を失ったため。pnpm は auditConfig を wrapper へ渡す前に advisory を沈黙 filter する)。
- exit code 意味論(pnpm 10.33.0 実測・docs は exit code 無記載): `--audit-level` **以上**の advisory が 1 件でも存在 → exit 1 / 無ければ 0。
- builtin `pnpm audit` は同名 script より優先され level 未指定(low)で走る → gate は必ず `pnpm run audit`。
- `--ignore-registry-errors` は使わない(fail-closed 確定・registry 障害は見えて止まる方を選ぶ)。障害時は約 70 秒+の retry(10s→1min backoff)の後 exit 1 で止まる(実測)— hang ではない。
- CLI `--ignore` flag は **使用禁止**(10.33.0 実測: audit でなく ignore 登録モードで、`pnpm-workspace.yaml` に `auditConfig.ignoreCves` を**無断書込**し、high 残存でも exit 0 を返す = fail-open + 規律外の並行 suppression 経路。書込が commit されると **以後の全 gate 実行で抑止が持続する** — 通常 report 経路も `ignoreCves` を読む・pnpm source 確認済)。受容は必ず `scripts/audit-allowlist.json` で行う(pnpm の `auditConfig` は使わない)。**検出規律: `pnpm-workspace.yaml` に `auditConfig`(`ignoreCves`/`ignoreGhsas` 等)が現れたら、禁止 `--ignore` 実行 or silent-filter 迂回の痕跡 = 無許可 suppression として revert し、必要なら JSON allowlist で再登録する。**
- 器の検証注意: `pnpm audit --json` の metadata 件数は **ignore filter 前の値**。`ignoreGhsas` が効いているかは表出力の「(N ignored)」注記と exit code で確認する(実証 2026-07-21: high 15 GHSA 全登録で `--audit-level high` exit 1→0 反転・「16 high (16 ignored)」表示を確認後、空 list へ復元)。
- 記録規律: moderate 以下 = gate 対象外・本台帳に follow-up 記録 / high・critical = 「bump 待ち」記載 or `scripts/audit-allowlist.json` へ dev エントリ追加(追加時は GHSA/CVE・理由・再検討条件をセットで本台帳に記録・prod は allowlist 不適用ゆえ受容不可)。
- 受容エントリ書式: `- GHSA-xxxx(CVE-xxxx)/ module / 理由 / 再検討条件(例: patched 版リリース時・依存元の major 更新時)`

## 受容済(allowlist 登録済 = `scripts/audit-allowlist.json`)

- **GHSA-mh99-v99m-4gvg(CVE-2026-14257・High・brace-expansion OOM 型 DoS)** / module = brace-expansion / **受容経路 = `eslint@9 → minimatch@3 → brace-expansion@1.1.16`(dev 依存のみ)** / **受容根拠** = v1 系に patched backport が存在しない(patched=5.0.8=v5 のみ・1.1.16 が v1 最新で affected)+ override で 5.0.8 へ強制すると minimatch@3(CJS default `require()` を期待)を壊す(brace-expansion@5 は named export・`TypeError: expand is not a function` を実証)+ build/lint 時 tooling のみで runtime / client bundle 非混入 + glob 入力は repo 管理の config 由来で攻撃者制御なし(`pnpm audit --prod` で high 0 = prod 非波及を実証)/ **再検討条件** = ①v1 系への公式 backport 公開 ②ESLint 10 移行完了(v1 線が構造的に消える→ allowlist エントリ削除)③新経路から同 GHSA 該当が入った場合 / **再検討期限 = 2026-08-22(4 週間)または deps 再基線 sprint 完了の早い方**。
  - **管理方式の移行(2026-07-25 matrix v2)**: 本受容は pnpm の `auditConfig.ignoreGhsas` から **wrapper 管理の `scripts/audit-allowlist.json`** へ移行済(エントリ = `GHSA-mh99-v99m-4gvg` / brace-expansion / **`vulnerableRange <2.0.0`** / `expiry 2026-08-22` / path=eslint plugin 系 dev)。移行の実利 = **① version-aware 照合**(`findings[].version` が `<2.0.0` 内のものだけ受容 → patched への道がある版が同 GHSA を別経路で踏んでも自動受容しない=名前一致 false-positive の排除)**② dev 限定**(prod は allowlist 不適用ゆえ、この受容が公開面へ波及した瞬間 gate が落ちる)**③ expiry 全 entry 無条件強制**(2026-08-22 経過で advisory 未検出でも自動 fail=台帳テキスト運用だった期限が機械強制になる)。
  - **受容範囲 = `<2.0.0`(v1 系)の根拠(2026-07-25 OT 裁定・Codex r4 P1 対応)**: allowlist の `vulnerableRange` は advisory の affected 範囲(`<=5.0.7`)の**転記ではなく『受容している現物の系列』**を書く。本件の受容根拠は「**v1 系に patched 版が存在しない**」ことゆえ、受容範囲も v1 系(`<2.0.0`)と一対一。v2〜5.0.7 は patched(5.0.8=v5)への道がある版で、新規混入したら **fail させて bump 誘導**するのが正しい挙動(初期案 `<=5.0.7` は affected 転記で over-accept だった)。`=1.1.16` まで絞らないのは、backport 無しのまま v1 系の新 patch(例 1.1.17)が出る可能性があり(1.1.14→1.1.16 実績)その都度 allowlist を触ると version-aware の利点を損なうため — **『patched 不在の系列』単位で受容**する。**path 照合は不採用**(依存木の良性再構成で path が変わり誤 fail する brittleness)— 経路は記述フィールドに留め照合キーにしない。
  - **残余リスク(明記・移行後）**: version-aware かつ dev 限定・v1 線限定になり、旧 `ignoreGhsas`(advisory 単位・経路非依存・prod/dev 無差別)の残余は大幅縮小。残る過受容は「`<2.0.0` の v1 版が eslint 以外の dev 経路から入った場合も同エントリで受容」— ただし v1 系は patched 不在ゆえ経路が変わっても受容根拠(bump 先が無い)は不変で、実害は dev tooling(repo 管理 glob 入力)に限定。詳細 = 下記「解消+受容(2026-07-25)」。

## 監視(watch・受容でなく解除条件付きの棚卸し対象)

- **ESLint 10 移行 watch(2026-07-25 新設)**: 上記 GHSA-mh99 の v1(eslint)線が構造的に消える契機。**現状 ESLint 10 は塞がれている** — `eslint-config-next@16.2.11` が `dependencies` として抱える 3 plugin(eslint-plugin-react / -import / -jsx-a11y)の peer が `^10` 未対応で、うち **eslint-plugin-react@7.37.5 は ESLint 10 で `context.getFilename()` 削除により実行時クラッシュ**(`jsx-eslint/eslint-plugin-react#3977` = **OPEN・未修正**)。eslint core 単体を 10 化しても 3 plugin が `minimatch@3`(→ brace-expansion@1.1.16)を保持するため **v1 線は消えない**(GHSA-mh99 撤去条件は eslint-core bump 単体では不成立)。**解除条件(3 つ全部)** = ① config-next 同梱 3 plugin の ESLint 10 peer 対応 ② plugin-react #3977 修正リリース ③ peer override なしで eslint@10 install が成立。達成時に eslint 10 移行 → GHSA-mh99 allowlist エントリ削除を検討。出典 = Step0 factfinding `docs/audit/2026-07-25-deps-rebaseline-matrix-v2-step0-factfinding.md` 領域 A。
- **pnpm 11 audit endpoint 移行 watch(2026-07-25 新設)**: pnpm 11 で audit の registry endpoint / 出力仕様が変わる可能性。wrapper(`scripts/audit-gate.mjs`)は `pnpm audit --prod/--dev --audit-level high --json` の出力構造(`advisories` map / `metadata.vulnerabilities.high|critical` / `findings[].version`)+ exit code(0/1)に依存するため、pnpm 11 bump 時は wrapper の fail-closed 検証(期待構造)が正しく働くか再確認する。現状 pnpm 10.33.0。

## 解消済(2026-07-21 transitive bump sprint)

high 16 行(unique 15 GHSA)を range 内 lockfile 更新(`pnpm update` 名前指定・`--depth` 既定 Infinity)+ vite のみ override で解消。**到達版**: brace-expansion `1.1.16`/`5.0.7`・fast-uri `3.1.4`・hono `4.12.31`・js-yaml `4.3.0`・protobufjs `7.6.5`・undici `7.28.0`・vite `8.0.16`(override)・ws `8.21.1`。直接依存の版・package.json は不変。随伴解消: moderate 26→3・low 6→3。個別 GHSA は下記 bump 前 snapshot の high 表を参照。

- **vite override(撤去条件付き)**: GHSA-fx2h-pf6j-xcff。vite は宣言 range 内(vitest `^6||^7||^8` / plugin-react peer `^8.0.0`)だが、pnpm 10.33.0 の `pnpm update` は peer-suffix 付き transitive(lockfile key `vite@x.y.z(...)`)を更新しない(名前指定・`vite@^8.0.16` range 指定・`--depth Infinity`・`-r` 全て実測不発)ため、overrides で `8.0.16` に exact 固定。**撤去条件 = vitest / @vitejs/plugin-react の直接 bump 時に override を外し、override 無しで `>=8.0.16` が解決されることを `pnpm why vite` で確認して撤去**(pnpm 側の当該 update 挙動が直った場合も同様)。**固定版に新規 vite CVE が出た場合は撤去でなく override 値を当該 patched 版へ bump する**(override は解決の固定であり検出の抑止ではない — gate は override 下でも検出する)。

## 解消済(2026-07-23 next+sharp 先行 bump)

**記録 gap の是正**: 下記 high 5 は 2026-07-22(画像表示 UX sprint の PhotoSwipe de-risk で `pnpm run audit` 実行時)に検出されていたが **本台帳に未記載だった**(検出→未記録の gap)。2026-07-23 に bump と合わせて記載・解消し、検出→対応→解消の履歴を残す。

- **対応**: next `16.2.9→16.2.11`(直接依存・package.json exact)+ eslint-config-next lockstep `16.2.11` + **sharp override `^0.35.0`(→ 0.35.3 解決)**。sharp は next の `optionalDependencies.sharp: ^0.34.5` 由来 transitive で、**next 16.2.11 も optional 範囲が ^0.34.5 のまま → next bump では 0.34.5 に留まる → override で patched 化**(撤去条件 = next の optional.sharp が >=0.35.0 に上がった時点)。
- **結果**: audit **high 5→0**・随伴 moderate 9→4・6 gate(lint/typecheck/build/test/test:iso/audit/frozen install)green。react/react-dom は要求不変ゆえ override 据え置き(実測)。
- **波3 は未実施**(gate は high 通過ゆえ不要・変更源分離のため据え置き。実施可否は別途)。

| module | GHSA(概要) | vulnerable | patched | 到達版 | 経路 |
|---|---|---|---|---|---|
| next | GHSA-6gpp-xcg3-4w24(Proxy/Middleware bypass) | `>=16.0.0 <16.2.11` | `>=16.2.11` | 16.2.11 | `.>next`(直接) |
| next | GHSA-m99w-x7hq-7vfj(DoS・Server Actions) | `>=16.0.0 <16.2.11` | `>=16.2.11` | 16.2.11 | `.>next` |
| next | GHSA-89xv-2m56-2m9x(SSRF・Server Actions) | `>=16.0.0 <16.2.11` | `>=16.2.11` | 16.2.11 | `.>next` |
| next | GHSA-p9j2-gv94-2wf4(SSRF・rewrites) | `>=16.0.0 <16.2.11` | `>=16.2.11` | 16.2.11 | `.>next` |
| sharp | GHSA-f88m-g3jw-g9cj(libvips 継承) | `<0.35.0` | `>=0.35.0` | 0.35.3(override) | `.>next>sharp`(next optional 由来) |

> **残存 follow-up 更新(2026-07-23)**: 現況 moderate 4 / low 3(gate 対象外)。下記「残存 follow-up(2026-07-21)」表からの差分は新規 advisory 随伴ゆえ個別再掲は省略(gate は high ゆえ非対象・次回 bump sprint で拾う)。

## 解消済(2026-07-24 postcss floor 引き上げ)

- **対応**: postcss override を **floor 引き上げ** `^8.5.10 → ^8.5.12`(exact pin でなく caret 下限のみ上げ)。既存 caret は宣言 range 上 patched を許容するが、lockfile が `@tailwindcss/postcss` + `shadcn` 経由で 8.5.10 に **stale pin**(pnpm は宣言 range 内の古い lock を `install` で bump しない = vite の peer-suffix 知見と同族の「範囲満足ゆえ据え置き」)→ floor を patched 以上に上げて再解決を強制し、全消費側を postcss@8.5.21 に単一化。**新規 override 追加でなく既存 override の floor 引き上げが正**(next/vite 側は先行 bump で既に 8.5.21・古いのは tailwind/shadcn subtree のみだった)。撤去条件 = 全消費側が >=8.5.12 を自然解決した時点(override 無しで `pnpm why postcss` が >=8.5.12 単一を示す)。floor 固定ゆえ将来 patch は自然追従。
- **結果**: audit **high 1→0**・随伴 moderate/low 不変(4 mod / 3 low・gate 対象外)。lockfile 差分は postcss + orphan `nanoid@3.3.11` の dedupe のみ(直接依存・他 override 不変)。postcss は build 経路専用(app/lib/components に import なし・client bundle 非混入を build 出力で確認)。commit `fc7ce57`。
- gate: frozen install / lint / typecheck / build / test / test:iso + audit 全 green(unit 3889 / iso 217)。

| module | GHSA(概要) | vulnerable | patched | 到達版 | 経路 |
|---|---|---|---|---|---|
| postcss | GHSA-6g55-p6wh-862q(sourceMappingURL 経由の任意ファイル読取・情報漏洩) | `<=8.5.11` | `>=8.5.12` | 8.5.21(override floor) | `.>@tailwindcss/postcss>postcss`(+ `.>shadcn>postcss`) |

## 解消+受容(2026-07-25 brace-expansion 新 advisory)

**GHSA-mh99-v99m-4gvg / CVE-2026-14257**(High・CVSS 7.5・2026-07-23 公開・brace 展開の総長無制限による OOM 型リソース枯渇 DoS。ReDoS ではない)。affected `<=5.0.7` / patched は **5.0.8 のみ**(v1 系 backport 無し)。**別 advisory GHSA-f886-m6hf-6m8v(v1.1.13 backport 済)とは別物**。tree に 2 版並存で high ×2 検出。

- **v5 線 = 実 patch(5.0.8)**: `brace-expansion@5.0.7` ← `minimatch@10.2.5`(`^5.0.5`)← typescript-estree / ts-morph(shadcn)。`pnpm update brace-expansion` で range 内 5.0.7→5.0.8。
- **v1 線 = ignoreGhsas 受容**: `brace-expansion@1.1.16` ← `minimatch@3.1.5`(`^1.1.7`)← `@eslint/config-array` ← eslint@9。v1 patch 無し + 5.0.8 強制は eslint 破綻(named export 非互換・実証)ゆえ受容(詳細・根拠・再検討条件・期限は上記「受容済」参照)。
- **随伴(scope 注記)**: v5 の再解決に伴い **`vite@8.0.16` subtree の nested postcss が `8.5.21→8.5.23`**(lockfile に新規 entry)。**`@tailwindcss/postcss@4.2.4` / `shadcn@4.6.0` 側の postcss は `8.5.21` 据え置き**(= 元は両 subtree が 8.5.21 で dedup されていたのが部分的に分離。`pnpm why postcss` で確認)。override `^8.5.12` caret 配下ゆえ再解決時に vite subtree が最新 patch を拾い、`pnpm update brace-expansion`(targeted)でも回避不能。patched line 内の benign な patch refresh(postcss は GHSA-6g55 対処済 line の前進)。pin 回避は postcss override 変更=別 scope creep ゆえ受容。
- gate: install --frozen-lockfile / lint / typecheck / build / test(3892)/ test:iso(217)/ `pnpm run audit` exit0 全 green。**`pnpm audit --prod` = high 0**(prod 依存に本件非波及の証明)。ignore は「1 high (1 ignored)」で確認。

## 残存 follow-up(2026-07-21 bump 後・gate 対象外)

### moderate(3 件)

| module | GHSA | CVE | vulnerable | patched | 経路(代表) |
|---|---|---|---|---|---|
| esbuild | GHSA-67mh-4wv8-2f99 | - | `<=0.24.2` | `>=0.25.0` | `.>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild` |
| ip-address | GHSA-v2v4-37r5-5v8g | CVE-2026-42338 | `<=10.1.0` | `>=10.1.1` | `.>@google/genai>@modelcontextprotocol/sdk>express-rate-limit>ip-address` |
| qs | GHSA-q8mj-m7cp-5q26 | CVE-2026-8723 | `>=6.11.1 <=6.15.1` | `>=6.15.2` | `.>@google/genai>@modelcontextprotocol/sdk>express>qs` |

### low(3 件)

| module | GHSA | CVE | vulnerable | patched | 経路(代表) |
|---|---|---|---|---|---|
| @babel/core | GHSA-4x5r-pxfx-6jf8 | CVE-2026-49356 | `<=7.29.0` | `>=7.29.6` | `.>eslint-plugin-react-hooks>@babel/core` |
| body-parser | GHSA-v422-hmwv-36x6 | CVE-2026-12590 | `>=2.0.0 <2.3.0` | `>=2.3.0` | `.>@google/genai>@modelcontextprotocol/sdk>express>body-parser` |
| esbuild | GHSA-g7r4-m6w7-qqqr | - | `>=0.27.3 <0.28.1` | `>=0.28.1` | `.>@vitejs/plugin-react>vite>esbuild` |

## スナップショット(2026-07-21 bump 前・全 48 advisories: high 16 / moderate 26 / low 6)

履歴として保持(high 16 は上記「解消済」で解消済・moderate/low の大半も随伴解消。現況は上記「残存 follow-up」が正)。

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

