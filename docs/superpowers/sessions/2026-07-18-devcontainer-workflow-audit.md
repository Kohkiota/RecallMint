# Devcontainer / CC workflow 現状監査 + 最適化候補(2026-07-18)

目的: 開発コンテナ自体のワークフロー改修に先立つ現在地の棚卸し。実装なし・調査のみ。

---

## 1. 現在地サマリ

### 1.1 Container(.devcontainer/)

- **image**: `mcr.microsoft.com/playwright:v1.58.2`(Node 24.13 同梱)。root 運用(`remoteUser: root`)。
- **features**: desktop-lite(noVNC :6080 / VNC :5901、pw=vscode)— ブラウザ目視 debug 用。
- **mounts**: `/root/.claude` = named volume(devcontainerId 別)/ bash history volume / `.gitconfig` read-only bind。
- **containerEnv**: `CLAUDE_CONFIG_DIR=/root/.claude`, `NODE_OPTIONS=--max-old-space-size=4096`, `IS_SANDBOX=1`。
- **forwardPorts**: 3000 / 5173 / 8000 / 6080 / 4983(Drizzle Studio)。
- **post-create.sh**(8 step): npm prefix → corepack pnpm@10.33.0(ハードコード)→ Claude Code native installer(stable)→ Stripe CLI → typescript-language-server → **Codex CLI `@openai/codex@0.142.3` exact pin** → Google Chrome(playwright MCP / chrome-devtools 共用)→ MCP/plugin 登録 + **chrome-devtools plugin.json への `--no-sandbox` sed patch**。

### 1.2 Claude Code 設定

- **CC 本体**: 2.1.205(stable)。native installer。
- **global settings**(`/root/.claude/settings.json`): model=`claude-fable-5[1m]`(1M context)、effortLevel=xhigh、plugins(user scope)= typescript-lsp / chrome-devtools-mcp、marketplaces 2 件。
- **project settings**(`.claude/settings.json`、tracked):
  - `defaultMode: bypassPermissions` + deny list(curl / wget / ssh / scp / publish / `git push` / `git remote` 変更 / `gh repo delete` 等)
  - **`"model": "opus"` を pin**(再起動時に global の Fable 5 を上書き)
  - allow list に**他マシン残骸**(`/home/komai/projects/devcontainer-template` への python3 検証 3 件 + `Bash(python3 -c ' *)`)
  - Stop hooks: `check-review.sh` → `discord-notify.py`
  - plugins(project scope)= superpowers 6.1.1 / frontend-design(pr-review-toolkit は disabled = 撤去済)
- **project settings.local.json**(**gitignored**): Stop hook `detect-leaked-toolcall.sh` の配線 + enabledMcpjsonServers(playwright / context7)承認。**= この配線は機械ローカルで、コンテナ再構築時に消える**(hook script 本体は tracked)。
- **statusline.sh**: model / context % / cost 表示(node)。issue #13783(累積トークンバグ)注記あり。

### 1.3 Stop hooks(3 本)

| hook | 配線 | 役割 |
|---|---|---|
| `check-review.sh` | settings.json | feat/fix の [reviewed]/[no-review] tag 検査で block。**test-only commit の「保証の増減」宣言検査**(2026-07-18 制定、red 検証 / 保証減 / 保証不変 token)も実装済。stop_hook_active guard で無限ループ回避。tag あり時は silent pass(lint リマインドは廃止済 = context 浪費対策)。 |
| `discord-notify.py` | settings.json | last_assistant_message を Discord へ分割送信(専用 webhook、ops と channel 分離)。background_tasks 残存中の中間 Stop は抑止。**TEMP debug 記録(`/tmp/claude-stop-hook-debug.jsonl`)が残存 — 238 行で `background_tasks: []` の形状確認済 = 削除条件成立**。 |
| `detect-leaked-toolcall.sh` | settings.local.json | ツール呼び出しテキスト漏れ(既知 harness バグ)検出 → 1 回だけ言い直し block。 |

