# Codex plan cross-check — s3-sorts (2026-07-05)

- **作成日**: 2026-07-05
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **sort_key の降順時 NULLS LAST 要件の扱い**
   - 要件は「数値文字列・NULLS LAST・順序 index」とあるため、昇順だけでなく降順でも NULLS LAST なのかを明確化すべき。
   - 既存 `sortLikeServer` が TanStack の降順反転で NULL が先頭化しないか、または comparator 自体が方向非依存で NULLS LAST を保証できるかが設計論点。

2. **sort_key は“数値文字列”として比較すべき**
   - 連番順なら `"2"` と `"10"` は数値順で `"2" < "10"`。
   - `sortLikeServer 相当`が本当に数値文字列を数値順で扱うのか、辞書順なのかを確認・固定する必要がある。

3. **タグ代表値の “先頭タグ” 判定で created_at の tie-break を落とさない**
   - 要件上の表示順は `category sort_key ASC NULLS LAST → option sort_key ASC NULLS LAST → created_at ASC`。
   - category/option comparator を組み合わせるだけだと、最後の `created_at` tie-break が category 側・option 側・タグ行側のどれなのか曖昧になりやすい。

4. **タグ同値 tiebreak = 連番順の実現方法**
   - 要件は「同値 tiebreak = 連番順へフォールバックで安定」。
   - stable sort + pre-sort 依存で満たす設計は、TanStack の multi-sort、row model 再生成、pagination/virtualization、データ更新後の順序保持に依存する。明示 comparator で `sortLikeServer` fallback するか、stable 依存を仕様として許容するか判断が必要。

5. **accessorFn と filterFn の共存**
   - tags 列は既に `filterFn=tagsFilterFn` を持つ。
   - `accessorFn` をタグ代表値 string に変えると、既存 filterFn が `row.original.tags` を見る実装なら問題ないが、`row.getValue('tags')` 前提なら壊れる。filterFn の参照元を設計上固定すべき。

6. **タグ列 header の UX/アクセシビリティ**
   - ソートとタグフィルタが同じ header に同居するため、クリック領域、キーボード操作、フォーカス復帰、Popover 閉鎖条件、aria label/testid の整理が必要。
   - nested popover の可否だけでなく、ソート選択後に filter editor が閉じる/残る挙動も確認対象。

7. **問題文ソート撤去後の既存 sorting state**
   - URL/state/local storage/条件バー等に `question` sort が残っていた場合、列が `getCanSort=false` になった後にどう扱われるか。
   - 無効 sorting state を無視するのか、正規化して消すのか、chip が残らないかを確認すべき。

8. **列可視・非表示列の sort chip**
   - title/sort_key/tags が sortable 化されることで、列が非表示でも sort 状態や chip がどう見えるか。
   - 既存 generic 経路で問題ない前提でも、新規列での可視性連動は回帰対象。

9. **localeCompare('ja') の仕様固定**
   - `localeCompare('ja')` は環境や ICU によって細部が変わる可能性がある。
   - テストで厳密な日本語照合順を大量に固定しすぎると脆い。必要最小限のサンプル選定が必要。

10. **InlineTextField 編集後のソート再評価**
   - title/sort_key は cell が編集可能。
   - 編集直後に sorting row model が再計算されるか、入力中に行が移動する UX を許容するか、保存後のみ反映かを確認すべき。

11. **ソートキー編集中の不正値/空値**
   - 要件は数値文字列・NULLS LASTだが、UI 編集中に空文字や非数値が入りうるなら comparator の扱いを決める必要がある。
   - DB/domain 層で必ず正規化済みなら、その前提を明記すべき。

12. **初期連番順とユーザー明示 sort の境界**
   - `sorting=[] + liveData pre-sort` は初期状態専用。
   - ユーザーが sort を解除した瞬間に pre-sort へ戻ること、問題文撤去後も clear sort で連番順に戻ることを明示的に検証すべき。

## plan ドラフトへの抜け・未考慮指摘

1. **sort_key 降順と NULLS LAST が曖昧**
   - plan は `sortLikeServer` 継承と書く一方で「direction 反転時の挙動は sortLikeServer の定義に従う」としており、要件の NULLS LAST を降順でも満たすかが未確定。
   - ここは plan 上で仕様を固定すべきです。

