# Codex plan cross-check — edit-4-side-peek (2026-06-30)

- **作成日**: 2026-06-30
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **peek の表示対象は「回答画面そのもの」ではなく「judged 風の確認表示」**
   - 回答主体が存在しないため、`currentCorrect` 由来の正解/不正解 banner は概念的に成立しない。
   - 一方で、正解ハイライト、○×、選択肢別解説、カード解説は card データだけで成立する。

2. **SessionRunner 共有の是非**
   - `session-runner.tsx` は回答フロー、FSRS、outbox、完了 flush を抱える prod-critical component。
   - side peek は表示専用で、必要入力も `ClientCard` の一部だけ。
   - 共有化すると回答フロー回帰リスクが大きい。peek 専用 presentational 複製は妥当な候補。
   - ただし複製するなら「回答画面に近い見た目」の将来 drift は受け入れる必要がある。

3. **active 行 state は rowSelection と分離すべき**
   - 既存 `rowSelection` は bulk action 用の複数選択。
   - peek の active 行は単一の確認対象。
   - 両者を同期すると「選択」と「閲覧」の意味が混ざる。

4. **active 行の整合性は可視集合 prune が最小限**
   - filter や削除で active 行が消えた場合、peek を閉じる必要がある。
   - それ以上の同期、再取得、fallback 選択は要件外であり、簡潔性規律に反する。

5. **snapshot ではなく liveData 参照が自然**
   - table 編集は Dexie mirror 直書きで、`useLiveQuery` 再評価が既存の反映経路。
   - `activeCardId` から現在の `liveData` を引けば、peek も編集内容に追従する。
   - snapshot を持つと stale 表示、同期コード、追加防御が必要になる。

6. **trigger は行クリック不可**
   - table cell 内に click-to-edit があるため、`tr` click は event bubble 競合を起こす。
   - 専用 trigger を title 列内に置く判断は要件と整合する。
   - ただし title 列は sticky-left なので、hover 表示、z-index、横スクロール、編集領域との干渉は実機確認が必要。

7. **desktop 専用 gate は CSS のみ**
   - repo 前例が `md:` ベースで、JS viewport 判定は前例ゼロ。
   - peek、trigger、2カラム shell は `hidden md:*` で閉じるべき。
   - mobile では既存 table 横スクロール到達性を壊さないことが主要条件。

8. **layout リスク**
   - 右 peek を足すことで table の横幅、sticky-left、overflow、ActionBar の位置関係が変わる。
   - table 左カラムには `min-w-0` と overflow 維持が必要。
   - peek 表示時でも hidden columns に依存せず全情報が見える必要がある。

9. **a11y / 操作性**
   - trigger が hover のみだと keyboard 到達性、focus 表示、screen reader label が論点になる。
   - 表示専用 peek に閉じる手段が必要か、また Esc で閉じるべきかは仕様判断が必要。
   - 「hover で出す」要件はあるが、keyboard-only ユーザー向けに focus 時も表示するかは未決。

10. **非インタラクティブ化の扱い**
   - SessionRunner の選択肢は button だが、peek は表示専用。
   - `button` を残すと操作可能に見えるため避けるべき。
   - ただし `div` 化する場合、見た目だけでなく cursor、focus、ARIA の不要化も確認対象。

11. **データ欠損・空状態**
   - `question_text`、`options`、`explanation_text` が空の場合の表示方針。
   - 要件上「prune 以外の防御コードを足さない」ため、過剰な fallback は避けるべきだが、既存回答画面の空値表示と差が出ないかは確認が必要。

12. **テストで担保できない領域**
   - CSS `md:` gate、hover、sticky、横スクロール、ActionBar との重なりは jsdom では不十分。
   - 実ブラウザ smoke が必須。

## plan ドラフトへの抜け・未考慮指摘

1. **keyboard / focus 対応が薄い**
   - trigger が hover 表示前提だが、keyboard focus 時にも出すか、Tab で到達できるか、accessible name をどうするかが明記されていない。
   - 「専用 trigger」は button であるべきだが、`aria-label`、focus ring、`group-focus-within` 相当の表示条件が plan にない。

2. **閉じる UI が Open Question のまま**
   - Q3 に残っているが、peek が開いた後にどう閉じるかは実装前に確定すべき。
   - active 行が prune されるまで閉じられない設計は確認 UI として弱い。
   - 最小でも明示的な close button は仕様化した方がよい。Esc 対応は設計判断。

3. **active 行の視覚的状態が未定義**
   - peek で開いている行を table 側で強調するかが plan にない。
   - 必須ではないが、side peek が従表示である以上、「今どの行を見ているか」は重要。
   - rowSelection と混ぜず、active 行だけの控えめな highlight を入れるか判断が必要。

