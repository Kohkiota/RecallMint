# Codex plan cross-check — s2b-followup (2026-07-04)

- **作成日**: 2026-07-04
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

### A. 戻るリンク削除 + scroll-top

- scroll-top の対象は `window` ではなく `ExamCardTable` 内の `tableContainerRef`。実装位置は container ref と scroll 状態を持つ場所に寄せる必要がある。
- 「← 試験一覧」削除後も一覧導線はナビの「試験」で足りるが、`page.tsx` の `AppContainer(py-2)` をどう扱うかで card view/table view 両方の上部余白が変わる。意図したスペース節約か、table view だけ対象かを明確にすべき。
- scroll-top ボタンの表示条件が未確定。常時表示は先頭で無意味、非表示制御は scroll 監視が必要。B の collapse 信号と共有するか、独立した閾値にするかが論点。
- 既存の選択時 action bar が `fixed inset-x-0 bottom-0 z-40` で下端全幅を覆うため、右下固定ボタンとクリック領域・z-index・視覚位置が競合する。
- mobile では bottom 固定要素、safe area、選択 action bar、仮想キーボード相当の viewport 変化で重なりやすい。`bottom-4` 固定だけでよいか確認が必要。
- `scrollTo({ behavior: 'smooth' })` は仮想化 table と相性確認が必要。jank や中間状態の collapse/expand 再評価が起きる可能性がある。
- アクセシビリティとして `aria-label`、キーボード操作、focus ring、ボタンが非表示になるタイミングで focus を失うケースを考慮すべき。

### B. スクロール時の中間帯 collapse

- 中間帯が `exam-detail-view` の table chrome と `ExamCardTable` の ConditionBar wrapper に分かれているため、collapse 状態の所有者・伝播経路を決める必要がある。
- scroll 監視は container の `onScroll`。virtualizer も同じ scroll element を監視しているため、scroll handler は軽量化が必要。scroll ごとの React state 更新は避けるべき。
- collapse/expand の閾値は必須。単一閾値だと境界でちらつくため hysteresis が必要になりうる。
- collapse によって container の高さが変わり、`scrollHeight/clientHeight/maxScroll` が変わる。短いコンテンツでは scrollTop clamp による collapse/expand ループが起きうる。
- collapse 方式は重要。`display:none`、高さ 0、transform、grid rows などで、レイアウト再計算・transition・sticky thead・popover anchor・virtualizer resize への影響が変わる。
- collapse 中も thead sticky と行の連続性を壊してはいけない。thead の `top-0` が container 相対であること、app-header との見た目上の積み重なりを smoke で確認すべき。
- scroll 保持仕様との関係を明確化すべき。collapse は scrollTop を書き換えないが、container 高変化で見える行が変わるため「保持」の体感が変わる可能性がある。
- 条件バー内の popover/filter editor が開いた状態で collapse した場合、anchor が隠れて popover だけ残る可能性がある。閉じる・維持する・先送りする判断が必要。
- 前回仕様「タイトル常時表示」の撤回は spec に明示が必要。実装者が S2 仕様を参照して逆方向に戻すリスクがある。
- collapsed 状態は table view 専用に閉じるべき。card view、inline 編集、side peek 未実装領域へ状態や props が漏れると回帰範囲が広がる。

### C. 条件バー 2 ゾーン + tags 個別 chip

- 現行の `deriveConditions` は 1 filter = 1 chip の generic 投影。tags だけ option 単位複数 chip にするため、generic 契約を壊すのか、render 層の局所特例にするのかを固定すべき。
- predicate 層は不変にする要件があるため、chip の × は TagFilterValue の再構築で表現する必要がある。判定ロジック側に option 単位概念を足すべきではない。
- TagFilterValue はカテゴリ間 AND / カテゴリ内 OR。個別 chip 表示は UX 上はフラットに見えるため、カテゴリ単位の論理構造が見えにくくなる可能性がある。
- tag chip の色は option 色を使うが、既存 badge と同じ `colorToClass` 経路を使わないと表示差分やテーマ差分が出る。
- option/category が削除済み、または lookup 不能な filter value が残っている場合でも、解除不能な chip を作らない fallback が必要。
- `condition-chip-filter-tags` は複数 chip で衝突するため testid 一意化が必要。optionId の文字種が testid として安全か、必要なら sanitize 方針も検討すべき。
- sort chip から「並び替え:」を消すと、左ゾーンや区切りがない場合に sort/filter の意味が見えにくくなる。ゾーン構造で補えるか確認が必要。
- 「クリア」ボタンの `ml-auto` と flex-wrap の組み合わせで、mobile やタグ多数時にレイアウトが不自然になる可能性がある。
- tags chip body を popover trigger として維持するか、× のみ操作可能にするかで操作モデルが変わる。Notion 準拠をどこまで優先するか判断が必要。
- chip 内の × と popover trigger のイベント伝播を明確にすべき。× クリックで popover が開く、または chip flip/toggle と競合するリスクがある。
- sort chip の click flip、×解除、filter chip の解除、全クリアの既存挙動は維持対象。見た目変更に伴うイベントハンドラ再配置で壊れやすい。

## plan ドラフトへの抜け・未考慮指摘

