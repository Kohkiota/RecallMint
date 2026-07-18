#!/bin/bash
# -----------------------------------------------------------------------------
# Dev Container 初回作成時のセットアップスクリプト
#
# 設計方針(2026-07-18 C1): 各 step は「実行した」でなく postcondition(効いて
# いる)を検証し、不成立なら non-zero で build を落とす。背景 = 旧 chrome-devtools
# sed patch が no-op でも「patched」と出力し続けた(静かに壊れるクラス)反省。
# 検証不能な step は検証を捏造せず、その旨をコメントで明示する。
#
# - npm prefix を ~/.npm-global に変更 (EACCES 対策)
# - pnpm / Claude Code / Stripe CLI / TypeScript LSP / Codex CLI を install
# - Google Chrome を install (playwright MCP が --browser chrome で使用)
# - Plugin 登録: claude-plugins-official (typescript-lsp)
# - superpowers + frontend-design は .claude/settings.json で auto-enable
# - MCP (playwright / context7) は tracked の .mcp.json が正本(post-create 登録なし)
# - chrome-devtools plugin は 2026-07-18 に撤去(transcript 実測で成功 0 件。
#   再導入レシピは docs/superpowers/sessions/2026-07-18-c1-workflow-cleanup-execution.md)
#
# 前提: postCreateCommand は workspace root を cwd に実行する(package.json 相対参照)。
# -----------------------------------------------------------------------------

set -euo pipefail

fail() { echo "✗ POSTCONDITION FAIL: $*" >&2; exit 1; }

CODEX_VERSION="0.144.5"  # exact pin 必須: フラグ仕様が版で変わる実績。更新は contract gate 必須 (README §7.3)

echo "==> [1/8] npm global prefix"
mkdir -p ~/.npm-global ~/.local/bin "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
npm config set prefix ~/.npm-global
if ! grep -q ".npm-global/bin" ~/.bashrc 2>/dev/null; then
  echo 'export PATH=~/.local/bin:~/.npm-global/bin:$PATH' >> ~/.bashrc
fi
export PATH=~/.local/bin:~/.npm-global/bin:$PATH
[ "$(npm config get prefix)" = "$HOME/.npm-global" ] \
  || fail "npm prefix が ~/.npm-global でない: $(npm config get prefix)"

echo "==> [2/8] pnpm (corepack install: package.json packageManager field 準拠)"
corepack enable
corepack install
pnpm config set store-dir ~/.local/share/pnpm-store
# packageManager は "pnpm@X.Y.Z" 形式(+sha 付きも許容して版部分のみ比較)
PNPM_EXPECTED="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
[ "$(pnpm --version)" = "$PNPM_EXPECTED" ] \
  || fail "pnpm $(pnpm --version) != packageManager field ${PNPM_EXPECTED}"

echo "==> [3/8] Claude Code (native installer, stable channel)"
# 旧 npm-global 版が残ると PATH 次第で拾われるので消す(冪等)
npm uninstall -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
curl -fsSL https://claude.ai/install.sh | bash -s stable
export PATH="$HOME/.local/bin:$PATH"
hash -r
claude --version >/dev/null || fail "claude CLI が起動しない"

echo "==> [4/8] Stripe CLI"
if ! command -v stripe &> /dev/null; then
  curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
    | gpg --dearmor -o /usr/share/keyrings/stripe.gpg
  echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
    > /etc/apt/sources.list.d/stripe.list
  apt-get update -qq && apt-get install -y -qq stripe
fi
stripe --version >/dev/null || fail "stripe CLI が起動しない"

echo "==> [5/8] TypeScript Language Server + Codex CLI"
npm install -g typescript typescript-language-server
typescript-language-server --version >/dev/null || fail "typescript-language-server が起動しない"
# Codex: 認証は手動 codex login (ChatGPT) 運用 = API key passthrough なし。
# bwrap 回避のため scripts/ai は danger-full-access + git clean detector で read-only 運用。
npm install -g "@openai/codex@${CODEX_VERSION}"
codex --version | grep -qF "$CODEX_VERSION" \
  || fail "codex 版が pin ${CODEX_VERSION} と不一致: $(codex --version)"

echo "==> [6/8] Google Chrome (playwright MCP 用)"
# playwright MCP は --browser chrome 指定で system Chrome を使う (自前 chromium 不要)
if ! command -v google-chrome &> /dev/null; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq && apt-get install -y -qq google-chrome-stable
fi
google-chrome --version >/dev/null || fail "google-chrome が起動しない"

echo "==> [7/8] Plugin 登録"
# claude-plugins-official: docs 上 "auto-available" だが clean 状態の named volume
# では未登録のため明示 add が必須。既存時は "already exists" で exit 1 を返すため
# || true で吸収し、成立は postcondition 側で担保する。
claude plugin marketplace add anthropics/claude-plugins-official 2>&1 \
  | sed 's/^/    /' || true
# postcondition 注記: CLI に機械可読な照会が無いため list 出力の grep(形式変更に弱い。
# 形式変更で落ちたらここを更新)。SIGPIPE/pipefail 誤爆を避けるため変数に受けてから grep。
MKT_LIST="$(claude plugin marketplace list 2>/dev/null || true)"
grep -q "claude-plugins-official" <<<"$MKT_LIST" \
  || fail "marketplace claude-plugins-official が未登録"

# typescript-lsp: 編集直後の型エラー / 参照 / 定義ジャンプ
claude plugin install typescript-lsp@claude-plugins-official 2>&1 \
  | sed 's/^/    /' || true
PLUGIN_LIST="$(claude plugin list 2>/dev/null || true)"
grep -q "typescript-lsp" <<<"$PLUGIN_LIST" || fail "typescript-lsp plugin が未導入"

# 検証不能(捏造しない)の明示:
# - superpowers / frontend-design は project .claude/settings.json の enabledPlugins を
#   初回 claude セッションが解決するため、post-create 時点では確認手段がない。
# - MCP (playwright / context7) は .mcp.json を初回セッションが読む。fresh clone では
#   承認プロンプトが 1 回出る(既存 workspace では .claude/settings.local.json の
#   enabledMcpjsonServers が残るため出ない)。

echo "==> [8/8] PostgreSQL 17 (統合テスト test:iso 用 常駐 cluster)"
# Iso-1: 実 PG 2 テナント統合テストの乗り物。手動適用と乖離しないよう独立 script に
# 分離し、ここから呼ぶ(pg-setup.sh が正本・冪等・postcondition 内蔵)。
bash .devcontainer/pg-setup.sh

echo "==> バージョン確認 (summary)"
node --version
pnpm --version
claude --version
stripe --version
codex --version
typescript-language-server --version
google-chrome --version
psql --version

cat << 'EOF'

=== Container Ready ===
Model:       global settings 準拠 (project pin なし)
Plugins:     superpowers, frontend-design (project settings で auto-enable)
             typescript-lsp (post-create で install)
MCP servers: playwright, context7 (.mcp.json が正本)
=======================

次のコマンド:
  claude

課金プロジェクト:
  stripe login
  stripe listen --forward-to localhost:3000/api/webhooks/stripe

ブラウザ: google-chrome (playwright MCP: --browser chrome)

EOF
