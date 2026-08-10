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
- **scope(prod / dev)の増減を測る基準 = `pnpm-lock.yaml` からの推移閉包**(2026-08-06 T3 制定)。`importers['.']` の各群を根に `snapshots[].dependencies / optionalDependencies` を辿り `name@版`(peer suffix 除去)へ正規化して数える。**`pnpm ls --dev` の件数や `pnpm audit --json` の `metadata.totalDependencies` と混ぜない**(基準が違い、同じ表に並べると存在しない矛盾を生む)。scope 移動を主張する時は **① prod 離脱 ② prod 流入 ③ 離脱のうち既に dev 到達可 ④ 離脱のうち dev 新規 ⑤ prod 残留のまま dev 経路も得た数** の 5 値を出す(全 package が両側で説明でき、**advisory が動かなくても成立する**)。

## 受容済(allowlist 登録済 = `scripts/audit-allowlist.json`)

**現在ゼロ件**(`entries: []`)。唯一の受容だった GHSA-mh99-v99m-4gvg は **2026-08-06 の deps 基線更新 T1 で撤去**(上流が v1 系 backport `1.1.17` を公開し受容根拠が失効)。撤去の判断と履歴は下記「解消済(2026-08-06 deps 基線更新 T1)」へ移設。

<details><summary>撤去前の受容記録(2026-07-25〜2026-08-06・allowlist の設計根拠を含むため保存)</summary>