- **safe area / mobile bottom offset が薄い**  
  action bar 競合は扱っているが、iOS Safari 等の safe-area inset、mobile viewport 下端、bottom 固定ボタンの実配置への言及が不足している。`bottom-4` だけで smoke 対象にしているが、設計判断として safe area を使うかは未整理。

- **focus/アクセシビリティの扱いが不足**  
  scroll-top の `aria-label` はあるが、非表示化されるボタンに focus がある場合、collapse/expand 中の focus、chip × の accessible name、色付き tag chip の色以外の識別などが plan にない。

- **testid の sanitize 方針が未記載**  
  `condition-chip-filter-tags-{optionId}` は良いが、optionId に test selector 上扱いにくい文字が入る可能性をどう見るかが未考慮。実データが UUID 等なら明記で足りる。

- **tag chip のイベント伝播リスクが十分に明文化されていない**  
  body を `CardTagAddPopover` trigger 維持とする場合、× クリック時に popover trigger が発火しないこと、chip 全体クリックと remove 操作が衝突しないことを test 観点に入れるべき。

- **tag filter の論理構造の見え方が未考慮**  
  個別 chip 化で `{カテゴリ名}: {option名}` は表示されるが、カテゴリ間 AND / カテゴリ内 OR の意味が UI 上は分かりづらくなる。Notion 準拠として許容するなら、その判断を残した方がよい。

- **collapse 中の open popover は「先回り実装しない」だけで停止条件が曖昧**  
  smoke で実害があれば検討、とあるが、何を実害とするかが未定義。浮いた popoverが操作不能、画面外、誤操作誘発なら対応対象、程度の判定基準があるとよい。

- **collapse transition と reduced motion が未考慮**  
  grid transition を推奨しているが、`prefers-reduced-motion` への配慮がない。既存方針がなければ、少なくとも過度な animation にならないことを確認対象にすべき。

- **collapse 状態の初期化タイミングが未記載**  
  view 切替、exam id 変更、table unmount/remount、データ再取得後に collapsed が残るか戻るかの扱いが plan にない。scrollTop が先頭なのに chrome が畳まれたままになる状態を避ける必要がある。

- **container ref が null の間の state 同期が未記載**  
  onScroll/scrollTo/virtualizer/getScrollElement の前提として ref null 時の扱いは実装で自然に必要。大きな論点ではないが、テスト設計には入れてよい。

- **ConditionBar 多数 chip 時の clear ボタン配置が弱い**  
  `ml-auto` 維持とあるが、2 ゾーン化 + flex-wrap + タグ多数 + mobile で「クリア」がどこに回るかが未検討。smoke にはあるが、レイアウト方針として固定しきれていない。

- **A と B の結合度が上がる点のリスクが薄い**  
  scroll-top 表示を `collapsed` に連動させる方針は妥当だが、A が B の状態機械に依存する。将来 collapse 閾値と scroll-top 表示閾値を分けたくなる可能性は記録してよい。

- **`AppContainer` 撤去の影響範囲がやや楽観的**  
  `ExamDetailPullGate` が null render とはいえ、wrapper 削除で page 全体の余白・幅制約・card view の見え方が変わる。plan は「意図どおり」としているが、table view 以外の snapshot/smoke 確認が必要。

## リスク / 対立しうる設計判断

- **scroll-top 表示条件**  
  `collapsed` 連動は状態を共有できる一方、collapse と scroll-top の UX 閾値が密結合になる。独立閾値は柔軟だが状態管理が増える。

- **選択中 scroll-top 非表示 vs 重ねて出す**  
  非表示は競合回避が明快。ただし選択中に大量スクロールしたユーザーは先頭復帰導線を失う。重ねて出すなら action bar 側の pointer-events/z-index/配置調整が必要。

- **collapse 方式**  
  grid transition は可変高に強く unmount しない利点があるが、transition と virtualizer resize、popover anchor で副作用が出る可能性がある。`hidden` は単純だが状態保持や見た目の滑らかさで劣る。

- **collapse 閾値の厳密さ**  
  低い閾値はすぐ広い表領域を得られるが、少し触っただけで chrome が消える。高い閾値は安定するが Notion 的な即時性が弱くなる。

- **tags 特例の局所化 vs Condition model 拡張**  
  render 層の `columnId === 'tags'` 特例は今回の回帰範囲を小さくできる。一方、将来ほかの filter も複数 chip 化するなら Condition model 側に「1 condition から複数 chip」を表現する拡張が必要になる。

- **tag chip body を popover trigger にするか**  
  維持すれば既存編集導線と連続するが、個別 chip の「この条件を表す表示」と「タグ選択 editor を開く操作」が混ざる。× のみ操作可能にすれば明快だが、既存 UX から後退する。

- **タグ色の強さ**  
  タグのみ色付きは要件どおりだが、chip 数が多いと条件バーの視覚ノイズが増える。既存 tag badge と同じ控えめな色体系に寄せるべき。

- **短コンテンツ guard**  
  guard はちらつきを抑えるが、少しだけ overflow する画面では collapse しない可能性がある。Notion 準拠の挙動と安定性のどちらを優先するかの判断になる。