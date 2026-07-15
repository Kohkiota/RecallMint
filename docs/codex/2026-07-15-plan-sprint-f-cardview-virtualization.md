# Codex plan cross-check — sprint-f-cardview-virtualization (2026-07-15)

- **作成日**: 2026-07-15
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **修正の主軸は仮想化で妥当だが、正しさの前提が先に必要**
  - freeze 原因は未仮想化の O(N) 再レンダー + layout で、ループではない。
  - ただし仮想化は unmount/remount を通常動作に変えるため、`newCardIds` consume と `InlineOptionCell` commit-on-unmount が先に必要。
  - branch の途中状態でも「仮想化あり・ガードなし」を作らない順序制約は設計上かなり重要。

- **window virtualizer 固有の設計リスク**
  - 既存 T2 は内部 scroll container + `useVirtualizer`、カードビューは page flow なので `useWindowVirtualizer` 前提。
  - `scrollMargin`、リスト先頭 offset、window scroll との原点合わせが必要。
  - top/bottom spacer を native flow に入れる場合、既存 `space-y-*` の margin は `measureElement` に含まれず高さ drift の原因になる。
  - spacer と実 row をテスト上区別できる識別子、例 `data-index`、が必要。

- **動的行高への対処が中核**
  - 多択 + explanation 常時表示で row height が極端に大きくなる。
  - `estimateSize` は適当値ではなく 300 件 seed の実測中央値を根拠付きで置く必要がある。
  - `scrollToIndex` は estimate 前提なので、動的行高では着地点がずれる可能性がある。
  - `measureElement` による補正後の scroll jitter、空白帯、overscan 過不足は smoke で重点確認すべき。

- **追加カード UX は仮想化で壊れやすい**
  - 既存は mount → focus → browser scroll-into-view に依存している。
  - 仮想化後は off-screen row が mount されないため、追加直後に `scrollToIndex` で mount させる必要がある。
  - `newCardIds` consume は「初回 mount で auto-edit を発火させた後」に行う必要がある。

- **commit-on-unmount はデータ保全だが、orphan mutation リスクがある**
  - `InlineTextField` には既存実装があるが、option にはない。
  - 仮想化後は option 編集中 scroll-out で unmount されるため、未保存値が消える。
  - 一方で `runOptimisticUpdate` は missing row でも enqueue するため、削除済 card への unmount commit は orphan mutation になりうる。
  - unmount 経路だけ存在確認 gate が必要。blur 経路と混ぜない設計がよい。

- **二重 commit 防止が必要**
  - blur 後すぐ unmount するケースで blur commit と cleanup commit が二重発火しないようにする必要がある。
  - 既存 `InlineTextField` と同じく latest ref を同期更新して cleanup を skip させる設計が妥当。

- **テストは jsdom の限界を前提に切り分ける必要がある**
  - jsdom は実 layout / scroll 精度を保証できない。
  - unit では「有界窓」「実 unmount cleanup」「scrollToIndex 呼び出し」程度まで。
  - row count は spacer を除外しないと false positive になる。
  - 実際の freeze 解消、scroll jitter、追加カード着地は OT 人力 smoke に委譲するしかない。

- **失敗時の判断線を明確にする必要がある**
  - 修正後も 300 件で freeze するなら、仮想化で追加緩和を積むのではなく root cause 前提を再検証すべき。
  - memo、debounce、overscan 調整などを場当たり的に重ねると原因を隠す。

## plan ドラフトへの抜け・未考慮指摘

- **W0 と W1 の境界は概ねよいが、W1 test の実 unmount 方法が曖昧**
  - 「key 変更 or rerender」で実 unmount とあるが、どの component 境界を unmount するかが曖昧。
  - `InlineCardRow` 単体を test 可能にするのか、list 全体で card の出し入れを再現するのかを明確にした方がよい。
  - 誤ると「row が本当に unmount/remount していない」空振り test になる。

- **S1 と S2 の分割により、途中で追加カード UX が壊れた状態ができる**
  - 要件の絶対禁止は「仮想化あり・ガードなし」だが、実用上は S1 後 S2 前に「仮想化あり・追加カード可視化なし」になる。
  - commit 単位でレビューするなら許容かもしれないが、branch 内健全性を重視するなら S1/S2 を同一 phase/commit にまとめるか、S1 時点で追加 UX を一時的に壊すことを明示すべき。

