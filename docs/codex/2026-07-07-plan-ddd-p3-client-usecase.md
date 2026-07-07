# Codex plan cross-check — ddd-p3-client-usecase (2026-07-07)

- **作成日**: 2026-07-07
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **最上位制約は挙動不変**。API/Dexie/outbox/op/log/文言だけでなく、enqueue 件数・順序・patch shape・rollback 意味論・flush タイミングも凍結対象として扱う必要がある。

- **V3 は「正規化重複の解消」ではない**。実体は、空文字→null 正規化 1 箇所、カード新規 patch 構築、options commit patch 構築が分散している問題。設計上は pure builder / normalizer の所在整理が中心。

- **直 tx 6 箇所の helper 寄せは単なる置換ではない**。現行は Dexie transaction の reject 伝播に UI が依存する箇所があるため、helper 側の silent catch 既定と衝突する。`throwOnError`、logger、flush、rollback の意味論を個別に合わせる必要がある。

- **tags manager との単一 source 化はリスク付き**。同形 cascade delete が存在しても、impact 集計、削除順、enqueue patch、UI エラー処理、dialog/フォーム状態が同一とは限らない。共通 use-case 化前に差分吸収方針が必要。

- **read 側 V2 は意図的に温存する境界**。useLiveQuery を lib/use-case に押し込むと、D-1/N-5 の「client repository 層を作らない」と衝突する。mirror 購読は presentation の責務として残すのが自然。

- **side peek 複製解消では subscription invariant が最重要**。共通 component が新規購読を持つと、単一 subscription 排他が壊れる。共通化は props-driven な表示ブロック抽出に限定すべき。

- **V6 blur 依存は温存対象**。InlineOptionCell に commit-on-unmount が無いことに close commit が依存しているため、W4/W5 で commit 機構を統合すると挙動変更になる。

- **inline primitive 共有は低次に留めるべき**。見た目文字列、dirty guard、auto-resize は共有可能だが、debounce drain / commit-on-unmount / blur commit は意味が違う。

- **テスト戦略は「ゼロから構築」ではなく gap pin**。既存 co-located test は厚いので、地雷 invariant の未 pin と cross-component flow だけを足す設計が妥当。

- **jsdom で担保不能な残余がある**。実 focus/blur、virtualizer 実 scroll、scroll 起因 unmount commit は unit/integration では限界がある。E2E を入れないなら、stg smoke への明示的な申し送りが必要。

- **TagEditCallbacks は型設計の論点**。placeholder dead code の削除は単純削除ではなく、bulk 経路と cardId-bound 経路の違いを型でどう表すかの判断になる。

- **移動と書換えは分離すべき**。as-is 移設、helper 寄せ、型 optional 化、manager 統一を混ぜると bisect 不能になり、挙動差分の帰属が曖昧になる。

- **lint 回収は設計境界の可視化でもある**。単なる lint 修正ではなく、cross-feature import を解消するのか allowlist 化するのか、architecture decision として扱う必要がある。

- **per-task review/gate の粒度が重要**。特に W1/W2/W4 は地雷直上なので、対象 suite だけでなく build と独立 review が必要。

## plan ドラフトへの抜け・未考慮指摘

- **概ね主要論点は拾えている**。W0 先行、移動/書換え分離、直 tx の `throwOnError`、tags manager 独立 task、V6 温存、E2E 不採用の stg smoke 送りは、主入力から導かれる重要点と整合している。

- **Task1 の「verbatim 移動」の定義がやや曖昧**。`lib/tags/tag-crud.ts` に移す際、import path、export surface、test re-point は不可避に変わる。許容される非 verbatim 差分を「import/export のみ」と明記した方がよい。

- **Task1 で `lib/tags` に置く境界の説明が不足**。関数が Dexie、flush、logger、型、UI callback 型をどこまで import するかによって、`lib/tags` が application service なのか pure domain helper なのかが曖昧になる。`lib/tags` 内の層分けまたは命名規約を決めておくべき。

- **Task0 の統合 flow test は flake 対策が不足**。fake-indexeddb、useLiveQuery、debounce/blur、flush mock を組み合わせるため、timer 制御、DB cleanup、outbox drain 待ち条件を明記しないと不安定化しやすい。

- **Task2 の helper 寄せで新規 logger 出力が増える可能性**。silent catch 既定でも logger.warn が出るなら、D-2 の log 凍結と衝突しないか確認条件が必要。

- **Task2 の `runOptimisticCreate` 適用条件がまだ粗い**。既存 create が id 採番、sort key、created_at/updated_at、enqueue payload をどう作っているかを、helper の生成規約と照合する受け入れ条件が欲しい。

- **Task3 の manager 統一は UI 状態差分も比較対象に入れるべき**。plan は mutation 差分中心だが、manager 側の dialog close、error message、loading state、impact count 表示が exams 側 use-case に引きずられないかも見る必要がある。

- **Task4 の `react-hooks/refs: off` 判定結果の扱いが弱い**。据え置き可能としているが、P3 surface として残すなら、残存 override の期限・理由・次工程を docs に残す条件を完了条件へ入れるべき。

- **Task5 の共通 component 抽出で render 性能/identity の確認が不足**。virtualizer や memo 凍結があるため、props 化により row subtree の再 render 頻度や callback identity が変わらないか確認観点を足した方がよい。

- **Task6 の dirty-guard 共有は挙動差の同一性確認が必要**。条件順だけの差とされているが、render-phase sentinel は微妙な挙動を持つため、抽出前後で StrictMode/再 render 時の差が出ないことを明示したい。

- **Task7 の optional 化で型の意味は改善するが、呼び出し側 UX の明示が不足**。`createOptionAndAssign` が無い状態で create UI を出す/出さない、押せる/押せない、エラーになる/ならないの期待を明文化した方がよい。

- **Task8 の allowlist は恒久化リスクがある**。allowlist 化する項目ごとに「意図的境界違反」「一時的負債」「P4 送り」など分類を残さないと、lint が単なる免除リストになる。

- **Task9 の docs 更新対象に spec/plan 実績差分の反映が明示されていない**。実装中に判断が変わる可能性があるため、SSoT と baseline だけでなく、plan の実績欄や該当 spec への反映責務を明確にした方がよい。

## リスク / 対立しうる設計判断

- **helper 寄せ vs 挙動不変**  
  helper に寄せるほど重複は減るが、error propagation、logger、flush、transaction boundary が変わるリスクがある。

- **tags manager 統一 vs scope 制御**  
  単一 source 化は設計上きれいだが、P3 の blast radius を広げる。差分が見つかった場合は無理に統一せず、別 task 化する判断も妥当。

- **共通 component 抽出 vs presentation 差分の保持**  
  side peek と inline list は近いが同一ではない。props が増えすぎるなら、抽象化による複雑化が重複削減を上回る可能性がある。

- **inline primitive 共有 vs commit セマンティクス統一への誘惑**  
  低次共有に留める設計判断は正しいが、実装時に hook 化を広げると V6 依存を壊しやすい。

- **E2E 不採用 vs 残余リスク**  
  コスト判断として不採用は理解できるが、実 focus/blur と scroll 系は unit test では完全に担保できない。stg smoke の具体手順が曖昧だとリスクが残る。

- **allowlist 化 vs architecture 改善**  
  cross-feature import を可視化するだけで止めると、境界違反が固定化される。期限または再評価条件が必要。