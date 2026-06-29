#!/usr/bin/env bash
# 保存 md(codex exec review の findings)から重大度別件数を集計し "CRIT IMP MIN" を出力。
# マッピング: P0/P1 → Critical, P2 → Important, P3/P4 → Minor。
#
# なぜ行頭 bullet に anchor するか: findings は `- [Pn] title — file:line` の bullet 行で
# 描画される(codex exec review --uncommitted の実出力で確認)。行頭 `- [Pn]` に固定する
# ことで、ヘッダや prose 中の素の "P0/P1" 表記(例: 重大度マッピングの説明行)を finding と
# 誤集計しない。bracketed `[Pn]` は codex の finding tag 専用で、素の Pn とは別語彙。
set -uo pipefail

MD="${1:?usage: count-findings.sh <md-file>}"

# grep -c は一致行数を返す(0 一致でも "0" を出力し exit 1 → set -e 無効で安全)。
count_p() { grep -cE "^[[:space:]]*-[[:space:]]*\[P$1\]" "$MD"; }

P0=$(count_p 0); P1=$(count_p 1); P2=$(count_p 2); P3=$(count_p 3); P4=$(count_p 4)
echo "$((P0 + P1)) $P2 $((P3 + P4))"
