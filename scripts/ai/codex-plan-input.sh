#!/usr/bin/env bash
# plan 段階 Codex 独立論点出しの stdin payload を組み立てて出力する(純粋・副作用なし)。
# 単体で testable にするため execution(codex 実行・detector)とは分離した。
#
# anchor 防止が肝: 「調査結果 + 要件」を主入力に置き、CC の plan ドラフトは参考添付に
# 留め、「承認しろ」とは言わない。まず独立に論点を導かせ、その後で plan の抜けを照合
# させる順序を指示する(plan を起点に確認させると Codex が引きずられ cross-check が死ぬ)。
set -uo pipefail

CONTEXT_FILE="${1:?usage: codex-plan-input.sh <context-file> [plan-file]}"
PLAN_FILE="${2:-}"

cat <<'PROMPT'
あなたは独立した設計レビュアーです。
**read-only: ファイル変更・コード修正・git mutate・apply は一切禁止。論点を出すだけ。**

タスク: 以下の「調査結果 + 要件」を主入力として、設計で考慮すべき論点・抜け・リスクを
独立に列挙せよ。その上で、参考添付の plan ドラフトに対する抜け・未考慮点を指摘せよ。

**重要(anchor 防止)**: plan ドラフトを起点に「これでよいか」を判断しないこと。
まず調査結果と要件から独立に論点を導き、その後で plan の抜けを照合する順序を厳守せよ。

出力フォーマット:
## 独立論点(調査結果 + 要件から導出)
## plan ドラフトへの抜け・未考慮指摘
## リスク / 対立しうる設計判断
PROMPT

printf '\n=== 調査結果 + 要件(主入力)===\n'
cat -- "$CONTEXT_FILE"

if [ -n "$PLAN_FILE" ]; then
  printf '\n=== 参考添付: plan ドラフト(承認対象ではない・抜け照合用)===\n'
  cat -- "$PLAN_FILE"
fi
