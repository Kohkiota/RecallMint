# Session: 脆弱性 transitive bump(high 16 件解消 + audit gate high 引き上げ)

- **日付**: 2026-07-21
- **範囲**: `e8225f4..`(chore(deps) `b57fc34` + chore(audit) `7bdfca2`・全 [reviewed] + docs 本 commit)。未 push。
- **実装方式**: controller 直実装 + canonical/Codex review-before-commit。brainstorming / writing-plans skip(brief plan 級)。

## Step 0(経路と手段の確定)

- **手段の裏取り**: docs page(https://pnpm.io/10.x/cli/update)は depth 詳細が薄く、10.33.0 CLI help が正 — `pnpm update [<pkg>...]` は「specified range 準拠」+ **`--depth` は Infinity が default**(0 = top-level のみ)→ transitive の名前指定 update = lockfile-only refresh。実走で裏付け。
- **全件表(9 pair・16 行・15 GHSA)**: 全て range 内・major 跨ぎゼロ(親の宣言 range: minimatch@3.1.5 `^1.1.7` / minimatch@10.2.5 `^5.0.5` / ajv@8.20.0 `^3.0.1` / mcp-sdk@1.29.0 `^4.11.4` / eslintrc@3.3.5 `^4.1.1` / genai@1.50.1 `^7.5.4`・`^8.18.0` / jsdom@29.1.1 `^7.25.0` / vitest@4.1.5 `^6||^7||^8` + plugin-react peer `^8.0.0`)。停止分岐(互換懸念)非該当。

## Task 1-2(bump)

- `pnpm update` 名前指定 8 件 → 到達版: brace-expansion **1.1.16 / 5.0.7**・fast-uri **3.1.4**・hono **4.12.31**・js-yaml **4.3.0**・protobufjs **7.6.5**・undici **7.28.0**・ws **8.21.1**。直接依存の版・package.json 不変(reviewer が lockfile 独立検証)。
- **vite のみ update 不発** → override `8.0.16` exact: pnpm 10.33.0 の update は peer-suffix 付き transitive(lockfile key `vite@x.y.z(...)`)を更新しない(name / `vite@^8.0.16` / `--depth Infinity` / `-r` 全て実測不発)。撤去条件 + 固定版に新 CVE 時は「撤去でなく override 値 bump」を台帳に記録。
- 随伴解消: moderate 26→**3** / low 6→**3**(残 = esbuild(drizzle-kit 系 / vite 系)・ip-address・qs・@babel/core・body-parser — gate 対象外・台帳 follow-up)。
- protobufjs の「Ignored build scripts」警告 = 7.5.5 と postinstall byte-identical・従来から非許可(onlyBuiltDependencies 非掲載)で挙動 parity。scripts 全体では build:types の file list 差(@protobufjs/inquire 除去に整合)あり。

## Task 3(gate high 化 + 検出機械化)

- audit script = `node scripts/check-audit-config.mjs && pnpm audit --audit-level high`。CLAUDE.md 二段階注記を解消済へ更新。
- tripwire = **2 層 fail-closed**(層1 substring: `ignoreCves` 全文検査・コメント含む = 仕様 / 層2 whitelist: サニクション形のみ通す)。test 18 本(CLI 契約)+ mutation red 実証(層2 無効化→RED 8 fail / 層1 無効化→RED 3 fail)。
- **RED 実証(brief 要求)**: ignoreCves 注入 → exit 1 + key 名出力 → 復元(gate script v1 時点で実施)。Codex 敵対例(`!!str` tag / `? ` explicit key)も fixture pin 化し非0 を実証。

## Review(fix loop 3 周 + OT 裁定)

- canonical: 初回 **Crit0/Imp3**(①tripwire flow-style 素通り ②自動 test 欠如 ③override runbook gap)+ Minor3 → fix(fail-closed 化 / test 追加 / 台帳 1 行)→ 再 **Crit0/Imp0/Ready=Yes**(mutation 独立再実行・fixture 検証込み)。
- Codex: 3 周連続で有効 YAML 別表現の bypass を検出(P2 quoted key → fix / P1 indent 変種 → **whitelist 再設計** / P2 exotic YAML(`!!str`・`? `))。**3 周上限到達 → 規律どおり停止・OT 裁定**。
- **OT 裁定 (a)**: threat model 明文化(対象 = pnpm 標準書込 + 素朴 hand-edit / 非目標 = 敵対的 YAML 難読化 — 難読化を書ける悪意者は script 自体を編集できるため tripwire では原理的に防御不能・review governance の管掌。js-yaml 構造 parse は pnpm 自前 parser との解釈差が新たな穴になるため不採用)+ substring 層追加 + 敵対例の fixture 化 + escape 難読化の非目標宣言(test コメント)。実装要件全充足を実証。
- canonical 残 Minor(記録のみ): tab indent / 重複 block(YAML parse error で非到達)・protobufjs 表現精緻化(本 doc で対応)。

## Gate(依存変更 sprint フル・全 exit 0)

frozen-lockfile 0 / lint 0 / typecheck 0 / **pnpm run audit 0(high + tripwire)** / build 0 / unit **3799**(+18)/ iso **171**。

## OT 後続(申し送り)

1. **push → stg OCR smoke(upload → Gemini → カード生成)** — prod 経路 9 件(protobufjs×5 / ws / fast-uri×2 / hono)が @google/genai 配下のため、これが本 sprint の実地検証。dev 経路 7 件(undici / brace-expansion / js-yaml / vite)は gate 自体(lint / test / build がその工具を実行)で実質検証済。
2. vite override の撤去条件 = 台帳「解消済」(vitest / plugin-react 直接 bump 時に外して `pnpm why vite` 確認)。
