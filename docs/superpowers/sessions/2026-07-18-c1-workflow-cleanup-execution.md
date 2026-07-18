# C1: devcontainer / CC workflow 掃除一括 — 実装記録(2026-07-18)

前提 = `2026-07-18-devcontainer-workflow-audit.md`(A 群番号は同 doc)。
commit: `6a74ce0`(devcontainer)/ `c6543db`(claude settings)/ `cd9492e`(lefthook)。全 chore・実装ロジック変更なし・[no-review]。

---

## 1. Step 0(現物再確認)の結果

- 監査 doc の A-1〜A-7 記述はすべて現物と一致(devcontainer.json / post-create.sh / settings 群 / lefthook.yml を直接 read して確認)。
- 追加判明: この CLI 版(2.1.205)に `claude plugin uninstall` サブコマンドは無い(disable / enable / marketplace remove のみ)→ 現行コンテナの chrome-devtools 撤去は「marketplace remove + global settings 編集 + cache 削除」で実施。
- shellcheck 不在 → 静的検証は `bash -n` + 目視。
- packageManager field = `pnpm@10.33.0`(sha suffix なし)。

## 2. 実施内容(9 件 + 横断)

| # | 項目 | 実施 |
|---|---|---|
| 1 | chrome-devtools 全削除 | post-create から install/patch step 除去。現行コンテナ: `claude plugin marketplace remove chrome-devtools-plugins` + global settings(`/root/.claude/settings.json`)から enabledPlugins / extraKnownMarketplaces の該当 entry 削除 + plugin cache 削除。`claude plugin list` に chrome-devtools 非表示を確認 |
| 2 | desktop-lite / noVNC 削除 | feature block + forwardPorts 6080 + portsAttributes 6080 削除(5901 は feature 内設定のみで他に出現なし) |
| 3 | A-1 model pin | settings.json から `"model": "opus"` 削除。post-create 完了メッセージのモデル名ハードコードも除去 |
| 4 | A-3 TEMP debug | `CLAUDE_HOOK_DEBUG=1` opt-in 化。常時記録は撤去(238 Stop 実測で `background_tasks` が list 形状と検証完了済) |
| 5 | A-4 hook 配線 | detect-leaked-toolcall.sh の Stop 配線を settings.json(tracked)へ移動。順序 = check-review → detect-leaked-toolcall → discord-notify(通知は最後)。settings.local.json は allow + enabledMcpjsonServers のみ残置(**gitignored のため commit 対象外、編集は現物にのみ反映**) |
| 6 | A-5 残骸 allow | /home/komai 系 3 件 + `Bash(python3 -c ' *)` 削除(allow = [] に) |
| 7 | A-6 lefthook | コメントを実態(staged lint のみ / whole-repo gate は CLAUDE.md / GHA 不採用・復活は git 6958d18)に修正 |
| 8 | A-7 pnpm | `corepack install`(packageManager field 準拠)へ。version ハードコード撤去、postcondition で field と実 version の一致検証 |
| 9 | B-1 deny | `git commit` の no-verify / -n 系 6 パターン追加(§4 参照) |
| 横断 | postcondition 化 | §3 参照 |

## 3. post-create.sh postcondition 化の設計

- 方針: 各 step は「効いている」を検証し、不成立なら `fail()` で non-zero(build が明確に落ちる)。`set -euo pipefail`。
- 検証内容: npm prefix 実値 / pnpm version = packageManager field / claude・stripe・typescript-language-server・google-chrome の `--version` 成功 / codex version = exact pin(`CODEX_VERSION` 変数で pin と検証を単一定義)/ marketplace・plugin 登録の list 照合。
- **検証不能と明示した step**(捏造しない): superpowers / frontend-design(project settings の enabledPlugins を初回 claude セッションが解決するため post-create 時点で確認手段なし)、MCP 承認状態(.mcp.json は初回セッションが読む)。
- 既知の弱さ(コメントに明記済): plugin/marketplace の postcondition は CLI list 出力の grep で形式変更に弱い(機械可読照会が無い妥協)。SIGPIPE/pipefail 誤爆回避のため list は変数に受けてから grep。
- context7 の `claude mcp add` step は撤去: .mcp.json(tracked)に定義済で二重登録だった。fresh clone では .mcp.json server の承認プロンプトが 1 回出る(既存 workspace は settings.local.json の enabledMcpjsonServers が残るため出ない)。

## 4. B-1: deny パターンの実誤爆と限界(hook 化判断の材料)

採用 6 パターン(端点アンカー型のみ):
`git commit --no-verify` / `git commit --no-verify *` / `git commit * --no-verify` / `git commit -n` / `git commit -n *` / `git commit * -n`

