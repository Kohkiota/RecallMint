#!/usr/bin/env python3
"""Stop hook: hook_input.last_assistant_message を Discord に分割送信

Claude Code セッション通知専用の webhook。 アプリのエラー通知 (lib/ops.ts の
notifyOps) は別 channel の OPS_DISCORD_WEBHOOK_URL を使うため、 本 hook は
CLAUDE_CODE_DISCORD_WEBHOOK_URL を参照 (channel 混線防止)。

URL は OS 環境変数 → .env.local の順で参照。 .env.local は Next.js が読むが
Stop hook の Python プロセスには伝播しないため、 hook 内で自前 parse する。
"""

import json
import os
import sys
import time
import urllib.request


ENV_KEY = "CLAUDE_CODE_DISCORD_WEBHOOK_URL"


def load_env_local(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                env[key] = value
    except OSError:
        pass
    return env


project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
WEBHOOK_URL = os.environ.get(ENV_KEY) or load_env_local(
    os.path.join(project_dir, ".env.local")
).get(ENV_KEY, "")
if not WEBHOOK_URL:
    sys.exit(0)

CHUNK_SIZE = 1800  # Discord 上限 2000 - ヘッダー余白
SEND_INTERVAL = 0.5  # rate limit 緩和 (5/sec 上限内)
POST_TIMEOUT = 5

try:
    hook_input = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# background task 完了までの中間 Stop を抑止し、最終 Stop でだけ通知する。
# Claude Code v2.1.x の Stop/SubagentStop 拡張入力は稼働中 background task を
# background_tasks に載せる(list 形状は 2026-07-18 に実測 238 Stop 分で確認済)。
# 残っている中間 Stop では送らず、全 background 完了後(background_tasks 空)の
# Stop でのみ Discord へ。フィールド不在の版では None → 従来どおり毎回通知(安全側の既定)。
#
# debug 記録は opt-in のみ(CLAUDE_HOOK_DEBUG=1 で hook 入力の関連フィールドを追記)。
# 常時記録は形状検証完了に伴い 2026-07-18 に撤去(C1)。
if os.environ.get("CLAUDE_HOOK_DEBUG") == "1":
    try:
        with open("/tmp/claude-stop-hook-debug.jsonl", "a", encoding="utf-8") as _dbg:
            _dbg.write(
                json.dumps(
                    {
                        "ts": time.time(),
                        "background_tasks": hook_input.get("background_tasks"),
                        "session_crons": hook_input.get("session_crons"),
                        "stop_hook_active": hook_input.get("stop_hook_active"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    except OSError:
        pass

if hook_input.get("background_tasks"):
    sys.exit(0)

project = os.path.basename(project_dir)


def split_chunks(text: str, size: int) -> list[str]:
    """改行境界優先で size 以下に分割"""
    chunks = []
    while len(text) > size:
        cut = text.rfind("\n", 0, size)
        if cut < size // 2:
            cut = size
        chunks.append(text[:cut].rstrip())
        text = text[cut:].lstrip("\n")
    if text.strip():
        chunks.append(text)
    return chunks


def post(content: str) -> None:
    data = json.dumps({"content": content}).encode("utf-8")
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "claude-code-stop-hook/1.0",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=POST_TIMEOUT)
    except Exception:
        pass


body = hook_input.get("last_assistant_message") or ""
if not body.strip():
    body = "(本文取得失敗 — terminal を確認)"

chunks = split_chunks(body, CHUNK_SIZE)
total = len(chunks)

for i, chunk in enumerate(chunks, 1):
    if i == 1:
        header = f"🛑 **[{project}]** Claude Code 停止"
        if total > 1:
            header += f" (1/{total})"
        content = f"{header}\n\n{chunk}"
    else:
        content = f"**({i}/{total})**\n\n{chunk}"

    post(content)
    if i < total:
        time.sleep(SEND_INTERVAL)

sys.exit(0)
