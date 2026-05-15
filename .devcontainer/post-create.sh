#!/bin/bash
# -----------------------------------------------------------------------------
# Dev Container 初回作成時のセットアップスクリプト
# - npm prefix を ~/.npm-global に変更 (EACCES 対策)
# - pnpm / Claude Code / Stripe CLI / TypeScript LSP バイナリを install
# - MCP / Plugin 登録: context7, typescript-lsp, chrome-devtools-mcp
# - Opus + Superpowers + frontend-design は .claude/settings.json で auto-enable
# -----------------------------------------------------------------------------

set -e

echo "==> [1/7] npm global prefix"
mkdir -p ~/.npm-global "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
npm config set prefix ~/.npm-global

if ! grep -q ".npm-global/bin" ~/.bashrc 2>/dev/null; then
  echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
fi
export PATH=~/.npm-global/bin:$PATH

echo "==> [2/7] pnpm"
npm install -g pnpm
pnpm config set store-dir ~/.local/share/pnpm-store

echo "==> [3/7] Claude Code"
npm install -g @anthropic-ai/claude-code

echo "==> [4/7] Stripe CLI"
if ! command -v stripe &> /dev/null; then
  curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
    | gpg --dearmor -o /usr/share/keyrings/stripe.gpg
  echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
    > /etc/apt/sources.list.d/stripe.list
  apt-get update -qq && apt-get install -y -qq stripe
fi

echo "==> [5/7] TypeScript Language Server (typescript-lsp プラグイン用)"
npm install -g typescript typescript-language-server

echo "==> [6/7] MCP / Plugin 登録"

# claude-plugins-official: docs 上 "auto-available" だが clean 状態の
# named volume では未登録のため明示 add が必須。既存時は "already exists" で
# exit 1 を返すため `|| true` で吸収。
echo "  - marketplace add: claude-plugins-official"
claude plugin marketplace add anthropics/claude-plugins-official 2>&1 \
  | sed 's/^/    /' || true

# chrome-devtools-plugins: 外部 marketplace (claude-plugins-official には無い)
echo "  - marketplace add: chrome-devtools-plugins"
claude plugin marketplace add ChromeDevTools/chrome-devtools-mcp 2>&1 \
  | sed 's/^/    /' || true

# context7 MCP (project scope) - 既存時 exit 1 仕様なので出力で判別
echo "  - MCP add: context7"
ctx7=$(claude mcp add context7 -- npx -y @upstash/context7-mcp@latest 2>&1) || true
if echo "$ctx7" | grep -qi "already exists"; then
  echo "    (既存 - skip)"
elif echo "$ctx7" | grep -qiE "added|success"; then
  echo "    (登録完了)"
else
  echo "    [WARN] $ctx7"
fi

# typescript-lsp: 編集直後の型エラー / 参照 / 定義ジャンプ
echo "  - plugin install: typescript-lsp@claude-plugins-official"
claude plugin install typescript-lsp@claude-plugins-official 2>&1 \
  | sed 's/^/    /' || echo "    [WARN] install 失敗"

# chrome-devtools-mcp: 生きてるブラウザの調査・perf trace・a11y 監査
echo "  - plugin install: chrome-devtools-mcp@chrome-devtools-plugins"
claude plugin install chrome-devtools-mcp@chrome-devtools-plugins 2>&1 \
  | sed 's/^/    /' || echo "    [WARN] install 失敗"

# 検証: 登録された marketplace / plugin の最終状態を出力
echo "  --- 最終状態 ---"
claude plugin marketplace list 2>&1 | sed 's/^/    /' || true
claude plugin list 2>&1 | sed 's/^/    /' || true

echo "==> [7/7] バージョン確認"
node --version
pnpm --version
claude --version
stripe --version
typescript-language-server --version 2>/dev/null || echo "(tsls: 確認失敗)"
npx --yes playwright --version 2>/dev/null || echo "(Playwright は image 同梱)"

cat << EOF

=== Container Ready ===
Model:       opus (from .claude/settings.json)
Plugins:     superpowers, frontend-design (auto-enabled)
             typescript-lsp, chrome-devtools-mcp (post-create で install)
MCP servers: playwright (project), context7 (project), chrome-devtools (plugin)
=======================

次のコマンド:
  claude
  /brainstorming

課金プロジェクト:
  stripe login
  stripe listen --forward-to localhost:3000/api/webhooks/stripe

noVNC: http://localhost:6080  (pw: vscode)
Chrome DevTools MCP で host Chrome に繋ぐ場合は別途 --remote-debugging-port=9222

EOF