- **GHSA-mh99-v99m-4gvg(CVE-2026-14257・High・brace-expansion OOM 型 DoS)** / module = brace-expansion / **受容経路 = `eslint@9 → minimatch@3 → brace-expansion@1.1.16`(dev 依存のみ)** / **受容根拠** = v1 系に patched backport が存在しない(patched=5.0.8=v5 のみ・1.1.16 が v1 最新で affected)+ override で 5.0.8 へ強制すると minimatch@3(CJS default `require()` を期待)を壊す(brace-expansion@5 は named export・`TypeError: expand is not a function` を実証)+ build/lint 時 tooling のみで runtime / client bundle 非混入 + glob 入力は repo 管理の config 由来で攻撃者制御なし(`pnpm audit --prod` で high 0 = prod 非波及を実証)/ **再検討条件** = ①v1 系への公式 backport 公開 ②ESLint 10 移行完了(v1 線が構造的に消える→ allowlist エントリ削除)③新経路から同 GHSA 該当が入った場合 / **再検討期限 = 2026-08-22(4 週間)または deps 再基線 sprint 完了の早い方**。
  - **管理方式の移行(2026-07-25 matrix v2)**: 本受容は pnpm の `auditConfig.ignoreGhsas` から **wrapper 管理の `scripts/audit-allowlist.json`** へ移行済(エントリ = `GHSA-mh99-v99m-4gvg` / brace-expansion / **`vulnerableRange <2.0.0`** / `expiry 2026-08-22` / path=eslint plugin 系 dev)。移行の実利 = **① version-aware 照合**(`findings[].version` が `<2.0.0` 内のものだけ受容 → patched への道がある版が同 GHSA を別経路で踏んでも自動受容しない=名前一致 false-positive の排除)**② dev 限定**(prod は allowlist 不適用ゆえ、この受容が公開面へ波及した瞬間 gate が落ちる)**③ expiry 全 entry 無条件強制**(2026-08-22 経過で advisory 未検出でも自動 fail=台帳テキスト運用だった期限が機械強制になる)。
  - **受容範囲 = `<2.0.0`(v1 系)の根拠(2026-07-25 OT 裁定・Codex r4 P1 対応)**: allowlist の `vulnerableRange` は advisory の affected 範囲(`<=5.0.7`)の**転記ではなく『受容している現物の系列』**を書く。本件の受容根拠は「**v1 系に patched 版が存在しない**」ことゆえ、受容範囲も v1 系(`<2.0.0`)と一対一。v2〜5.0.7 は patched(5.0.8=v5)への道がある版で、新規混入したら **fail させて bump 誘導**するのが正しい挙動(初期案 `<=5.0.7` は affected 転記で over-accept だった)。`=1.1.16` まで絞らないのは、backport 無しのまま v1 系の新 patch(例 1.1.17)が出る可能性があり(1.1.14→1.1.16 実績)その都度 allowlist を触ると version-aware の利点を損なうため — **『patched 不在の系列』単位で受容**する。**path 照合は不採用**(依存木の良性再構成で path が変わり誤 fail する brittleness)— 経路は記述フィールドに留め照合キーにしない。
  - **残余リスク(明記・移行後）**: version-aware かつ dev 限定・v1 線限定になり、旧 `ignoreGhsas`(advisory 単位・経路非依存・prod/dev 無差別)の残余は大幅縮小。残る過受容は「`<2.0.0` の v1 版が eslint 以外の dev 経路から入った場合も同エントリで受容」— ただし v1 系は patched 不在ゆえ経路が変わっても受容根拠(bump 先が無い)は不変で、実害は dev tooling(repo 管理 glob 入力)に限定。詳細 = 下記「解消+受容(2026-07-25)」。

</details>

## 監視(watch・受容でなく解除条件付きの棚卸し対象)

- **ESLint 10 移行 watch(2026-07-25 新設)**: 上記 GHSA-mh99 の v1(eslint)線が構造的に消える契機。**現状 ESLint 10 は塞がれている** — `eslint-config-next@16.2.11` が `dependencies` として抱える 3 plugin(eslint-plugin-react / -import / -jsx-a11y)の peer が `^10` 未対応で、うち **eslint-plugin-react@7.37.5 は ESLint 10 で `context.getFilename()` 削除により実行時クラッシュ**(`jsx-eslint/eslint-plugin-react#3977` = **OPEN・未修正**)。eslint core 単体を 10 化しても 3 plugin が `minimatch@3`(→ brace-expansion@1.1.16)を保持するため **v1 線は消えない**(GHSA-mh99 撤去条件は eslint-core bump 単体では不成立)。**解除条件(3 つ全部)** = ① config-next 同梱 3 plugin の ESLint 10 peer 対応 ② plugin-react #3977 修正リリース ③ peer override なしで eslint@10 install が成立。達成時に eslint 10 移行 → GHSA-mh99 allowlist エントリ削除を検討。出典 = Step0 factfinding `docs/audit/2026-07-25-deps-rebaseline-matrix-v2-step0-factfinding.md` 領域 A。**2026-08-06 更新: GHSA-mh99 の allowlist エントリは上流の v1 backport(1.1.17)到達により先に撤去済** — 本 watch の動機から「受容の解除」は外れた(v1 線は現在 `brace-expansion@1.1.18` = patched で audit 上無害)。watch は **eslint 10 移行の可否そのもの**として存続させる(3 plugin の peer 未対応は未解消)。
- **allowlist 照合機構の無稼働 watch(2026-08-06 新設)**: 受容が `entries: []` になったことで、`scripts/audit-gate.mjs` の **受容側経路**(`loadAllowlist` の必須 field 検証 / `satisfiesRange` の version-aware 照合 / expiry 判定)が **gate 実行で一度も通らなくなった**。従来は唯一の live entry が毎回この経路を通していた。安全側の性質は不変(entry 無しは fail-closed = 未受容 high で落ちる)だが、**expiry 判定だけは腐ると fail-open 方向**(受容が無期限に延命する側)であり、次に誰かが entry を追加するまで劣化が検出されない。これらの helper は未 export ゆえ単体 test も無い(`check-audit-config.test.ts` は tripwire のみ)。**解除条件** = helper を export して fixture 駆動の unit test で pin する(別 task・T1 scope 外)。
- ~~**prod audit scope の縮小余地 watch(2026-08-06 新設)**: `shadcn@4.6.0` が `dependencies` に置かれ、配下が prod audit scope に入っている~~ → **2026-08-06 T3 で実施済**(下記「分類是正(2026-08-06 deps 基線更新 T3)」)。起票時の見立て「brace-expansion@5 系列は devDependencies へ移せば prod 面から構造的に消える」は実測で成立(prod から 201 package が離脱)。ただし**同時に見込んでいた「prod advisory が減る」は成立しなかった** — 現 prod advisory 6 件は shadcn 非依存の経路(`@google/genai` / `next`)からも到達するため。詳細は当該節。
- **pnpm 11 audit endpoint 移行 watch(2026-07-25 新設)**: pnpm 11 で audit の registry endpoint / 出力仕様が変わる可能性。wrapper(`scripts/audit-gate.mjs`)は `pnpm audit --prod/--dev --audit-level high --json` の出力構造(`advisories` map / `metadata.vulnerabilities.high|critical` / `findings[].version`)+ exit code(0/1)に依存するため、pnpm 11 bump 時は wrapper の fail-closed 検証(期待構造)が正しく働くか再確認する。現状 pnpm 10.33.0。

## OT 作業(CC 不可・棚卸し起票)

- **stripe webhook endpoint 版の棚卸し(2026-07-25 起票・OT のみ)**: stripe SDK 22.3.2 は apiVersion 未指定ゆえ SDK pinned 版 `2026-06-24.dahlia` を送信する(matrix v2 §6・SDK core 実測)。Stripe Dashboard の webhook endpoint 登録版がこの送信版と齟齬ないか確認は **Dashboard アクセスが要るため OT のみ可能**。齟齬時の影響は限定的(webhook 署名検証は送信版非依存)だが、API 応答 shape の差を避けるため棚卸し推奨。

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

## 解消済(2026-08-06 deps 基線更新 T1)

経緯と一般化した教訓は `docs/superpowers/sessions/2026-08-06-deps-baseline-update.md`。本節は **audit 上の事実**(GHSA / 範囲 / 到達版 / 受容判断)を持つ。

high 7 件(prod 3 / dev 3 + allowlist 受容 1)を **lockfile 更新のみ**で解消。**override 追加ゼロ / package.json 無変更 / 直接依存の版不変**(= 差分は `pnpm-lock.yaml` 1 file・何か壊れれば原因は transitive の版に限定される、という検証性を意図した設計)。全 7 件に上流 patched 版が実在し「上流の上流待ち」ゼロ。

`vulnerable` 列は **本 repo の tree に実在する系列のみ**を書く(brace-expansion の 2.x / 3.x 線は advisory には存在するが本 tree に無いため省略 — 完全性の主張ではない)。`scope` は **base commit で `pnpm audit --prod` / `--dev` を別実行した実測**。

| module | GHSA(概要) | scope | vulnerable | patched | 到達版 | 手段 |
|---|---|---|---|---|---|---|
| fast-uri | GHSA-7p8r-x3mc-p8w7(backslash authority による host confusion) | **prod のみ** | `>=3.0.0 <3.1.5` | 3.1.5 | 3.1.5 | `pnpm update fast-uri`(ajv@8.20.0 `^3.0.1` 内) |
| ip-address | GHSA-mwp4-54f8-5fhr(先頭ゼロ octet を decimal 解釈 = resolver との齟齬) | **prod のみ** | `<=10.3.0` | 10.3.1 | 10.4.0 | **親の再解決**(下記) |
| brace-expansion | GHSA-rgw5-rvv9-x895(中間配列の無制限確保 DoS・CVE-2026-14257 の緩和を迂回) | prod+dev(**5.x 線** = prod+dev / **1.x 線** = dev のみ) | `<1.1.18` / `>=4.0.0 <5.0.9` | 1.1.18 / 5.0.9 | 1.1.18 / 5.0.9 | `pnpm update brace-expansion`(minimatch@3.1.5 `^1.1.7` / minimatch@10.2.5 `^5.0.5` 内) |
| brace-expansion | GHSA-mh99-v99m-4gvg(**allowlist 受容中だった 1 件**) | dev | `<1.1.17` / `>=4.0.0 <5.0.8` | **1.1.17** / 5.0.8 | 1.1.18 / 5.0.9 | 同上 → **allowlist エントリ撤去** |
| undici | GHSA-4cwx-7wf7-3272(cross-user 情報漏洩 + parse 時 crash) | dev | `>=7.0.0 <7.29.0` | 7.29.0 | 7.29.0 | `pnpm update undici`(jsdom@29.1.1 `^7.25.0` 内) |

内訳の照合: **prod 3** = fast-uri / ip-address / brace-expansion@5.0.8(rgw5)。**dev 3(gate 表示)** = undici / brace-expansion@5.0.8(rgw5)/ brace-expansion@1.1.16(rgw5)。**dev 受容 1(非表示)** = brace-expansion@1.1.16(mh99)。`pnpm why --dev -r fast-uri` / 同 `ip-address` はいずれも**空**(= dev 到達なし)。

- **ip-address は単体再解決が効かない**: `express-rate-limit@8.4.1` が `ip-address` を **exact `10.1.0`** で宣言していたため(range 内に patched が無い = 名前指定 update は不発)。8.5.2 以降が `^10.2.0` へ緩和しており、親 `@modelcontextprotocol/sdk@1.29.0` の宣言が `^8.2.1` ゆえ **`pnpm update express-rate-limit`(→ 8.6.2)で連鎖解決**。**ip-address を直接 override しない** — exact pin した親を残したまま子だけ剥がすと、親の想定と解決版の乖離が lockfile に固定され、以後 override を外せなくなる。**exact pin された transitive は親を上げるのが正**。
- **peer-suffix の壁は今回発生せず → override 追加ゼロ**: `express-rate-limit`(lockfile key `8.4.1(express@5.2.1)` = peer-suffix 付き)も `pnpm update` で 8.6.2 に更新された。**matrix v2 の vite 知見「peer-suffix 付き transitive は `pnpm update` が更新しない」は無条件命題ではない** — 分かれ目と運用(先に override へ逃げず着手時に実測する)は session doc の知見 1。
- **GHSA-mh99 受容の撤去根拠**: 受容根拠の第一項「v1 系に patched backport が存在しない」は、上流が **1.1.17 を backport** したことで **偽になった**。allowlist は「**patched 不在の系列**」単位で受容する設計(2026-07-25 OT 裁定)ゆえ、その系列に patched が生えた時点で受容は成立しない。**残置した場合の害** = v1 の affected 版が別経路から再混入しても `vulnerableRange <2.0.0` に合致して**無言で受容され続ける**(bump 可能なのに fail しない = 本台帳冒頭の原則「bump で解消できる検出は受容しない」違反)。よって `entries: []` へ。
- **v1 backport の CJS 互換は実証済**: 受容根拠の第二項「5.0.8 強制は minimatch@3 の CJS `require()` を壊す」への対処が不要になった(v5 を強制せず v1 系内で 1.1.16→1.1.18)。`pnpm lint` exit 0 = eslint → minimatch@3 → brace-expansion@1.1.18 の実経路が動作。
- **随伴(scope 注記)**: `pnpm update` の再解決に伴い ① vite subtree の postcss `8.5.23→8.5.25`(+ その dep `nanoid@3.3.17` が新規 entry)② optional な `@napi-rs/wasm-runtime 1.1.6→1.2.2`(`@rolldown/binding-wasm32-wasi` 配下・linux x64 では未使用)。**いずれも宣言 range 内 dev 側の patch refresh で advisory 起因ではない**。①は「解消+受容(2026-07-25)」と**同型の既知現象**(override `postcss ^8.5.12` の caret 配下ゆえ targeted update でも回避不能)。③ `express-rate-limit@8.6.2` が `debug` への依存 edge を新設(+ `transitivePeerDependencies: supports-color`)— ただし `debug@4.4.3` は `express` 経由で既に tree 内にあり、**新規 package は増えない**(edge のみ)。**基線が不動点であることは実測済** — base lockfile から `pnpm install --no-frozen-lockfile` を実走して `git diff pnpm-lock.yaml` がゼロ(推論でなく実行)→ 随伴は `update` の再解決由来と確定(pending drift ではない)。
- **随伴解消(moderate 5 件)**: all-scope moderate **10 → 5**。内訳 = `GHSA-v2v4-37r5-5v8g`(ip-address `<=10.1.0` → 10.4.0)+ **undici `<7.29.0` の 4 件**(`GHSA-8xcm-r25x-g524` / `GHSA-m8rv-5g2x-5cg5` / `GHSA-jr45-8vmc-qm54` / `GHSA-v3r7-h72x-cjcm` — いずれも patched 7.29.0)。moderate/low の現況は下記 **「現況(2026-08-06 T1 後)」** 節(2026-07-21 の表は当時の snapshot として別に保存)。
- gate: `pnpm install --frozen-lockfile` / typecheck / lint(`--max-warnings=0`)/ build / test(**4428**)/ test:iso(**316**)/ `pnpm run audit` **全 exit 0**。

## 分類是正(2026-08-06 deps 基線更新 T3・shadcn を devDependencies へ)

経緯と一般化した教訓は `docs/superpowers/sessions/2026-08-06-deps-baseline-update.md`(知見 4-6)。本節は **audit 上の事実**(使われ方 / 面の数値 / 政策面の帰結)を持つ。

**これは分類の是正であって、実行時の危険を消す作業ではない。**`shadcn@4.6.0`(版は据え置き・exact pin 維持)を `dependencies` → `devDependencies` へ移した。変わったのは **`pnpm audit --prod` が評価する面**だけで、成果物の中身は変わっていない(下記 CSS バイト一致)。効果は「**prod scope の評価対象から外れた**」ことに尽きる — セキュリティ上の危険が減ったわけではない。

### shadcn の使われ方(移動前に測定)

- **TS / JS / TSX からの import = 0 件**(`from 'shadcn'` / `require('shadcn')` / `import('shadcn')` を全 `*.ts,tsx,js,mjs,cjs` に対し grep・test 含めて 0)。
- **ただし CSS 経由の import は実在する**: `app/globals.css:3` の `@import "shadcn/tailwind.css";`(`shadcn` の `exports["./tailwind.css"]` を解決)。これは **build 時に Tailwind/PostCSS が解決する**参照で、runtime 依存ではない。**「source から一切 import されていない」は正確ではない** — 正しくは「**runtime に読み込まれる経路が無い**」。
- **devDependencies が build phase で解決されることの根拠**: `app/globals.css:1` の `@import "tailwindcss";` は devDependency `tailwindcss@4.3.3` を、`postcss.config.mjs` が読む `@tailwindcss/postcss@4.3.3` も devDependency を解決している。**Vercel の build phase が devDependencies を install しないなら現行の prod build が既に失敗しているはず**であり、shadcn は既存の実証済みクラスに加わるだけで新しい失敗様態を作らない。**local build の CSS バイト一致はこの点の証明にならない**(理由 = session doc 知見 6)。
- `components.json` は shadcn CLI の設定 file(component 生成時のエイリアス定義)。生成された `components/ui/*` は `shadcn` package を import しない。
- **実行対象 file(`*.ts,tsx,js,mjs,cjs,css,yaml,json`)における** その他の "shadcn" 出現は、全てコメント(radix/popover の挙動説明)/ `pnpm-workspace.yaml` の override コメント / `components.json` の `$schema` URL。`docs/**` には多数の言及があるが実行対象外。

### 面の変化(移動前後の実測)

測定基準は上記「運用」の **推移閉包**(prod / dev を同一方法で・`pnpm ls --dev` や `totalDependencies` と混ぜない)。

| 指標 | before | after |
|---|---|---|
| prod 閉包 | 646 | **445** |
| prod 離脱 / 流入 | — | **離脱 201 / 流入 0** |
| dev 閉包 | 655 | **840**(流入 185) |
| **prod advisory** | low 2 / moderate 4(6 件) | **low 2 / moderate 4(6 件)= 完全に不変** |
| dev advisory | low 1 / moderate 1(2 件) | low 2 / moderate 4(6 件) |
| **prod ∪ dev** | 1132 | **1132(差分 0)** |

**突合(全 package を両側で説明できる)**: prod 離脱 201 の内訳 = 既に dev から到達可だった **86** + dev に新規出現した **115**、**どちらでもない孤児 = 0**(= 「抜けた 201 件は全て dev 側に存在する」)。これとは別に **prod に残ったまま dev 経路も得た package が 70**(`@google/genai` と共有する MCP SDK 配下)。検算 `115 + 70 = 185` = dev 流入と一致。prod ∪ dev の差分は 0 = **版は 1 つも動いていない**。

**prod の advisory 件数は 1 件も減っていない。** 現在 prod に出ている 6 件はいずれも shadcn 固有経路ではなく、`@google/genai`(→ `@modelcontextprotocol/sdk` → express/hono 系: body-parser / qs / hono / @hono/node-server)または `next`(postcss@8.5.21 / styled-jsx → @babel/core)から**独立に到達する**ため、shadcn を外しても prod に残る。したがって「moderate/low が prod → dev へ移り件数が一致する」形の証明にはならなかった。**面が変わったことの証明は advisory でなくパッケージ集合の突合で取る**(上表)。

shadcn **固有**の prod 経路だったのは `shadcn → ts-morph → @ts-morph/common → minimatch@10 → brace-expansion@5`(5 件とも prod 離脱を実測)。T1 で 5.0.9(patched)に上がっており現在 advisory は無いが、この系列が prod 面から外れたことが本作業の実質。逆方向の副作用として、**MCP SDK 配下(body-parser / qs / hono / @hono/node-server)が dev 面にも現れるようになった**(shadcn が dev 経路として同じ subtree に到達するため)。prod からは消えていないので gate 上の意味は変わらない(いずれも moderate/low = 閾値 high の対象外)。

**政策面の帰結(favorable 一方向で書かない)**: prod を離脱した 201 package は「**受容不可**(prod は allowlist 不適用 = high で無条件 fail)」から「**allowlist 受容可能**(dev)」の面へ移った。分類としては正しい扱いだが、**今後この subtree に high が出た場合の強制力は落ちる**。実例として `brace-expansion` は本 repo で唯一 allowlist 受容が発生したモジュールであり、その v5 系列が今回の 201 に含まれる — 昨日なら prod で無条件 fail、今日は dev として受容の余地がある。一方、**prod 残留のまま dev 面にも現れた 70 package(MCP SDK 配下)は prod に居続けるため強制力は不変**。

版は 1 つも動いていないため、prod ∪ dev の advisory 集合(= all-scope)は不変。変わったのは scope への帰属のみ。

### 検証

- **build 出力の CSS がバイト一致**(`.next/static/chunks/*.css` の file 名・md5 とも移動前後で同一)= local build において `@import "shadcn/tailwind.css"` の解決と出力内容が維持されていることの実証(Vercel の install phase の証明ではない — 上記)。
- **build 出力に shadcn / ts-morph の混入ゼロ**(移動**前から**ゼロ): `.next/server/**/*.nft.json`(runtime トレース)/ `.next/server` 全体 / `.next/static` 全体のいずれにも該当なし。= runtime 成果物は元々 shadcn を含んでいない(これも「分類の是正」である根拠)。
- lockfile 差分は **importers セクションの移動のみ**(specifier `4.6.0` / 解決版 `4.6.0(@types/node@24.13.2)(typescript@6.0.3)` とも不変・`packages:` / `snapshots:` に変更ゼロ)。
- gate: `pnpm install --frozen-lockfile` / typecheck / lint(`--max-warnings=0`)/ build / test(**4428**)/ test:iso(**316**)/ `pnpm run audit` **全 exit 0**。

## 解消済(2026-08-10 audit sprint・繰り越し high 2 種)

4 sprint 繰り越していた **gate fail 3 表示 = advisory 2 種**(nanoid は prod / dev の両方に出るため 2 表示)を **lockfile 更新のみ**で解消。**override 追加ゼロ / `package.json` 無変更(sha256 一致)/ `pnpm-workspace.yaml` 無変更 / allowlist は `entries: []` のまま**(受容ではなく bump で解消したため記録すべき受容が無い)。差分は `pnpm-lock.yaml` 1 file(**21 insertions / 48 deletions** = 版の寄せによる正味減)で、**版が動いた package は 4 つ**(対象 3 + 随伴 1 = 下記)。

| module | GHSA(概要) | scope | vulnerable | patched | 到達版 | 手段 |
|---|---|---|---|---|---|---|
| nanoid | GHSA-2v37-7h3g-55p8(custom generator が size 0 で無限ループ) | **prod + dev** | `<3.3.17` | 3.3.17 | **3.3.18** | `pnpm update postcss`(**nanoid は postcss 経由でしか入っていない**) |
| js-yaml | GHSA-5p4m-2wfm-xmqj(`!!omap` 解決の二次 CPU 消費・CVE-2026-59870) | dev | `>=4.0.0 <4.3.1` | 4.3.1 | **4.3.1** | `pnpm update js-yaml`(`@eslint/eslintrc` の range 内) |

- **nanoid を直接 update しない**: nanoid の唯一の到達経路が `postcss>nanoid` であり、**postcss を上げれば nanoid は追随する**(実際 tree には既に postcss 8.5.25 → nanoid 3.3.17 が vite 経由で存在していた = 上流に道があることの証拠)。子だけを直接指定して上げると、親の宣言と解決版の乖離を lockfile に固定することになる(2026-08-06 T1 の ip-address 知見「exact pin された transitive は親を上げるのが正」と同じ形)。
- **随伴解消(moderate 1 件)**: `GHSA-fxqj-rqcc-2cmp`(postcss `<=8.5.22` = sourceMappingURL 経由の任意ファイル読取の不完全修正)。前回現況表で「next@16.2.11 配下の 8.5.21 のみ検出」と記録していたもので、**同じ postcss 再解決で消えた**。
- **重複解消も随伴**: postcss **3 版(8.5.21 / 8.5.23 / 8.5.25)→ 1 版(8.5.26)** / nanoid **2 版(3.3.16 / 3.3.17)→ 1 版(3.3.18)**。lockfile が正味 27 行減ったのはこれが理由(依存の追加ではない)。
- **随伴(advisory 非関与・prod)**: `pg-protocol@1.15.0 → 1.16.0`。**本 sprint の対象 advisory とは無関係**だが lockfile diff に含まれるため記録する。原因 = `@types/pg` が `pg-protocol: "*"`・`pg` が `^1.13.0` と**制約が緩く**、`pnpm update` の既定(全グラフ再解決)が 2026-08-08 公開の 1.16.0 を拾った。**新規 package の追加ではなく版の float**(単一版のまま)で advisory も無い。基線の不動点確認(下記)を通っているのは、`install` が既存 lock を尊重するのに対し `update` が再解決するという差による。**lockfile diff に現れた package はこの 4 つで全部**(`js-yaml` / `nanoid` / `postcss` / `pg-protocol`)。
  - **検出経緯(process の記録)**: CC の自己確認は `grep -E '(postcss|nanoid|js-yaml)@'` と**期待した package 名で絞っていた**ため取りこぼし、canonical review が package 名を絞らない grep で検出した。**「期待したものが変わったか」ではなく「期待したものだけが変わったか」を見る**のが lockfile 差分の正しい確認方法。
- **override `postcss: ^8.5.12` は障害にならなかった**: caret は floor なので 8.5.26 は範囲内。**ただし「撤去条件 = 全消費側が >=8.5.12 を自然解決した時点」が満たされたかは本 sprint では未検証** — override を外して再解決する実験は `pnpm-workspace.yaml` 変更を伴い、本 sprint の lockfile-only 制約の外。**撤去可否の判定は別途**(推測で撤去しない)。
- **peer-suffix の壁は今回も発生せず**: `pnpm update` が transitive を素直に更新した。`pnpm-workspace.yaml` の vite override コメントにある「pnpm update が peer-suffix 付き transitive を更新しない」は**無条件命題ではない**(2026-08-06 T1 と同じ結論を再確認 — 先に override へ逃げず着手時に実測する)。
- **基線が不動点であることを実測**: base lockfile に戻して `pnpm install --no-frozen-lockfile` を実走 → `git diff pnpm-lock.yaml` ゼロ。よって差分は `update` の再解決由来であり、放置されていた pending drift ではない(推論でなく実行で確認)。
- gate: `pnpm install --frozen-lockfile` / typecheck / lint(`--max-warnings=0`)/ build / test(**4734**)/ test:iso(**335**)/ `pnpm run audit` **全 exit 0**。

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

## 現況(2026-08-10 audit sprint 後・`pnpm audit --json` 実測 = moderate 6 / low 3 / **high 0 / critical 0**)

**moderate 以下の正本はこの節**(下の 2026-08-06 表と「残存 follow-up」は当時の snapshot として保存 — 現況ではない)。**gate 対象外**(閾値 high)ゆえ本 sprint では対処せず記録のみ。

本表は **all-scope**(prod ∪ dev)。scope 別の実測は **prod: moderate 5 / low 3** / **dev: moderate 6 / low 3**(和が all-scope を超えるのは prod と dev の両方から到達する module があるため)。

| sev | module | GHSA | 検出版 | patched | 2026-08-06 表との関係 |
|---|---|---|---|---|---|
| moderate | esbuild | GHSA-67mh-4wv8-2f99 | 0.18.20 | `>=0.25.0` | 継続(drizzle-kit 配下) |
| moderate | qs | GHSA-q8mj-m7cp-5q26 | 6.15.1 | `>=6.15.2` | 継続(express 配下) |
| moderate | hono | GHSA-8j4g-w8fx-2239 | 4.12.31 | `>=4.12.34` | 継続 |
| moderate | hono | GHSA-f23p-vx2j-j53r | 4.12.31 | `>=4.12.34` | **新規**(前回記録以降の新 advisory) |
| moderate | hono | GHSA-54fx-42gc-7vw4 | 4.12.31 | `>=4.12.34` | **新規**(同上) |
| moderate | @hono/node-server | GHSA-frvp-7c67-39w9 | 1.19.14 | `>=2.0.5` | 継続 |
| low | @babel/core | GHSA-4x5r-pxfx-6jf8 | 7.29.0 | `>=7.29.6` | 継続 |
| low | body-parser | GHSA-v422-hmwv-36x6 | 2.2.2 | `>=2.3.0` | 継続 |
| low | hono | GHSA-79qm-7rj5-m7r9 | 4.12.31 | `>=4.12.34` | **新規**(同上) |

**2026-08-06 表からの消滅 1 件**: `GHSA-fxqj-rqcc-2cmp`(postcss・本 sprint の再解決で 8.5.26 到達)。**増加 3 件はいずれも hono 系の新規 advisory** で、`shadcn>@modelcontextprotocol/sdk>hono` 配下の 4.12.31。patched は 4 件とも `>=4.12.34` ゆえ **親(shadcn / MCP SDK)の bump で一括解消する見込み** — gate 対象外につき別 sprint。

## 2026-08-06 sprint 後の snapshot(**現況ではない** — 正本は上の「現況(2026-08-10 …)」)

当時の記録として保持。**gate 対象外**(閾値 high)ゆえ T1 では対処せず記録のみ。

本表は **all-scope**(prod ∪ dev)の件数。T3(shadcn の devDependencies 移動)は**版を 1 つも変えていないため本表は不変**で、変わったのは prod / dev への帰属のみ(T3 節参照 — 移動後は prod low2/mod4・dev low2/mod4)。

| sev | module | GHSA | 検出版 | patched | T1 との関係 |
|---|---|---|---|---|---|
| moderate | esbuild | GHSA-67mh-4wv8-2f99 | 0.18.20 | `>=0.25.0` | 継続(drizzle-kit 配下・T1 非関与) |
| moderate | qs | GHSA-q8mj-m7cp-5q26 | 6.15.1 | `>=6.15.2` | 継続(express 配下・T1 非関与) |
| moderate | hono | GHSA-8j4g-w8fx-2239 | 4.12.31 | `>=4.12.34` | **新規**(前回記録以降の新 advisory・T1 非関与) |
| moderate | @hono/node-server | GHSA-frvp-7c67-39w9 | 1.19.14 | `>=2.0.5` | **新規**(同上) |
| moderate | postcss | GHSA-fxqj-rqcc-2cmp | 8.5.21 | `>=8.5.23` | **新規**。検出されるのは **next@16.2.11 配下の 8.5.21 のみ**(override `^8.5.12` は floor ゆえ next の解決を引き上げない)。tailwind/shadcn 側 8.5.23 と vite 側 8.5.25 は patched。 |
| low | @babel/core | GHSA-4x5r-pxfx-6jf8 | 7.29.0 | `>=7.29.6` | 継続 |
| low | body-parser | GHSA-v422-hmwv-36x6 | 2.2.2 | `>=2.3.0` | 継続 |

**2026-07-21 表からの消滅 2 件**: `GHSA-v2v4-37r5-5v8g`(ip-address・**T1 で 10.4.0 到達**)/ `GHSA-g7r4-m6w7-qqqr`(esbuild・vite 配下が 0.28.1 到達済で **T1 前**に解消)。これは 2026-07-21 表との差分であり、**T1 が解消した moderate は計 5 件**(上記 undici 4 件は 2026-07-21 以降に公開された advisory ゆえ当該表に載っていない)。

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

