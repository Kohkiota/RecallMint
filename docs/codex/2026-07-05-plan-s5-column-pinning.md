# Codex plan cross-check — s5-column-pinning (2026-07-05)

- **作成日**: 2026-07-05
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **pinning state の正本を何にするか**
  - 要件上は「固定境界 1 本」が正本で、TanStack の `columnPinning.left` は描画用派生値。
  - `left` 配列を単列 API の `column.pin()` 任せにすると、押した列までの全列固定・列順維持・select 付随の要件を満たしにくい。
  - 境界 id と `left[]` の相互変換 helper が必要。

- **select/options の扱い**
  - select は「固定境界がある時だけ付随固定」だが、menu は持たない。
  - options は対象列ではないが、対象列の左側に存在するため、boundary が options より右なら pinned 領域に含まれる可能性がある。
  - ここは要件文の「対象列 = menu を持つ全列」と「押した列＋それより左の全列」の交差で、options を pinned 配列に含めるかを明確化すべき。

- **TanStack の列並び替え副作用**
  - `getHeaderGroups()` / `row.getVisibleCells()` が `[left, center, right]` に再順序化するため、`left[]` の順序が描画順に直結する。
  - `left[]` は実テーブル列順と同じ順序で生成しないと、見た目の列順が壊れる。
  - hidden 列が state に残る挙動は許容されるが、復帰時に意図どおり復活する前提を test すべき。

- **永続化 migration**
  - V1/V2 から V3 への読み取り互換が必要。
  - 書込は V3 へ寄せるとして、既存 `prefsLoaded` / `userInteractedRef` guard を壊すと、mount 直後に既存 prefs を上書きするリスクがある。
  - `view` / `hiddenColumns` と `pinnedBoundary` を同じ sync_meta key に保存するため、部分更新時に片方を落とさない設計が必要。

- **unknown / stale boundary**
  - 保存済み boundary が、将来の列削除・rename・schema 変更で未知 id になる可能性がある。
  - unknown は `[]` に正規化し、永続層で即破壊的に書き戻すか、ユーザー操作まで保持するかの方針が必要。

- **resize 中の sticky offset**
  - body が resize 中に memo 凍結されるため、`left` offset を React render 依存で td に直書きすると追従しない。
  - 既存 CSS 変数配布の延長で `--col-{id}-start` を table style に持たせるのが自然。
  - dependency に pinning / sizing / visibility のどれを含めるかが重要。

- **背景と hover**
  - pinned body cell は横スクロール時に下の cell と重なるため、不透過背景が必須。
  - 既存 `tr hover:bg-muted/50` は半透明なので、pinned td 側の hover 合成色を別途考慮しないと透け・色ズレが出る。

- **z-index の交差**
  - 既存 sticky header と新規 sticky column が交差する。
  - pinned header、通常 sticky header、pinned body、通常 body の階層を明示しないと、横スクロール時や hover 時に重なり順が破綻する。

- **separator 判定**
  - 境界列が hidden の場合、視覚上の最右 pinned 可視列に separator を出す必要がある。
  - 保存 boundary id そのものではなく、TanStack の可視 leaf 基準 API を使うのが妥当。

- **仮想行 spacer**
  - spacer `<tr>` は `colSpan={visibleColCount}` の空 td。
  - pinning による visible cell 並び替えと spacer の colSpan が干渉しないか、変更不要でよいかを確認する必要がある。

- **menu gate**
  - 要件では menu を持つ 9 列が対象。
  - 既存 gate が `canSort || filterEditor` なので、pinning だけを理由に menu が出る列を増やすのか、既存 menu 列だけに pinning item を追加するのかを明確にする必要がある。
  - select/options に menu を追加しない制約と衝突しないこと。

- **boundary null の完全回帰**
  - 固定なしでは select も含めて全列スクロール。
  - class/style/DOM 構造が増えると既存 UI や snapshot 的 test が壊れる可能性があるため、pinned 時だけ差分が出る設計が望ましい。

- **card view との関係**
  - card view は scope 外だが、prefs は exam view 共通。
  - table 側だけで使う pinning を card view 表示中に読み書きするか、table view 操作時だけ更新するかを確認すべき。

- **列 id の単一定義**
  - compute 用に列順を重複定義すると、将来列追加・削除で破綻する。
  - `examCardTableColumns` から導出するのが安全だが、columns module import による循環依存や test setup の副作用は確認対象。

- **テスト限界**
  - jsdom では sticky / scroll / 実 z-index / hover 色の実挙動は検証できない。
  - unit/component test に加えて、DevTools smoke で横スクロール、resize、hidden 復帰、300-card 体感を確認する必要がある。

## plan ドラフトへの抜け・未考慮指摘

- **options 列を pinned に含める前提が暗黙**
  - plan の `computePinnedLeft('tags')` 期待値に `options` が含まれている。
  - 要件の「対象列 = menu を持つ全列」とは別に、「対象外だが左側にある options は固定領域には含む」という判断が必要。plan は実装期待値には入れているが、設計判断として明文化が弱い。

- **`derivePinnedBoundary(state.left末尾)` は stale/対象外 id に弱い**
  - hidden は許容できるが、`left` 末尾が `options` や未知 id になった場合、boundary として保存されうる。
  - 通常 flow では helper 経由なので起きにくいが、永続データ破損・将来変更・外部 state injection を考えるなら、対象 boundary id だけを返す validation が必要。

