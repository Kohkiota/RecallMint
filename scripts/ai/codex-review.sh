#!/usr/bin/env bash
# Codex 独立レビュー(read-only)を1回実行し、findings を docs/codex/ に保存して
# 判定材料を提示する。fix ループ自体は回さない — 反復は CC 本体が担う(canonical の
# fix ループと同じ責務分担。下記「責務分担」参照)。
#
# 責務分担:
#   - 本 script  = 「1 回の Codex review 実行 + 結果保存 + 判定材料(P 別件数)の提示」
#   - CC 本体    = 保存 md を読み Critical(P0/P1)/Important(P2) を抽出 → working tree を
#                  修正(修正主体は CC、Codex は指摘のみ)→ 再実行を収束まで反復(上限 3 周)
#
# read-only 担保(danger-full-access は bwrap 回避目的で物理書込可能ゆえ):
#   ① 危険フラグ(codex apply / --dangerously-bypass-* / --add-dir)を一切渡さない
#   ② git clean detector = 実行前後の「内容ベース」snapshot 一致検証(worktree-snapshot.sh)
#
# exit code(「走り切ったか」レイヤー。pass 判定とは別):
#   0   = 正常実行 + detector PASS(Codex は何も書いていない)。※レビュー pass の意味ではない
#   3   = git clean detector FAIL(Codex が working tree を書き換えた = 重大違反)
#   124 = codex timeout
#   その他非0 = codex 異常終了(codex は findings 有無では 0 を返すため、非0 は真の異常)
# pass 判定(「未解決 Critical 0 かつ Important 0」)は exit code でなく保存 md を CC が読む。
set -uo pipefail

TOPIC="${1:-review}"
# path traversal 防止: TOPIC は出力 file 名に入るため許可文字を制限。
if [[ ! "$TOPIC" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: TOPIC は [A-Za-z0-9._-] のみ可(received: '${TOPIC}')" >&2
  exit 2
fi
TIMEOUT="${CODEX_REVIEW_TIMEOUT:-600}"
DATE="$(date +%F)"
OUT_DIR="docs/codex"
OUT_FILE="${OUT_DIR}/${DATE}-${TOPIC}.md"
RAW_FILE="$(mktemp)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

snapshot() { bash "${SCRIPT_DIR}/worktree-snapshot.sh" | sha256sum; }

mkdir -p "$OUT_DIR"

# --- git clean detector: 実行前 内容スナップショット ---
SNAP_BEFORE="$(snapshot)"

# --- Codex 実走(read-only 運用 / bwrap 回避 / 1ショット上限)---
timeout "$TIMEOUT" codex exec review --uncommitted \
  -c sandbox_mode="danger-full-access" \
  -o "$RAW_FILE"
CODEX_EXIT=$?

# --- git clean detector: 実行後 内容スナップショット(出力 file を書く前に取得)---
SNAP_AFTER="$(snapshot)"

# --- findings を ヘッダ付きで docs/codex に保存(失敗時も保存する)---
{
  echo "# Codex independent review — ${TOPIC} (${DATE})"
  echo ""
  echo "- **作成日**: ${DATE}"
  echo "- **review 経路**: \`codex exec review --uncommitted\` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)"
  echo "- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)"
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
if [[ "$CODEX_EXIT" -eq 124 ]]; then
  echo "ERROR: codex timeout(${TIMEOUT}s 超過)。保存: ${OUT_FILE}" >&2
  exit 124
fi
if [[ "$CODEX_EXIT" -ne 0 ]]; then
  echo "ERROR: codex 異常終了 exit=${CODEX_EXIT}。保存: ${OUT_FILE}" >&2
  exit "$CODEX_EXIT"
fi

# --- 判定材料: P 別件数を Critical/Important/Minor に集計(CC の収束判定の補助)---
# 集計ロジックは count-findings.sh に分離(fixture test で parsing を pin)。
read -r CRIT IMP MIN <<<"$(bash "${SCRIPT_DIR}/count-findings.sh" "$OUT_FILE")"

echo "===== Codex review 完了 ====="
echo "git clean detector: PASS(Codex は working tree を書き換えていない)"
echo "findings: Critical(P0/P1)=${CRIT}  Important(P2)=${IMP}  Minor(P3/P4)=${MIN}"
echo "saved: ${OUT_FILE}"
echo "→ pass 判定は CC が ${OUT_FILE} を読み「未解決 Critical 0 かつ Important 0」で収束(上限 3 周)"
