#!/usr/bin/env bash
# 作業ツリーの「変更内容」スナップショットを stdout に出力する。
# codex-review.sh の git clean detector 用。porcelain 状態(パス + 状態文字)でなく
# 内容ベース: tracked の HEAD 差分 + untracked file の実内容を連結する。
#
# なぜ内容ベースか: danger-full-access 下で Codex は物理書込可能で、detector が唯一の
# ガード。porcelain 比較では ①既に dirty な file の中身を書き換えても(状態 ` M` のまま)
# ②既に untracked な dir 内に新 file を足しても(dir が `??` で畳まれたまま)状態が変わらず
# 誤って PASS する。内容を埋め込めば両ケースとも snapshot 差分として現れる。
#
# 制約(accepted residual risk): `--exclude-standard` で .gitignore を尊重するため、
# gitignore 済みパス(node_modules / .next / .env* 等)への書込は本 snapshot の検出対象外。
# これらは container 隔離境界 + codex review モードの read-only 意図(defense-in-depth)で
# カバーし、source 整合性には影響しない前提。例外は .git/hooks(下記で明示的に含める)。
set -uo pipefail

# tracked: staged + unstaged を HEAD と内容比較(binary は "Binary files differ" 行)
git diff HEAD 2>/dev/null

# untracked(.gitignore 尊重): file 単位で列挙し内容を埋め込む。
# ls-files --others は untracked dir を畳まず file 単位で全列挙するため、
# 既存 untracked dir 内の新規 file も個別に現れる。
git ls-files --others --exclude-standard -z 2>/dev/null \
  | LC_ALL=C sort -z \
  | while IFS= read -r -d '' f; do
      printf '\n==UNTRACKED:%s==\n' "$f"
      cat -- "$f" 2>/dev/null
    done

# .git/hooks: gitignore 対象外だが danger-full-access 下で hook を書かれると次の git
# 操作で実行される(唯一の execution-persistence vector)。明示的に内容を含めて検出する。
# *.sample は git init 既定の雛形ゆえ除外(常在・不変でノイズ)。
HOOKS_DIR="$(git rev-parse --git-path hooks 2>/dev/null)"
if [ -n "$HOOKS_DIR" ] && [ -d "$HOOKS_DIR" ]; then
  find "$HOOKS_DIR" -type f ! -name '*.sample' -print0 2>/dev/null \
    | LC_ALL=C sort -z \
    | while IFS= read -r -d '' h; do
        printf '\n==HOOK:%s==\n' "${h#"$HOOKS_DIR"/}"
        cat -- "$h" 2>/dev/null
      done
fi
