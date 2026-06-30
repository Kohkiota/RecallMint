# Codex plan cross-check — edit-4-side-peek-rev2 (2026-06-30)

- **作成日**: 2026-06-30
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **CardView 複製の境界**
   - SessionRunner judged 表示を複製する方針は、SessionRunner の採点・FSRS・outbox・完了処理を誤って持ち込まないためには妥当。
   - ただし複製なので、今後 SessionRunner 側の表示仕様が変わった時に CardView が drift するリスクがある。
   - 「共有しない」は確定スコープだが、複製元のどの要素を同一視するか、テストで固定する範囲を明確にした方がよい。
   - 判定 banner を除く判断は必須。回答主体が存在しない peek/full-page で「正解/不正解」を出すと意味が壊れる。

2. **read-only 表示の保証**
   - CardView は `button` や `aria-pressed` を残さず、選択肢を非インタラクティブにする必要がある。
   - 見た目が回答画面風でも、キーボードフォーカス可能要素や click handler が残ると「回答できそう」に見える。
   - 編集・保存・dirty・同期・採点に関わる副作用が一切ないことが重要。

3. **peek の live 追従**
   - `data.find(...).card` で live data から都度引く設計は、cell 編集の mirror 更新に自然追従するため妥当。
   - 一方で、active card が削除・フィルタ除外・検索除外された時の閉じ方は明確に必要。
   - snapshot を持たないので、編集中の値が即 peek に反映される。これは利点だが、ユーザーが「開いた時点の確認」と期待する場合は挙動差になる。

4. **activeCardId と rowSelection の独立性**
   - rowSelection は複数選択、activeCardId は従ビュー対象であり、同期しない判断は正しい。
   - ただし UI 上では「青枠」と「チェック選択」が同じ行状態に見えうるため、視覚表現の差別化が必要。
   - prune は rowSelection の可視集合ロジックに近いが、混ぜすぎると用途が曖昧になる。

5. **title 列ボタン trigger**
   - 行クリックを使わない判断は、cell click-to-edit との bubble 競合回避として妥当。
   - ただし title 列内に編集 UI と open trigger が共存するため、クリック領域、フォーカス順、hover 表示の discoverability が論点。
   - desktop で hover 時のみ表示にすると、キーボードユーザー向けに focus-visible/focus-within で確実に出す必要がある。
   - mobile 常時表示は正しいが、title セルの密度・横スクロールとの相性を見る必要がある。

6. **desktop 2カラム + リサイズ**
   - TanStack column resize を左右 pane resize に流用しない判断は妥当。
   - 自前 window listener は依存追加を避けられるが、mouseup 漏れ、unmount 時 cleanup、drag 中の text selection、iframe/window 外 mouseup、touch/pointer 非対応が論点。
   - 幅を非永続 state にする判断は既存の非永続 prefs 方針と合う。
   - ただし「セッション state」が React state の意味なら、同一ページ滞在中のみ保持。route 遷移や reload では失われる。期待値を明確にした方がよい。

7. **ActionBar との干渉**
   - 既存 ActionBar は `fixed bottom` なので、右 peek が下部で隠れる、または操作ボタンと重なる可能性がある。
   - table/peek どちらに bottom padding を持たせるか、ActionBar 表示中のスクロール末尾が見えるかを smoke で見る必要がある。

8. **外クリックで閉じる仕様**
   - 「peek 外クリック」は便利だが、table 内の編集操作・filter 操作・ActionBar 操作でも閉じるのかを決める必要がある。
   - 特に cell 編集中に peek が閉じるのは許容か、外クリックの対象から一部除外するかが論点。
   - 過剰防御を足さない制約があるため、仕様として割り切る必要がある。

9. **Esc の扱い**
   - Esc は peek を閉じる一方、既存 InlineTextField や dialog/dropdown が Esc を使っている場合、イベント競合の可能性がある。
   - capture/bubble、`event.defaultPrevented` の扱い、入力中 Esc で peek まで閉じるかは確認点。

10. **青枠の実装**
   - `box-shadow inset` は sticky/pinned cell またぎで border/outline より安定しやすい。
   - ただし hover 背景、sticky cell 背景、row height、横スクロール時の左右端表示、dark mode でのコントラストは確認対象。
   - `getVisibleCells` の index 0/末尾を使うなら、列 visibility・pinning・横スクロール時にも視覚的に破綻しないかを見る必要がある。