4. **hover trigger と title 編集 UI のレイアウト衝突が十分に具体化されていない**
   - 「別クリック領域」とあるが、title cell 内の限られた幅で、長いタイトル、inline edit trigger、hover button がどう並ぶか未定。
   - button が title text を覆うのか、右端に常設スペースを取るのかで UX と layout shift が変わる。
   - sticky column 幅が狭い場合の text truncation / overlap の確認が必要。

5. **mobile gate の副作用確認が不足**
   - trigger を `hidden md:*` にするだけでなく、2カラム wrapper が mobile table の幅・overflow・sticky を変えないかを明示した方がよい。
   - mobile で余計な flex wrapper が table 横スクロールを壊すリスクがある。

6. **CardView の空データ表示方針が未記載**
   - options が空、選択肢 explanation が空、question_text が空の場合に SessionRunner と同じ表示になるか未確認。
   - 防御コード追加は禁止なので、既存描画の自然な結果を踏襲する、などの方針が必要。

7. **「回答画面に近い見た目」の維持範囲が曖昧**
   - class を移植するとあるが、peek 幅 `w-96` では SessionRunner の広いカードと折り返しが変わる。
   - 「同一」ではなく「近い」なら、side panel 向けの spacing/typography 調整を許すのか明記した方がよい。

8. **z-index / sticky / overlay の設計が smoke 任せ**
   - sticky-left と hover trigger の交差リスクは認識されているが、z-index 方針が plan にない。
   - 実装者裁量にすると、sticky header/left cell/peek/ActionBar の重なりで差分が出やすい。

9. **テスト項目に実装困難なものが混ざっている**
   - Task 2 の「setActiveCardId で state が立つ」は T2 単独では UI 消費がなく、RTL で直接観測しづらい。
   - T2 は prune ロジックを T3/T4 接続後に統合テストで確認する方が自然。
   - read-only review 観点では、task 分割と完了条件の粒度が少し不整合。

10. **columns 配線の方針が未確定**
   - `table.options.meta` か columns factory 引数かが未決。
   - 既存 meta パターンに合わせるとあるが、型拡張の場所、既存 column tests への影響、不要 re-render の有無は論点。

11. **liveData 参照の配列名に注意が必要**
   - 調査結果では table 行は `CardWithTags = { card, tags }`。
   - plan の例 `liveData?.find(c => c.id === activeCardId)` は shape とズレている可能性がある。
   - 実装時は `row.card.id` / `item.card.id` 相当で引く必要があるはず。

12. **「タグ・画像は出さない」は妥当だが、未表示でよい根拠を plan 内にも残すべき**
   - 調査結果では回答画面で images/tags は未描画。
   - plan は結論だけなので、将来レビュー時に「なぜ画像を出さないのか」が見えにくい。

## リスク / 対立しうる設計判断

1. **複製 vs 共有**
   - 複製: 回答フローを壊しにくいが、将来見た目 drift が起きる。
   - 共有: DRY だが、SessionRunner の状態・採点・副作用境界を崩すリスクが高い。
   - 現要件では複製優位。

2. **判定 banner 非表示 vs 何らかの固定 banner 表示**
   - 非表示: 回答主体不在という意味論に合う。
   - 固定の「正解」表示などを出す: ユーザーには分かりやすい可能性があるが、回答画面の採点結果と混同する。
   - 非表示が妥当。

3. **title 列 hover button vs 専用 trigger 列**
   - title hover: 列追加なし、主情報に近い。
   - 専用列: 操作発見性と衝突回避は強いが、table 幅と既存列構成に影響する。
   - 要件では title hover 確定寄りだが、pin × hover の実機リスクは残る。

4. **close button の有無**
   - close なし: 実装最小だが、peek を閉じる直感的手段がない。
   - close あり: state 操作が増えるが、確認 UI として自然。
   - 表示専用でも close button は入れる方が堅い。

5. **active 行 highlight の有無**
   - highlight なし: 変更最小。
   - highlight あり: 現在の peek 対象が分かりやすいが、rowSelection と視覚的に混同しうる。
   - 入れるなら selection とは明確に違う控えめな style が必要。

6. **hover-only vs focus-visible 対応**
   - hover-only: 要件文に忠実。
   - focus-visible でも表示: keyboard 操作性が上がる。
   - desktop 専用でも keyboard 対応は別問題なので、focus 対応は検討すべき。

7. **peek 幅固定 vs responsive clamp**
   - `w-96`: 実装簡単で安定。
   - `clamp`/`basis`/`max-w`: 画面幅に応じて table 到達性を保ちやすい。
   - wide desktop だけでなく md 直上の幅で table が潰れないかが判断点。

8. **テスト中心 vs smoke 中心**
   - RTL は state/render の確認に有効。
   - sticky、hover、md gate、横スクロールは実ブラウザでしか信頼できない。
   - plan の smoke gate は妥当だが、実装前に確認項目をより具体化した方がよい。