2. **`sortLikeServer` を“辞書順”と書いている点が危険**
   - plan D-2 に「sort_key 辞書順 ASC」とあるが、主入力は「数値文字列・順序 index」。
   - 実装関数が数値比較なら文言が誤り、辞書順なら要件と衝突します。

3. **tags sortingFn の記述が TanStack API 的に不正確**
   - plan に `sortingFn = (a,b)=>String(a.getValue('tags')).localeCompare(...)` とあるが、TanStack の `sortingFn` は通常 `(rowA,rowB,columnId)`。
   - `a.getValue('tags')` を固定文字列で読むのか `columnId` を使うのか、また undefined が sortingFn に来ない前提が本当に成り立つかを明確化すべきです。

4. **`sortUndefined:'last'` と custom sortingFn の相互作用確認が不足**
   - plan は「undefined は sortingFn へ来る前に TanStack が末尾へ寄せる」としているが、バージョン依存・設定依存の可能性があります。
   - この前提はテストだけでなく、実装前提として確認対象に入れるべきです。

5. **タグ先頭判定の pseudo code が created_at を十分に表現していない**
   - pseudo code は category comparator と option comparator の合成に見え、タグ行単位の `created_at ASC` が曖昧です。
   - TagCell と完全共有する comparator/API を使う方針を、コード形までより強く縛るべきです。

6. **問題文 sort state の残留対策がない**
   - `question` を sortable から外した後、既存 state に `{id:'question'}` が残るケースへの扱いが plan にありません。
   - 条件バー chip、header 表示、clear sort、初期化時の正規化の確認が必要です。

7. **編集後再ソート UX が未記載**
   - title/sort_key は InlineTextField なので、ソート中に編集した場合の行移動タイミングが未考慮です。
   - 特に sort_key 編集中に即並び替えされると操作性に影響します。

8. **非表示列での sort/chip 挙動が未検証**
   - plan は列可視を壊さないと書くが、新規 sortable 列が非表示のときの chip 表示・解除・再表示時の状態復元確認がありません。

9. **H-1 の失敗判定がやや広すぎるが具体基準が弱い**
   - 「開閉・クリップ・フォーカス破綻」とあるが、何をもって H-2 へ切替えるかの最低基準が曖昧です。
   - 例: filter 選択後に menu が閉じて値が反映不能、外側 popover にクリップされる、Esc/外クリックで状態が壊れる、など。

10. **registry 追加の具体確認が薄い**
   - 主入力は「S1 capability-driven menu + registry へ登録追加」としているが、plan は ColumnDef に寄せており、registry 側に明示的な追加・確認が必要かが曖昧です。
   - generic 条件バーが ColumnDef header だけで足りるなら、その前提を明記すべきです。

## リスク / 対立しうる設計判断

1. **明示 tiebreak comparator vs stable sort 依存**
   - 明示的に `sortLikeServer` fallback を入れると要件は強く満たせるが、TanStack の安定ソート前提より実装が増える。
   - stable sort 依存は簡潔だが、将来の row model 変更に弱い。

2. **tags header H-1 vs H-2**
   - H-1 は既存 `ColumnHeaderMenu` に統合できるが nested popover リスクが高い。
   - H-2 は堅牢になりやすいが、tags だけ独自 UI になり header 一貫性が落ちる。

3. **sort_key comparator を既存 `sortLikeServer` に寄せる vs 専用 comparator 化**
   - 既存流用は挙動継承が楽。
   - ただし sort_key 列の責務が「数値文字列 NULLS LAST」なら、専用 comparator の方が仕様を読みやすく、問題文撤去とも分離しやすい。

4. **localeCompare テストの厳密化 vs 可搬性**
   - 日本語ソート仕様を厳密に固定すると安心だが、環境差で脆くなる。
   - 要件確認に必要な最小ケースへ絞る判断が必要。

5. **編集即時ソート vs 保存後ソート**
   - 即時ソートは状態に忠実だが、編集中に行が移動する可能性がある。
   - 保存後のみ反映なら UX は安定するが、既存データフローと合わない可能性がある。