11. **mobile full-page route**
   - mobile で side peek を出さず full-page にする判断は、狭幅で table と従ビューを同時表示しない点で妥当。
   - `db.cards.get(cardId)` + `user_id` 検証は local-first の範囲では簡潔。
   - ただし Dexie mirror に対象 card がまだ無い、同期遅延中、別端末で削除済み、ambient pull のタイミングなどで not-found になりうる。
   - read-only ゆえ PullGate なしは理解できるが、full-page で古い mirror を表示する可能性は残る。

12. **CSS md: + DOM 両置き**
   - JS viewport 判定を避ける判断は hydration mismatch や matchMedia 前例なし問題を避けられる。
   - ただし desktop button と mobile Link が同時に DOM に存在するので、テスト・アクセシビリティ query・重複ラベル・tab order で hidden 側が本当に不活性か確認が必要。
   - `display:none` なら click target にはならないが、実装が opacity/visibility だけになると競合する。

13. **full-page route の認可・所有者検証**
   - `card.user_id === current user_id` は必須。
   - `exam id` と `cardId` の整合性も論点。card が指定 exam に属しているかを検証しないと、URL 上は別 exam 配下でも cardId だけで表示できる可能性がある。
   - 要件では user_id 検証のみ明記だが、route が `/exams/[id]/cards/[cardId]` である以上、exam membership 検証の扱いは設計判断が必要。

14. **テスト戦略**
   - T3/T4/T5 は RTL だけでは hover/focus、横スクロール、sticky/pin またぎ、resize drag、mobile CSS gate が十分に取れない。
   - 実機 smoke 依存は妥当だが、smoke 手順が曖昧だと regress しやすい。
   - 可能な範囲で pure logic、DOM presence、handler 配線は unit/RTL に寄せ、視覚・レイアウトだけ smoke に残すのがよい。

15. **空データ fallback なし**
   - 要件としては妥当だが、full-page の not-found とは区別が必要。
   - CardView 内では options/explanation/question が空でも自然描画。
   - route 取得失敗や user mismatch は CardView の空 fallback ではなく、ページ側の not-found 表示で扱う必要がある。

## plan ドラフトへの抜け・未考慮指摘

1. **exam id と cardId の整合性検証が弱い**
   - plan T5 は `card.user_id` 検証のみを明記している。
   - route が `/app/exams/[id]/cards/[cardId]` なので、card が当該 exam に属するか、少なくとも `card.exam_id === id` 相当の検証をするかを決めるべき。
   - 主入力は user_id 検証のみだが、URL 意味論上の抜けとして明示した方がよい。

2. **Esc の競合条件が未整理**
   - plan は Esc で close とだけ書いている。
   - InlineTextField 編集中、dropdown/filter 操作中、他の escape handler がある場合に peek まで閉じるかが未定。
   - `defaultPrevented` を見るのか、入力中でも閉じるのか、最低限 smoke/RTL 観点に入れるべき。

3. **外クリックの閉じる範囲が曖昧**
   - 「peek 外クリック」で閉じる場合、table cell 編集、filter bar、ActionBar、resize handle クリックでも閉じるのかが明確でない。
   - 特に resize handle と外クリック close が競合しないかは plan に確認項目として入れるべき。

4. **resize の pointer/touch 対応が未検討**
   - 主入力は mousemove/mouseup 指定なので mouse 実装自体はスコープ通り。
   - ただし desktop でも trackpad/touchscreen 環境がある。Pointer Events を使わず mouse events に限定する割り切りを明記した方がよい。
   - drag 中の text selection 抑制、mouseup が window 外で失われた場合の挙動も未記載。

5. **リサイズ clamp 値が未確定のまま task に入っている**
   - plan は Open Question Q2 にしているが、T3 完了条件には clamp smoke が入っている。
   - clamp 値未確定だと実装者裁量が混ざる。OT 承認前に fixed value に落とすか、裁量範囲を plan 本文に昇格させるべき。

6. **ActionBar との重なり確認はあるが、対策方針がない**
   - smoke 項目にはあるが、重なった場合に何を許容し、何を修正対象にするかがない。
   - bottom padding を加えるのか、peek 内スクロールを持つのか、既存 document scroll のままにするのか、判断基準が必要。

7. **CardView の drift リスク対策が薄い**
   - 複製方針は明記されているが、SessionRunner 表示変更時に CardView も更新すべきことが残らない。
   - コメントを足すかは別として、テスト観点に「judged 風として維持する表示契約」を置いた方がよい。
   - ただし過剰な共有抽出は禁止なので、対策は最小でよい。

