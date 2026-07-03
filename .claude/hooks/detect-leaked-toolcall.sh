#!/usr/bin/env python3
# Stop hook: 最後の assistant メッセージ本文に「パースされず未実行のままテキスト漏れした
# ツール呼び出し」の痕跡が残っていないか検査し、残っていれば Stop を block して言い直しを促す。
#
# 背景 / 既知バグ: docs/superpowers/lessons/2026-07-03-malformed-toolcall-leak-investigation.md
#   正しい呼び出しは実行されて本文に痕跡を残さない。stray トークン + 名前空間なしタグで
#   plain text 化した場合のみ本文に痕跡が残る(Claude Code 既知バグ・harness 側未修正)。
#
# 設計:
#   - stop_hook_active=true なら即 exit 0(自動言い直しは 1 回まで。汚染セッションでは retry
#     自体が再発源=self-poisoning のため 2 回目以降は止めて人間に返す)。
#   - 検査対象は「最後の assistant エントリの text ブロックのみ」。ターン内で漏れ→自己修正して
#     実行済みのケースを block すると二重実行を誘発するため、それ以前は見ない。
#   - 判定は行アンカーの行単位(inline backtick 言及は行頭でないので誤検知しない)。
#   - 出力は検出時のみ block JSON を stdout へ(JSON 以外を混ぜない)。非検出は無出力 exit 0。
#   - reason に生の invoke/parameter タグ文字列を含めない(context 再汚染防止)。
import json, os, re, sys

def out_clean():
    sys.exit(0)

try:
    data = json.load(sys.stdin)
except Exception:
    out_clean()

# 無限ループ防止(必須)。
if data.get("stop_hook_active") is True:
    out_clean()

tp = data.get("transcript_path") or ""
if not tp or not os.path.isfile(tp):
    out_clean()

# 最後の assistant エントリを取得。
last = None
try:
    with open(tp, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") == "assistant":
                last = o
except Exception:
    out_clean()

if not last:
    out_clean()

content = last.get("message", {}).get("content")
if isinstance(content, list):
    text = "\n".join(
        b.get("text", "") for b in content
        if isinstance(b, dict) and b.get("type") == "text"
    )
elif isinstance(content, str):
    text = content
else:
    text = ""

if not text.strip():
    out_clean()

# 漏れた実呼び出しは必ず行頭(空白のみ先行)から始まる。stray トークン単独行も拾う。
patterns = [
    r"^\s*(court|call|count)\s*$",     # stray opener トークン
    r"^\s*<invoke\b",                   # 名前空間なし開始タグ
    r"^\s*<parameter\b",
    r"^\s*</invoke>\s*$",
]
leaked = any(
    re.search(p, text, re.MULTILINE) for p in patterns
)

if leaked:
    reason = (
        "直前のツール呼び出しがパースされず未実行のまま本文にテキスト漏れしている"
        "(既知の harness バグ・副作用なし)。まず git status 等で当該操作が後続で"
        "実行済みでないか確認し、実行済みなら再実行しない(二重実行禁止)。未実行なら、"
        "次の応答は prose を一切書かず、ツール呼び出しを 1 件だけ応答の先頭要素として"
        "正しい名前空間付き記法で再発行せよ。詳細: "
        "docs/superpowers/lessons/2026-07-03-malformed-toolcall-leak-investigation.md"
    )
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)

out_clean()
