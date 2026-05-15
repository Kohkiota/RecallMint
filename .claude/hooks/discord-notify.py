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
