#!/bin/bash
# Stop hook: 直前 commit が feat/fix なら以下を検査
#   (A) [reviewed] / [no-review] tag 不在 → decision: block で停止
#   (B) tag あり → additionalContext で sprint 完了 gate を warning リマインド
#
# 設計意図 (2026-06-11 訂正):
# - tag あり時の lint リマインドは hook 内で実 lint を走らせない (応答ごとに
#   数十秒は重い)。 確実な強制は CLAUDE.md「Sprint 完了 gate」 と review
#   checklist 側で行い、 hook は 3 段目のリマインドという位置付け。
# - additionalContext は decision: block と排他。 block は tag 無し時のみ使い、
#   tag あり時は hookSpecificOutput.additionalContext で会話継続のまま CC に
#   注意喚起テキストを届ける (Stop hook 公式仕様)。
# - JSON 出力は Python json モジュールで構築 (devcontainer に jq が無い環境
#   でも動くよう jq 依存を排除、 旧 hook で silent fail していた事故を回避)。
set -u

cd "$CLAUDE_PROJECT_DIR" || exit 0

LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null)
[[ -z "$LAST_MSG" ]] && exit 0

# 対象は feat/fix のみ (scope ありなし両対応)
if ! printf '%s\n' "$LAST_MSG" | head -1 | grep -qE '^(feat|fix)(\(.+\))?:'; then
  exit 0
fi

SHORT_HASH=$(git log -1 --pretty=%h)
SUBJECT=$(git log -1 --pretty=%s)
if [[ ${#SUBJECT} -gt 60 ]]; then
  SUBJECT="${SUBJECT:0:60}..."
fi

# (B) [reviewed] / [no-review] tag あり → 完了 gate リマインドを warning で
if printf '%s\n' "$LAST_MSG" | grep -qE '\[(reviewed|no-review)\]'; then
  HASH="$SHORT_HASH" SUBJECT="$SUBJECT" python3 -c '
import json, os
ctx = (
    "sprint 完了 gate リマインド (commit: " + os.environ["HASH"] + " " + os.environ["SUBJECT"] + "):\n\n"
    "- whole-repo `pnpm lint`(--max-warnings=0) exit 0 を確認すること (lefthook は staged-only のため穴あり)\n"
    "- 依存 / Next / Node / lockfile を触った sprint は追加で `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` も実行\n"
    "- これらは CLAUDE.md「Sprint 完了 gate」 セクション参照、 sprint 完了報告 chat に「whole-repo lint exit 0 確認済」 を 1 行明記\n"
    "- 確実な強制は CLAUDE.md 規律 + review checklist 側 (本リマインドは 3 段目)"
)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "Stop",
        "additionalContext": ctx,
    }
}, ensure_ascii=False))
'
  exit 0
fi

# (A) tag 無し → block (decision: block と additionalContext は排他)
HASH="$SHORT_HASH" SUBJECT="$SUBJECT" python3 -c '
import json, os
reason = (
    "直前の feat/fix commit に [reviewed] / [no-review] tag がありません。\n\n"
    "commit: " + os.environ["HASH"] + " " + os.environ["SUBJECT"] + "\n\n"
    "ルール:\n"
    "- feat/fix commit は canonical review 経路を通すこと: controller が `superpowers:requesting-code-review` skill を起動 + general-purpose subagent で template 改変なし dispatch (implementer subagent は nested dispatch 不可ゆえ controller 責務)\n"
    "- review pass 後の commit 時に [reviewed] tag を付与するのが原則 (後付け amend が発生しない運用が正)\n"
    "- typo 修正や緊急 revert 等、 意図的に review 不要な場合は [no-review] tag を付けること\n"
    "- sprint 完了 gate (whole-repo `pnpm lint`(--max-warnings=0) exit 0) も忘れず確認 (CLAUDE.md「Sprint 完了 gate」)\n\n"
    "対処選択肢 (優先順):\n"
    "1. 新 commit で対応: review pass 後の next commit に [reviewed] を含める。 review 不要なら revert / cleanup commit に [no-review] を付ける\n"
    "2. revert して review からやり直し: `git revert <hash>` で取り消し、 review pass 後に再 commit\n"
    "3. amend (未 push 時のみ可、 push 済への amend は force-with-lease を強い最悪手): `git commit --amend` で [reviewed] / [no-review] 追記。 -i は禁止、 push 済 commit は選択肢 1 / 2 を取ること\n\n"
    "ユーザーに状況を報告し、 1-3 の選択肢を提示してから次のタスクに進むこと。 勝手に amend しないこと。"
)
print(json.dumps({
    "decision": "block",
    "reason": reason,
}, ensure_ascii=False))
'

exit 0