- **実誤爆の記録**: 当初 8 パターン(中間型 `git commit * --no-verify *` / `git commit * -n *` 含む)で、本 sprint 自身の commit(message 本文に「--no-verify」「 -n 系」の文字列)が deny に**実際にブロックされた**。パターンは quoted message 内も raw 文字列として match する(公式 docs の「引数制約パターンは fragile」の実証)。中間型 2 つを撤去して解消。副産物: settings.json の deny 変更が**同一セッションで即 live** になることを実証。
- **既知の抜け(意図的に許容)**: ① フラグが中間に来る形 `git commit -m x --no-verify --quiet` ② `git -c ... commit --no-verify` ③ 複合コマンド内の変形。`:*` は末尾のみ有効・中間 `*` は空白区切り token 単位、が公式仕様(claude-code-guide 裏取り済)。
- **hook 化方針(OT brief どおり)**: PreToolUse(Bash matcher)+ 正規表現なら全形態を塞げるが、**実際の迂回を観測してから**導入する。deny は機械的な第一障壁、本丸は CLAUDE.md 規律。

## 5. chrome-devtools 再導入レシピ(将来 perf trace が要る時)

plugin 経由にしない(cache patch という脆い機構に戻るため)。`.mcp.json` に直登録:

```json
"chrome-devtools": {
  "command": "npx",
  "args": ["-y", "chrome-devtools-mcp@<exact-version>", "--chrome-arg=--no-sandbox"]
}
```

- exact pin 必須(@latest は 1.2.0 で layout/args が変わった実績)。
- root コンテナでは `--chrome-arg=--no-sandbox` 必須(無いと `Protocol error (Target.setDiscoverTargets): Target closed` — 実測 24 呼び出し全滅の原因)。
- 導入後は「1 tool call 成功」を確認してから運用に載せる(過去は未検証のまま convention 化していた)。
- skills(a11y / perf trace 等)も要る場合のみ marketplace `ChromeDevTools/chrome-devtools-mcp` を追加(MCP server は上記直登録を正とし、plugin 側 MCP と二重にしない)。

## 6. noVNC 復元手順

devcontainer.json の features に `"ghcr.io/devcontainers/features/desktop-lite:1": { "password": "vscode", "webPort": "6080", "vncPort": "5901", "installUser": "false" }` を戻し、forwardPorts に 6080 を追加して rebuild。

## 7. 計測のみ: context7 MCP 使用実績(削除は scope 外・維持確定済)

transcript 全量(chrome-devtools 調査と同方式・tool_use block parse):

- **総計 23 呼び出し / 成功 23 / 失敗 0**(resolve-library-id 8 + query-docs 15)、9 session(2026-07-02〜07-13)。
- 用途: TanStack Table/Virtual(Notion table sprint の API 裏取り)/ Stripe(subscription cancel・proration・test clocks)/ stripe-cli / aws4fetch(R2 presign)。
- C2(version pin 統一)参考: 実用実績あり・失敗ゼロ。`@upstash/context7-mcp@latest` の pin 化は C2 で判断。

## 8. 静的検証結果(CC 分担分・全 PASS)

- JSON parse: devcontainer.json / settings.json / settings.local.json / global settings — OK
- `bash -n` post-create.sh — OK(shellcheck は環境に無し)
- `python3 -m py_compile` discord-notify.py — OK
- lefthook.yml — `lefthook dump` で parse OK
- hook 3 file の存在 + 実行 bit — OK
- packageManager 抽出式の実値 = 10.33.0 — OK
- postcondition の grep 式を現環境で実走 — marketplace / typescript-lsp とも OK
- hook 配線の実発火・deny の追加パターン発火(正例)は次セッション / rebuild 持ち越し(deny の live 反映自体は §4 の誤爆で実証済)

## 9. OT rebuild チェックリスト(container rebuild 後)

1. post-create が **exit 0 で完走**(POSTCONDITION FAIL 出力なし)。失敗時は step 名が明示される
2. `pnpm --version` = 10.33.0(packageManager field と一致)
3. `claude --version` / `codex --version`(= 0.142.3)/ `stripe --version` / `google-chrome --version` 成功
4. `claude plugin list` に chrome-devtools が**無い**こと、typescript-lsp / superpowers / frontend-design が enabled
5. VS Code の PORTS に 6080 が**無い**こと(noVNC 消失)
6. claude 起動時の model が global 既定(Fable 5)— 「settings.json pins Opus」警告が出ないこと
7. 初回セッションで Stop hook 3 本が発火すること(feat/fix tag 検査・Discord 通知の到達)
8. fresh clone の場合のみ: .mcp.json(playwright / context7)の承認プロンプトに 1 回応答
