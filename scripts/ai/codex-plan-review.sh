#!/usr/bin/env bash
# plan 確定前の Codex 独立論点出しを 1 回実行し docs/codex/ に保存する。
# レビュー版(codex-review.sh)との違い: diff レビューでなく設計論点出しのため、diff 専用の
# `codex exec review` は使わず `codex exec -` に stdin で plan 文脈を渡す。
# fix ループ・収束・3 周上限は無し(plan 確定前の 1 パス cross-check)。反映は CC 本体が担う。
#
# 部品流用(新規に同等物を作らない):
#   - stdin 組み立て(anchor 防止)= codex-plan-input.sh
#   - git clean detector(内容ベース・.git/hooks 含む)= worktree-snapshot.sh(レビュー版と共用)
#
# read-only 担保: 危険フラグ(codex apply / --dangerously-bypass-* / --add-dir)皆無 + detector。
# exit code(走破レイヤー、Task C と同じ 2 レイヤー分離。論点出しゆえ pass 判定は無い):
#   0 = 正常 + detector PASS / 3 = detector FAIL / 124 = timeout / 他 = codex 異常
set -uo pipefail

TOPIC="${1:?usage: codex-plan-review.sh <topic> <context-file> [plan-file]}"
if [[ ! "$TOPIC" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: TOPIC は [A-Za-z0-9._-] のみ可(received: '${TOPIC}')" >&2
  exit 2
fi
CONTEXT_FILE="${2:?usage: codex-plan-review.sh <topic> <context-file> [plan-file]}"
PLAN_FILE="${3:-}"
[[ -f "$CONTEXT_FILE" ]] || { echo "ERROR: context-file 不在: ${CONTEXT_FILE}" >&2; exit 2; }
[[ -z "$PLAN_FILE" || -f "$PLAN_FILE" ]] || { echo "ERROR: plan-file 不在: ${PLAN_FILE}" >&2; exit 2; }

TIMEOUT="${CODEX_REVIEW_TIMEOUT:-600}"
DATE="$(date +%F)"
OUT_DIR="docs/codex"
# `plan-` prefix で review 版(codex-review.sh)の出力と file 名 namespace を分離し、
# 同一 date/topic での silent 上書きを防ぐ(reviewer Minor #2)。
OUT_FILE="${OUT_DIR}/${DATE}-plan-${TOPIC}.md"
RAW_FILE="$(mktemp)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

snapshot() { bash "${SCRIPT_DIR}/worktree-snapshot.sh" | sha256sum; }

mkdir -p "$OUT_DIR"

# --- git clean detector: 実行前 内容スナップショット ---
SNAP_BEFORE="$(snapshot)"

# --- Codex 実走(read-only 運用 / bwrap 回避は danger-full-access / 1ショット上限)---
bash "${SCRIPT_DIR}/codex-plan-input.sh" "$CONTEXT_FILE" "$PLAN_FILE" \
  | timeout "$TIMEOUT" codex exec - -s danger-full-access -o "$RAW_FILE"
# PIPESTATUS を直後に確保し input 組み立て失敗と codex 失敗を正確に区別(reviewer Minor #1)。
# pipefail に頼ると左側(input.sh)の失敗が codex の失敗として誤ラベルされる。
PSTAT=("${PIPESTATUS[@]}")
INPUT_EXIT="${PSTAT[0]}"
CODEX_EXIT="${PSTAT[1]}"

# --- git clean detector: 実行後 内容スナップショット(出力 file を書く前に取得)---
SNAP_AFTER="$(snapshot)"

# --- 論点を ヘッダ付きで docs/codex に保存(失敗時も保存)---
{
  echo "# Codex plan cross-check — ${TOPIC} (${DATE})"
  echo ""
  echo "- **作成日**: ${DATE}"
  echo "- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)"
  echo "- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない"
  echo "- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)"
  echo "- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)"
  echo ""
  echo "---"
  echo ""
  cat "$RAW_FILE"
} > "$OUT_FILE"
rm -f "$RAW_FILE"

# --- 失敗レイヤーの評価(detector を最優先 → codex 異常 → timeout)---
if [[ "$SNAP_BEFORE" != "$SNAP_AFTER" ]]; then
  echo "ERROR: git clean detector FAIL — Codex が working tree を書き換えた(read-only 違反)" >&2
  echo "  保存: ${OUT_FILE}(失敗時保存)" >&2
  exit 3
fi
if [[ "$INPUT_EXIT" -ne 0 ]]; then
  echo "ERROR: plan 入力組み立て失敗(codex-plan-input.sh exit=${INPUT_EXIT})。保存: ${OUT_FILE}" >&2
  exit 2
fi
if [[ "$CODEX_EXIT" -eq 124 ]]; then
  echo "ERROR: codex timeout(${TIMEOUT}s 超過)。保存: ${OUT_FILE}" >&2
  exit 124
fi
if [[ "$CODEX_EXIT" -ne 0 ]]; then
  echo "ERROR: codex 異常終了 exit=${CODEX_EXIT}。保存: ${OUT_FILE}" >&2
  exit "$CODEX_EXIT"
fi

echo "===== Codex plan cross-check 完了 ====="
echo "git clean detector: PASS(Codex は working tree を書き換えていない)"
echo "saved: ${OUT_FILE}"
echo "→ CC は ${OUT_FILE} の論点を自身の plan と突き合わせ、統合して OT に提示せよ(fix ループなし・1 パス)"
