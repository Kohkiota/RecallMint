# subagent dispatch prompt で [reviewed] 先付与を許可しない

> **Source**: 2026-06-12 T-C1 (Sprint Y-2 Sub-plan C) で `8e07ab0` 巻き戻し事案。

subagent dispatch prompt に **[reviewed] 先付与を許可する文言を入れない**。 review pass → commit ([reviewed] 込み) の一方向則 (CLAUDE.md §Review と Commit) は subagent にも適用。 **commit tag 付与権を subagent に委任しない** (2026-06-12 T-C1 `8e07ab0` 巻き戻し事案: CC が implementer subagent の dispatch prompt に「最小コミット粒度のため一旦 [reviewed] 付き commit してよい」 と書いた結果、 自己 review のみで [reviewed] 先付与 = 規律違反 → `git reset --soft HEAD~1` 巻き戻し → 正規 spec compliance + canonical `requesting-code-review/code-reviewer.md` 通過後に `8fad41a` 再 commit で訂正)。

dispatch prompt template (`subagent-driven-development/implementer-prompt.md` 等) には元々この文言が含まれていない = **template 修正は不要、 ad-hoc dispatch 文言で過剰委任しないことが鍵**。 次セッションの自分はこの経緯を記憶しないため、 self-discipline 単独では再発しうる。 本 lesson が記録として残ることで再発防止材料となる。