lefthook(git 側): pre-commit lint のみ(staged、11 秒)。**コメントに「typecheck/vitest/build は CI 側 .github/workflows/ci.yml に寄せる」とあるが GHA は不採用で `.github/` 自体が無い = doc rot**。

### 1.4 MCP / Plugin / Skill

- **MCP servers**: playwright(project `.mcp.json`、`--browser chrome --no-sandbox`、`@latest`)/ context7(project、`@latest`)/ chrome-devtools(plugin 経由)。
- **plugins**: superpowers 6.1.1(process skills 一式: brainstorming / writing-plans / subagent-driven-development / requesting-code-review / TDD / systematic-debugging / verification-before-completion / using-git-worktrees / writing-skills 等)、frontend-design、typescript-lsp 1.0.0(LSP server)、chrome-devtools-mcp 1.2.0(MCP + skills: a11y / perf trace / LCP / memory-leak / troubleshooting / CLI)。
- **project 独自 skill = 0**(/reload-plugins 出力どおり)。規律はすべて CLAUDE.md 直書き。
- **CLI 組込 skills**: code-review(ultra 含む)/ verify / simplify / deep-research / update-config / loop / schedule 等。

### 1.5 Review パイプライン(CLAUDE.md 正本)

canonical(superpowers requesting-code-review、read-only 保証)→ Codex 独立レビュー(`scripts/ai/codex-review.sh`、P0-P4→Crit/Imp/Minor 語彙統一、fix ループ上限 3 周、git clean detector = worktree-snapshot.sh 内容ベース)→ [reviewed] commit → OT push → stg smoke(DevTools MCP)。plan 段階は `codex-plan-review.sh` の 1 パス cross-check。scripts/ai には fixture test(vitest)あり。

---

## 2. 発見した不整合・陳腐化(即対処可能)

### A-1. model pin 競合【実害中】
project `.claude/settings.json` の `"model": "opus"` が再起動ごとに global の Fable 5 既定を上書き(今セッションの /model 出力でも警告表示)。post-create.sh の完了メッセージ「Model: opus」も同期対象。→ pin を外す(global に委譲)か fable に更新。

### A-2. chrome-devtools `--no-sandbox` patch が陳腐化【実害大・再現性】
plugin 1.2.0 で cache layout が `<name>/<version>/` に変わり、args も `chrome-devtools-mcp@latest` → `chrome-devtools-mcp@1.2.0` に固定された。現 plugin.json に no-sandbox **無し**(patch 消失を実機確認)。post-create の sed は `@latest` 前提で不一致 → **no-op でも「patched」と出力する検証欠如**。root コンテナで Chrome 起動時に `--no-sandbox` 必須のため、次回 chrome-devtools 使用時に起動失敗の可能性。
候補: (a) patch ロジックを version 非依存に修正 + 成功検証追加、(b) **plugin の MCP server 定義をやめ `.mcp.json` に direct 登録**(playwright と同型で `--chrome-arg=--no-sandbox` を args 指定、脆い cache patch 機構を排除。skills だけ plugin で維持できるかは要確認)。

### A-3. discord-notify.py の TEMP debug 削除条件成立【小】
`/tmp/claude-stop-hook-debug.jsonl` 238 行、全て `background_tasks: []`(list 形状)で検証完了。TEMP block の削除と guard 確定が可能。

### A-4. detect-leaked-toolcall の配線が機械ローカル【再現性】
settings.local.json は gitignored(.gitignore L45)。コンテナ再構築で hook 配線と MCP 承認が消える。→ Stop hook 配線を tracked の settings.json へ移動(enabledMcpjsonServers は local のままで可、ただし post-create で承認が要るなら記載)。

### A-5. 許可 list の他マシン残骸【衛生】
`/home/komai/projects/devcontainer-template` 参照 3 件 + `Bash(python3 -c ' *)`。bypassPermissions 下で allow は実質無効なので削除のみ。deny list は bypass 下でも有効なので維持。

