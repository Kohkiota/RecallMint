# 変異が下流の自己修復ステップに打ち消され、red にならないことがある

**2026-08-10・asset レーン整合 sprint Task 8**(`tests/integration/pg/asset-gc.test.ts`)

## 何が起きたか

「A/B 2 枚の card が同一 asset を参照している間は mark してはならない」を実 SQL で pin する test を書き、red 検証として **`markSet` の `NOT EXISTS refs` を外す変異**を入れた。gate は 1 つだけ壊しており(既存教訓 `feedback_mutate_gates_individually_in_red_verification` に従っている)、当然 red になるはずだった。

**ならなかった。**

理由: `runReconciler` は mark 相で `markSet()` → `markClear()` を**続けて**呼ぶ。`buildReconcilerDeps` の `exec` は呼び出しごとに独立した tx を張って commit するため、変異した `markSet` は「参照中の asset に `unreferenced_at` を立てる」という**不正な書込を実際に確定させる**。ところが直後の `markClear`(`unreferenced_at IS NOT NULL AND EXISTS refs`)が、card B の ref がまだ生きているためにそれを**静かに元へ戻す**。

結果、**最終 DB 状態だけを見る assertion は変異前後で同じ**になる。test は緑のまま、pin は空振り。

## なぜ怖いか

- 個別変異という既存規律を守っても検出できない。「gate を 1 つずつ壊す」は**変異が観測点まで伝播する**ことを暗黙に仮定している
- 自己修復ステップは正しい実装では**望ましい**振る舞い(self-heal)なので、消すわけにいかない
- 空振りの pin は赤くならないので、放置すると「証明がある」という誤った安心だけが残る

## 対策

**最終状態でなく、中間の副作用そのものを assert する。**

この case では `UPDATE … RETURNING` の行数(`summary.marked` / `summary.cleared` / `summary.promoted`)を見た。これは各相の**直後の post-condition** であり、後続の相が補償する前に確定している。強化後は変異が再現性をもって fail した(`expected 1 to be +0`)。

## 一般化(次にこれを疑うべき合図)

- 検証対象の処理が **set → clear** / **mark → unmark** / **apply → compensate** のような**補償対を同一 run 内に持つ**とき
- 個別変異を入れたのに red にならないとき — **変異が効いていない**のか **効いたが打ち消された**のかを必ず切り分ける(前者は変異箇所の誤り、後者は観測点の誤り)
- 判定が「最終的にどうなったか」でしか観測されていないとき

関連: `feedback_mutate_gates_individually_in_red_verification`(gate は個別に壊す)/ `lesson_order_invariants_need_result_preserving_mutations`(順序の不変条件は結果が変わらない変異で検証する — 本件はその双対で、**結果が変わらないのに変異は効いている**ケース)。
