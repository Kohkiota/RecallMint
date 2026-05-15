#!/bin/bash
# Stop hook: 直前 commit が feat/fix なら [reviewed] / [no-review] tag を検査
set -u

cd "$CLAUDE_PROJECT_DIR" || exit 0

LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null)
[[ -z "$LAST_MSG" ]] && exit 0

# 対象は feat/fix のみ (scope ありなし両対応)
if ! printf '%s\n' "$LAST_MSG" | head -1 | grep -qE '^(feat|fix)(\(.+\))?:'; then
  exit 0
fi

# [reviewed] または [no-review] tag があれば pass
if printf '%s\n' "$LAST_MSG" | grep -qE '\[(reviewed|no-review)\]'; then
  exit 0
fi

# block: hash と subject (60 文字で切り詰め) を抽出して JSON 生成
SHORT_HASH=$(git log -1 --pretty=%h)
SUBJECT=$(git log -1 --pretty=%s)
if [[ ${#SUBJECT} -gt 60 ]]; then
  SUBJECT="${SUBJECT:0:60}..."
fi

jq -n \
  --arg hash "$SHORT_HASH" \
  --arg subject "$SUBJECT" \
  '{
    decision: "block",
    reason: ("直前の feat/fix commit に [reviewed] / [no-review] tag がありません。\n\ncommit: " + $hash + " " + $subject + "\n\nルール:\n- feat/fix commit は superpowers:code-reviewer subagent による formal review 完了後、[reviewed] tag を commit message に付与する\n- general-purpose agent 等での review 代替は禁止\n- typo 修正や緊急 revert 等、意図的に review 不要な場合は [no-review] tag を付けること\n\n対処選択肢:\n1. code-reviewer subagent で formal review 実施 → git commit --amend で [reviewed] 追記\n2. 意図的にスキップする正当な理由がある場合 (typo / revert 等) → ユーザーに確認取り、git commit --amend で [no-review] 追記\n3. revert して review からやり直し\n\nユーザーに状況を報告し、1-3 の選択肢を提示してから次のタスクに進むこと。勝手に amend しないこと。")
  }'

exit 0