- **`scrollToIndex` の option が spec と plan で微妙にずれている**
  - spec は「新 card の位置・align end」としている一方、plan S2 は `{ align: 'auto' }`。
  - 動的行高 mitigation の観点では、どちらを採用するか判断理由が必要。
  - 追加カードが末尾追加なら `end` の方が期待 UX に近い可能性がある。

- **ESTIMATED_CARD_HEIGHT 実測の実行可能性が弱い**
  - plan は DevTools MCP evaluate 前提だが、ローカル/stg 到達不能時の代替が「seed データ形状から導出」となっている。
  - 要件は「300 件 seed 実測中央値・根拠記録」なので、代替値を許すなら OT 承認条件や blocker 扱いを明確にすべき。
  - 実測できないまま進めると、要件逸脱になりうる。

- **有界窓 test は row count 条件だけでは spacer 高さの破綻を検出しない**
  - `li[data-index]` で spacer 除外する点はよい。
  - ただし top/bottom spacer の高さが NaN、負数、極端値になる不具合は row count だけでは見逃す。
  - 最低限 spacer style height / padding の finite non-negative assert を追加する余地がある。

- **`scrollMargin` 更新タイミングが未設計**
  - list 先頭 offset は初回 render 後、viewport resize、上部コンテンツ変化で変わりうる。
  - plan では「scrollMargin=リスト先頭 offset」とだけあり、測定・更新・ResizeObserver/scroll recalculation の扱いが未記述。
  - 見出し、toolbar、追加ボタン、responsive layout が絡むなら drift の原因になる。

- **`measureElement` ref と React ref composition の扱いが未記述**
  - `InlineCardRow` に `ref={measureElement}` を足す場合、既存 ref がないなら単純だが、将来拡張や row component 抽出後の forwardRef 要否を明確にしたい。
  - component に ref を渡すには `forwardRef` が必要。`li` を親 map 側に残すのか、row component 内に持たせるのかで実装が変わる。

- **option unmount save の async cleanup リスクが明記不足**
  - cleanup から `getClientDb().cards.get(cardId)` を経由するなら async になる可能性がある。
  - React cleanup 自体は await できないため、fire-and-forget の失敗扱い、test の待ち方、unhandled rejection 防止を明記すべき。
  - 既存 `InlineTextField` の同型実装に合わせるなら、その具体的パターンを plan に書いた方が安全。

- **final gate の `pnpm test` 全 green は現実コストが高い可能性**
  - repo 規模によっては全 test が重すぎる、flaky、環境依存の可能性がある。
  - 要件上は whole-repo lint が必須として強く書かれている一方、全 test 必須は plan 側の上乗せ。
  - 実行不能時の扱いを事前に決めるべき。

## リスク / 対立しうる設計判断

- **S1/S2 を分けるか、仮想化 commit に scrollToIndex まで含めるか**
  - 分ける利点: review 範囲が小さい。
  - 分けるリスク: 中間 commit で追加カード UX が壊れる。
  - 順序制約の精神を重く見るなら同一 phase が堅い。

- **`scrollToIndex` の align**
  - `end`: 末尾追加 UX と合いやすい。
  - `auto`: 可視時 no-op になりやすく余計な動きが少ない。
  - 動的行高下ではどちらも概算なので、最終位置は focus scroll に委ねる設計判断になる。

- **`ESTIMATED_CARD_HEIGHT` を実測 blocker にするか**
  - blocker にする: 要件準拠、性能根拠が残る。
  - 代替値を許す: 実装は進むが、scroll 精度・review 説得力が落ちる。

- **row spacing を padding 化する範囲**
  - li 内 padding に移すと測定は安定する。
  - ただし既存 responsive spacing の見た目差分が出やすい。
  - 視覚差分をどこまで許容するか smoke 観点が必要。

- **unmount commit の存在 gate を hook 側に置くか call site 側に置くか**
  - hook 側: option cell 実装者が踏みにくい。
  - call site 側: 現 scope では最小だが、同種実装が増えると地雷が残る。
  - 今回は局所 gate が妥当だが、follow-up 記録は必要。

- **仮想化だけで十分か、多択行高対策も同時に入れるか**
  - 今回入れない判断は scope 管理として妥当。
  - ただし scroll jitter や measure cost が残る可能性はある。
  - smoke で再燃条件を明確にして、追加緩和をその場で積まない線引きが重要。