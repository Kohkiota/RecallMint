# Codex independent review — sprint-t-t5-study-wiring (2026-07-17)

- **作成日**: 2026-07-17
- **review 経路**: `codex exec review --uncommitted` (sandbox_mode=danger-full-access / bwrap 回避 / read-only 運用)
- **修正主体**: CC 本体(Codex は指摘のみ。P0/P1=Critical / P2=Important / P3,P4=Minor)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

The patch adds table rendering for option text, but the table can be emitted inside inline/button markup, leaving a real correctness issue for table-containing choices.

Review comment:

- [P2] Avoid rendering Markdown tables inside inline spans — /workspaces/RecallMint/app/(app)/app/study/smart/_components/session-runner.tsx:484-484
  When an option body or option explanation contains a Markdown table, `MdTableText` emits a real `<table>` here while the parent is a `<span>` inside a `<button>`. That creates invalid HTML (`span > table`, and block table content inside a button), unlike the question/explanation paths that switch to a block wrapper to avoid nesting problems. This can produce browser/React nesting issues and inconsistent rendering for cards whose choices include tables.

---

## CC adjudication(fix-loop closeout・2026-07-17)

**判定: adjudicated-resolved(未解決 Important 0)。コード変更なし。**

この P2 は本実装が新たに持ち込んだリスクではなく、**凍結 spec §3.3 が明示的に weigh し OT §9 #2 で承認済の設計判断**(D の `span > table` / `button > table` nesting 受容)である。spec の受容理由:
- button の構造替え(`div role=button` 化)= disabled/focus/aria の再実装を伴い blast radius 過大。
- span 剥がし = 不変条件①(表 0 個 = DOM 同一)違反。

**実証(canonical review が React 実ソースで独立確認)**: `react-dom` の `findInvalidAncestorForTag` は `<table>` を `pTagInButtonScope`(= `<p>` 祖先)に対してのみ invalid 判定する。`<span>` / `<button>` 祖先は validateDOMNesting のチェック対象外 → **hydration 破壊なし・React dev warning なし**。加えて a/img 無効化ゆえ nested interactive も無く、click 領域競合も発生しない。T5 の nesting-warning spy test(question+option+explanation の 4 表を同時描画→judged)が PASS でこれを裏取り。

**帰結**: 修正(button→div 構造替え / block 化)は spec が却下した設計に反するため行わない。canonical review も「already adjudicated in frozen spec, no action」と同判定(Ready to merge)。session doc(T7)にも 1 行記録する。