- **V3 に保存する `pinnedBoundary` の schema が任意 string**
  - zod 上は `string | null` で、列 id enum ではない。
  - unknown を runtime で無害化する方針なら成立するが、保存時にも known boundary へ正規化するかは明記した方がよい。

- **load 時の userInteracted guard との相互作用がやや不足**
  - plan は guard に乗せるとあるが、load effect で `setColumnPinning` した後、persist effect が deps 変更で発火しないことの順序保証をもう少し具体化すべき。
  - 特に V2 load → V3 migration を「無操作 mount では書込なし」とするのか、「読み取り後に V3 へ migrate write する」のかが要件上曖昧。

- **card view 中の persist 方針が未明確**
  - `examViewPrefs` は view と table prefs を同居保存する。
  - card view への影響は scope 外だが、card view に切り替えた時に `pinnedBoundary` を保持して書くのか、table view state が未ロードなら null で潰す可能性がないか、plan では十分に見えていない。

- **columnVisibility と columnPinning の同時更新時の write race**
  - fire-and-forget 書込で、visibility 変更と pinning 変更が近接した場合に古い closure の書込が後勝ちしないか確認が必要。
  - 既存方式を踏襲するなら許容かもしれないが、V3 で保存対象が増えるためリスクは増える。

- **CSS 変数名の安全性**
  - `--col-{id}-start` は列 id に依存する。
  - 現 id は安全そうだが、将来 id に特殊文字が入ると CSS custom property として壊れる。既存 `--col-{id}-size` と同じ前提なら許容でよいが、明記は欲しい。

- **`columnSizeVars` deps に `table.getState().columnPinning` を入れる記述が粗い**
  - React deps として object identity が安定するか、既存 memo と同様に `columnPinning` state そのものを使うべきか検討余地がある。
  - `getStart('left')` が sizing に memo 依存するため、resize 中の再計算経路を test だけでなく実装方針として明確にした方がよい。

- **thead / th z-index の具体階層に矛盾余地**
  - plan は pinned th = `z-10` としているが、既存 thead も sticky `z-10`。
  - 「pinned-header > sticky-header」を満たすなら、pinned th は通常 header より高い z-index が必要になる可能性がある。

- **boundary null の DOM 一致条件が少し過剰または曖昧**
  - 「DOM が S4 時点と一致」とあるが、S5-2 で menu item 用 prop や handler の存在は DOM に出ない一方、test の書き方次第では脆くなる。
  - 本当に保証したいのは「sticky 関連 class/style/start 変数/separator が出ない」だと思われる。

- **right pinning の扱い**
  - `right` は常に `[]` とあるが、外部 updater 型 `OnChangeFn` は function updater も取りうる。
  - handler が function updater を受けた時にも `right` を空へ正規化するか、そもそも自前 direct object しか渡さない設計かを明確化すべき。

- **manual `onColumnPinningChange({ ... })` が OnChangeFn として十分か**
  - TanStack の `onColumnPinningChange` は updater を渡す可能性がある。
  - menu handler から controlled prop に直接 object を渡すのは成立するが、親 handler 側は updater/function の両対応が必要。

- **accessibility / keyboard 操作**
  - 既存 Popover/button に乗るなら大きな問題はないが、追加 menu item の aria / role / focus order / close behavior は明示されていない。
  - header menu の既存 pattern に従うだけでよいか確認対象。

- **横スクロール時の resize handle**
  - th は `relative` で resize handle が absolute。
  - pinned th に sticky/left/z を付けた時、resize handle のクリック領域や separator border と干渉しないか plan では触れていない。

## リスク / 対立しうる設計判断

- **boundary を永続正本にする vs `ColumnPinningState` を永続する**
  - boundary 保存は要件に合い、将来 columnOrder 非対応の現状では単純。
  - 一方、将来 columnOrder や右固定を入れる場合は migration が必要になる。

- **unknown boundary を保持する vs 即 null 化する**
  - 保持すれば将来列が戻った時に復活できる。
  - 即 null 化すれば状態は清潔だが、rename/一時非表示系の復元性は落ちる。

- **hidden pinned 列を state に残す vs visibility 変更時に pruning する**
  - 残す方が TanStack 挙動と要件「可視復帰で復活」に合う。
  - pruning すると視覚状態は単純だが、要件違反になりやすい。

- **options を固定領域に含める vs 対象列ではないので除外する**
  - 「それより左の全列」なら含めるのが自然。
  - 「対象列 = menu を持つ全列」を強く読むと除外したくなるが、除外すると列順や視覚連続性が壊れる可能性が高い。

- **pinned body の hover 色を CSS で合成する vs hover 時も bg-background 固定**
  - 合成色は既存 hover 体験に近い。
  - 固定背景は実装が単純だが、pinned 領域だけ hover 反応がなく見える。

- **V2 load 時に V3 migration write する vs ユーザー操作まで書かない**
  - 即 migration はデータ形式を早く揃えられる。
  - 書かない方が既存 guard と「無操作 mount で書込なし」に合う。

- **jsdom test で class/style を厚く見る vs smoke に寄せる**
  - class/style assert は回帰検出に強いが、実装詳細に脆い。
  - smoke 依存は実挙動に近いが、自動回帰検出が弱い。