8. **hidden DOM のアクセシビリティ検証が不足**
   - plan は `display:none` で競合なしとしている。
   - RTL では hidden 要素も query 方法によって拾えるため、visible/invisible の検証方針を明確にした方がよい。
   - desktop button と mobile Link の同一 `aria-label` 重複が支援技術上どう扱われるかも確認点。

9. **mobile full-page の loading 状態が曖昧**
   - T5 に「必要なら loading.tsx」とあるが、Dexie `useLiveQuery` 初期 undefined と not-found をどう区別するかが重要。
   - 取得中に一瞬 not-found を出すリスクがある。
   - 空データ fallback 禁止と not-found 表示の境界もここで明確化すべき。

10. **full-page で mirror stale を許容する設計判断が明記不足**
   - PullGate を追加しないことは明記されている。
   - ただし ambient pull resume 後に対象 card が更新/削除される可能性、read-only でも古い表示になりうる点をリスクとして plan に残した方がよい。

11. **T2 の「rowSelection 操作が activeCardId に影響しない」テストが実装前に難しい**
   - T2 単独では UI consumer がないため、rowSelection と activeCardId の直交性をどう観測するかが曖昧。
   - plan 自身も T2/T3 対実装と書いているため、T2 完了条件を純関数中心に寄せるか、T3 で検証すると明確に分離した方がよい。

12. **青枠の visible cell 判定と pinned column の関係が不足**
   - `getVisibleCells` の index 0/末尾で左右線を出す方針はある。
   - ただし pinned title cell が sticky で重なる場合、視覚上の左端・右端が DOM visible cell index と一致するかは要確認。
   - 列 visibility 変更後の青枠も smoke 対象に入れるとよい。

13. **title trigger と InlineTextField のフォーカス順が未記載**
   - click 衝突は plan にあるが、Tab 順・focus-visible 表示・編集 div と open button の順序が未整理。
   - desktop hover 表示のボタンが tab で到達可能かは重要。

14. **route path Q1 が Open Question のまま Architecture では確定風に書かれている**
   - plan 本文では `cards/[cardId]` を前提に記述し、Open Questions では未確定としている。
   - 承認対象 plan にするなら、未確定なら未確定として全体で統一した方がよい。

15. **DevTools MCP smoke の実施タイミングが曖昧**
   - 「push 後」「stg」とあるが、実装 task 完了条件に入っている。
   - worker が push しない運用なら task 完了時に実施できない可能性がある。
   - 「local dev smoke」「stg smoke」「push 後 smoke」のどれが必須 gate かを分けるべき。

## リスク / 対立しうる設計判断

1. **複製 vs 共有**
   - 複製は副作用混入を避ける。
   - 共有は表示 drift を避ける。
   - 確定スコープでは複製が正だが、drift は受け入れリスクとして残る。

2. **live 追従 vs snapshot**
   - live 追従は同期コード不要で local-first と相性がよい。
   - snapshot は「開いた時点の確認」としては安定する。
   - 今回は live 追従が要件に合うが、編集直後に peek が変わる挙動は明示的に受け入れる必要がある。

3. **外クリック close の便利さ vs 編集作業の安定性**
   - 外クリックで閉じると軽快。
   - table 編集や filter 操作のたびに閉じると煩わしい可能性がある。
   - 過剰防御禁止のため、どこまで閉じるかの仕様化が重要。

4. **CSS md 両置き vs 単一 DOM**
   - 両置きは viewport JS 不要で堅い。
   - DOM 重複、テスト複雑化、アクセシビリティ query の扱いが増える。
   - hidden が `display:none` であることを実装規律として守る必要がある。

5. **自前 resize vs ライブラリ**
   - 自前は軽量で依存なし。
   - edge case は実装責任になる。
   - mouse-only、cleanup、clamp、text selection の割り切りを明確にしないと後から不具合化しやすい。

6. **PullGate なし vs 表示鮮度**
   - PullGate なしは簡潔で read-only 方針に合う。
   - ただし full-page route は古い mirror を表示する可能性がある。
   - local-first で許容するのか、not-found/更新遅延の UX をどう扱うかは残リスク。

7. **user_id 検証のみ vs exam 所属検証**
   - user_id 検証は最低限のアクセス制御。
   - exam route 配下である以上、card がその exam に属するかを見ないと URL と表示内容がズレる。
   - これは plan の中で最も実害が出やすい抜け。