### A-6. lefthook.yml コメントの doc rot【小】
GHA 不採用(git 履歴 6958d18 から復活可)が正。コメント修正のみ。

### A-7. pnpm version 二重管理【小】
post-create `corepack prepare pnpm@10.33.0` ハードコード vs package.json `packageManager` field(SSoT 規律)。→ `corepack install`(field 準拠)へ。

---

## 3. 最適化候補(設計判断が要るもの)

### B-1. 規律の機械的強制の拡張(hook 追加)
現状 CLAUDE.md 文言頼みのもの: `git commit --no-verify` 全面禁止(deny 未登録・hook 未検査)/ commit 直前 4 点宣言 / 着手前宣言。check-review.sh の test-only 宣言検査と同型の**PreToolUse hook**(Bash tool の `git commit` を intercept)で機械強制可能。強制しすぎは摩擦になるため、最小候補 = `--no-verify` / `-n` の deny or PreToolUse block のみ。

### B-2. バージョン戦略の統一
現状混在: exact pin(codex 0.142.3)/ @latest(playwright MCP・context7 MCP)/ image 固定(playwright v1.58.2)/ stable channel(CC)。@latest は起動ごとの npx 解決で再現性が無い(過去に plugin 側の layout 変更で patch が壊れた実例 = A-2)。方針を決めて揃える(例: MCP も minor pin + 定期更新 sprint)。

### B-3. ネットワーク egress 境界
deny で curl/wget/ssh は塞ぐが、node / python からの egress は自由(bypassPermissions + root)。Anthropic reference devcontainer には egress allowlist firewall(init-firewall.sh)の先例あり。導入コスト vs 効果は要調査(→ §4)。

### B-4. desktop-lite / noVNC の要否
headless Chrome + DevTools MCC/Playwright MCP で smoke が回っている現在、noVNC の使用実態があるか。未使用なら feature 削除で container build 短縮。**OT の使用実態回答が必要**。

### B-5. CLAUDE.md 規律の skill 化
project 独自 skill 0 の現状で、CLAUDE.md が長大化(review 経路 / Codex 協調 / 宣言類)。頻出手順(codex-review 実行手順、stg smoke 手順、着手前宣言 template)を project skill(`.claude/skills/`)に切り出すと、CLAUDE.md は規律 index に痩せて context 効率が上がる可能性。ただし skill は「呼ばれないと効かない」ため、常時強制系(順序則)は CLAUDE.md 残置が正。切り出し対象の選定が論点。

### B-6. statusline の既知バグ注記
issue #13783(context 累積バグ)が CC 2.1.x で修正済みかの確認のみ。低優先。

---

## 4. 外部調査依頼(claude.ai / GPT 向け)

1. **【GPT 向き】Codex CLI 最新事情**: `@openai/codex` 0.142.3 → 最新版の間の breaking changes(特に `codex exec review` のフラグ / sandbox_mode / exit code 仕様)。read-only review 運用のベストプラクティスに変化はあるか。
2. **【claude.ai 向き】devcontainer セキュリティのベストプラクティス**: Anthropic reference devcontainer(egress firewall / non-root)採用状況と、bypassPermissions + root + IS_SANDBOX 運用の業界標準との差分。root をやめ node user + sudo に寄せる場合の Chrome sandbox / pnpm / volume permission の落とし穴。
3. **【claude.ai 向き】chrome-devtools-mcp の root 運用**: 最新版で root/no-sandbox の公式サポート(env var / config file)が入ったか。plugin 経由 vs .mcp.json direct 登録の推奨。
4. **【内製可】Claude Code 2.1.x 新機能の棚卸し**: sandboxed bash / PreToolUse matcher 拡張 / plugin 管理の新機能等、本 workflow に取り込めるもの — これは CC 内蔵の claude-code-guide agent で自分で調査可能。OT 指示があれば実施。

---

## 5. 参考: 現在の未 push スタック

59eda8f..5b17774(12 commits、test 品質監査 G1-G3 + 追加対処 + test-only 規律制定 + hook 強制)。本 doc の commit もこの上に積む。
