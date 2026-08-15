# Codex plan cross-check — row-ux (2026-08-15)

- **作成日**: 2026-08-15
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **追加処理同士の並走制御**
   - `movePending` は move と create の競合だけを抑止する。
   - footer を短時間に複数回押した場合、各 create が同じ `baseOrders` / `count` を参照し、同一または競合する末尾 `base_order` を生成しうる。
   - `addCard` 実行中を表す create-pending gate、二重送信防止、再入時の契約が要件にない。
   - カードビュー側も同じ `useAddCard` を使うため、hook 単位で直列化するのか、各 UI 単位で抑止するのかを明示する必要がある。

2. **別クライアント・別タブとの順序競合**
   - `movePending` は現在のクライアントの状態にすぎず、別タブ・別端末の move/create は防げない。
   - DB/wire/server/sync 不触という制約上、末尾追加や再採番の不変条件を全クライアント間で保証できない可能性がある。
   - 「同一画面内だけを保証する」のか、既存同期層が競合を収束させる前提なのかを残余リスクとして明記すべき。

3. **表示データの鮮度と作成時 snapshot**
   - click 時に渡される `data` が、最新の live query 結果か、render 時点の snapshot かを確認する必要がある。
   - optimistic create 直後や同期反映直前に再度追加すると、古い `baseOrders` が再利用される可能性がある。
   - `dataReady` は「一度解決済み」を示すだけで、データが最新・完全であることまでは保証しない。

4. **checkbox の選択済み variant**
   - 実体が Radix/shadcn Checkbox の button + `data-state="checked"` なら、CSS の `checked:opacity-100` は適用されない可能性が高い。
   - その場合、「選択済みは常時通常色」という凍結要件を満たさない。生成 DOM/CSSに基づき `data-[state=checked]` 等が必要か確認すべき。
   - これは単なる見た目調整ではなく、確定要件と実装手段の整合問題なので、凍結 spec と衝突する場合は OT 相談対象。

5. **グリップと checkbox の実効 hit area**
   - grip の `size-6` は明記されているが、checkbox の実効クリック領域が16pxのままなら、列再編後の操作性・タッチ対象サイズが弱い。
   - 列幅72pxの算定に「checkbox の hit 補助」とある一方、その補助をどのDOMが担うか定義されていない。
   - label/wrapperで拡張する場合、行選択・checkbox・grip間のイベント伝播も確認が必要。

6. **Popover trigger と DnD activator のイベント合成**
   - click抑止のdnd-kit側挙動だけでなく、Radixが `asChild` で注入する `onClick`、ref、ARIA、data属性と、dnd listenersの合成順が成立条件になる。
   - 特に Space/Enter、drag開始、Popoverが既にopenの状態、pointer cancellation、Escapeの責務競合をブラウザ実測する必要がある。
   - mouse/touchだけでなく、ペン入力、途中で閾値を超えずpointer cancelとなるケースも未定義。

7. **menu open中のドラッグ**
   - specは「menuが開いたままdrag」を受容しているが、DragOverlayとの重なり、focus trap/復帰、drop後のmenu状態、次のキー入力先まで影響する。
   - 「観察のみ」ではなく、少なくともデータ破壊・意図しないmenu action・focus喪失がないことをprod blockerとして切り分ける必要がある。

8. **キーボード状態遷移とフォーカス**
   - Enterでmenuを開き、Spaceでdragを始める設計は、Popover開閉後のfocus復帰とKeyboardSensorのactivator判定に依存する。
   - drag中Enterでdropした後に合成clickが発生しないこと、Tab drop後のfocus先、Escape cancel後のfocus先を確認すべき。
   - 「keyboard drop後のfocus復帰」をscope外とする場合でも、今回の二役化で既存より悪化しないことは必要。

9. **ARIAの複合コントロール表現**
   - 単一buttonにmenu triggerとsortable activatorを同居させるため、`aria-haspopup` と `aria-roledescription="sortable"` が同時に付く。
   - 技術的に属性衝突がなくても、支援技術が「menu button」と「sortable」の二役を理解可能かは別問題。
   - `aria-label="行の操作: …"` だけでは、利用可能な二つの操作を伝えきれず、instructionsはdragEnabled時しか参照されない。locked/1件時にSpaceがmenuを開く挙動も説明されない。
   - NVDA/JAWS/VoiceOverの少なくとも代表1系統で読み上げ順を実測する必要がある。

10. **日本語announcementの正確性**
    - `onDragOver`、`onDragEnd`で参照する `active` / `over` のindexが、移動前・移動後のどちらを意味するか確認が必要。
    - `over === null`、同位置drop、別container、cancel時に、誤った位置や「完了」を読み上げない設計が必要。
    - label重複、空タイトル、40字切り詰め後に同名となる場合でも利用者が対象を識別できるか検討が必要。

11. **全DndContextへの一括配線の回帰範囲**
    - tag側はkeyboardCodesが既定のままなので、instructionsとの一致だけでなく、カテゴリ/optionの実際の移動方向、container構造、stage切替時のannouncementを確認すべき。
    - 同一画面に複数DndContextがある場合、複数live regionやinstructions要素が支援技術上干渉しないかも確認対象。

12. **`useAddCard` callback契約**
    - `onIdMinted` がthrowした場合にcreateを中止するのか、callback例外を無視してcreateするのかが未定義。
    - `buildEmptyCard` や同期採番がthrowした場合も、失敗ログ・UI error・rethrowの一貫性が必要。
    - `onIdMinted` 後にtransactionが失敗した場合、カードビューの`newCardIds` markerが残留しないか確認が必要。現行挙動保存であっても、共有hook化で契約として固定されるため明記すべき。

13. **footerのtable/stickyレイアウト**
    - `<tfoot>`内の`sticky left-0`が、横スクロールコンテナ、border-collapse、pinned列、z-index、背景合成の組合せで期待どおり動くか確認が必要。
    - sticky wrapperだけの場合、footer cell全体は横に流れ、他セルやpinned shadowとの重なりが起こりうる。
    - 列visibilityが0または極端な構成、列resize中、空テーブル時の`colSpan`も境界条件。

14. **エラー状態の寿命**
    - footerの追加失敗表示を、再試行開始時・成功時・データ再読込時に消す条件が未定義。
    - 失敗後に成功しても古いエラーが残る設計は避ける必要がある。
    - component unmount後のPromise完了についても、状態更新警告や不要な表示復帰がないか確認が必要。

15. **列幅72pxの実表示**
    - table layout、最小幅、padding、pinned境界、ズーム、長いローカライズ、OSフォントにより、算術上の52pxだけでは収まらない可能性がある。
    - 200% zoomやブラウザ文字拡大でgrip/checkboxが重ならず操作できることを確認すべき。

## plan ドラフトへの抜け・未考慮指摘

1. **Task 5にcreate-pendingがない**
   - `disabled = !dataReady || positionLocked || movePending`のみで、追加要求自体の多重送信を防げない。
   - テストにもdouble-click、連続Enter、Promise未解決中の再clickがない。
   - 凍結gateへ条件を追加する必要が生じるなら、実装判断せずOTへ戻すべき重要点。

2. **checkboxの`checked:`実効性を検証していない**
   - Task 4はclass文字列を指定するだけで、選択済み時のcomputed styleや実DOM stateとの対応をテストしていない。
   - Radix Checkboxなら要件未達になる可能性がある。

3. **Task 3の失敗後marker cleanupがない**
   - `onIdMinted`はawait前に`setNewCardIds`するが、enqueue失敗・rollback後のmarker除去がplanにない。
   - 「既存testがgreen」だけでは、失敗時に見えないstale stateを保証できない。

4. **Task 3にcallback例外テストがない**
   - `onIdMinted`がthrowするケース、`buildEmptyCard`が同期throwするケース、採番失敗時の契約が未検証。
   - hookとして抽出するなら、どの例外をログ・rethrowするかがAPI契約になる。

5. **Task 4のref要件に曖昧さがある**
   - specは「setActivatorNodeRef + triggerRef + Radix内部refの3者」とするが、planは`asChild`でRadix内部refをどう取得・合成するか具体化していない。
   - 通常、child側だけではRadixが注入するrefを明示変数として扱えないため、既存wrapperのforwardRef/Slot合成方式を現物確認する必要がある。

6. **Radixとdnd-kitのhandler順序テストが不足**
   - planのunit testは属性・menu open中心で、Space/Enter時の両handlerの合成、defaultPrevented、Popover open中dragを検証しない。
   - jsdomでpointer drag全体は無理でも、keyboard eventとPopover開閉の配線はunit/integrationで検証可能。

7. **`aria-describedby`の取得方法が壊れやすい**
   - 「attributesのまま」を使うと、spread後に値を参照する実装が曖昧になる。
   - `attributes['aria-describedby']`の型・undefined・dnd-kit版差を明示し、実際のhidden instructions要素へ解決するテストが必要。

8. **ARIA複合状態の実機SR確認がsmokeで弱い**
   - smoke #8は参照先と日本語・生ID不在を見るだけで、`aria-haspopup`、`aria-expanded`、roledescription、labelの読み上げ順を確認しない。
   - 二役コントロールのa11y成立を確認するには不足。

9. **announcementの意味検証が文字列pinに偏っている**
   - Task 2は「位置句を含む」ことをテストするが、その位置がdrop後の正しい位置かは保証しない。
   - null over、同位置、cancel、items不整合、重複labelのケースも不足。

10. **tag 4 instanceの実配線testが明示されていない**
    - factory unitだけでは、5 instanceすべてへの配線漏れを防げない。
    - 各DndContextの`accessibility` propを捕捉する構造test、または全instance inventory testが必要。

11. **footer integration testが部分的**
    - 「liveData未解決」だけでなく、sort/filter、movePending、列visibility変更、0件解決済みを実tableからfooterへ正しく配線する統合testが必要。
    - component単体でpropsを直接与えるだけでは、親のgate算出ミスを検出できない。

12. **footerの多重送信・エラー解除testがない**
    - 未解決Promise中の再click、成功後のerror clear、失敗後のretry、連続追加で更新済みbaseOrdersが渡ることが未検証。

13. **`data.map(...)`が本当に基準順全件かを固定していない**
    - planは`data`を正本扱いするが、将来または現状の`data`がsort前・filter前・全件であることをテストしていない。
    - 任意の配列をspyへ渡す単体testでは、「表示順ではなく基準順全件」という上位契約を保証できない。

14. **hit areaのテストがない**
    - gripの24pxはclassで確認できても、checkboxのクリック領域、列内の重なり、タッチ操作性は確認対象に入っていない。

15. **列幅変更の影響inventoryが狭い**
    - `--col-title-start`以外にも、pinned shadow、header select-all、resize handle、snapshot、横スクロール開始位置、empty/loading rowのcolSpanが影響を受ける可能性がある。
    - 既存testの行番号ベースinventoryは、意味ベースの全検索より漏れやすい。

16. **Task 4の`getLabel` fallbackが不十分**
    - `question_label ?? title`は空文字をfallbackしない。`question_label === ''`ならtitleへ落ちず、総称になる。
    - trim、空白のみ、重複、切り詰め規則が未定義。

17. **Task 6のgateコマンドが正本と不一致**
    - specは`pnpm lint --max-warnings=0`だが、plan本文は`pnpm lint`と記載されている。
    - package script内で既に指定されていない限り、警告ゼロgateを満たした証拠にならない。

18. **実機smokeの担当・環境・証跡形式が不足**
    - M1〜M3を「待ち一覧」にするだけで、対象OS/browser/入力機器、SR種類、結果保存先、再試験条件がない。
    - prod blockerなら、少なくともiPad実機、mouse、trackpadの区別が必要。

19. **Task間の一時的不整合**
    - Task 2で`ROW_DND_SR_INSTRUCTIONS`を追加するが、実keyboardCodesとの対応はTask 4まで成立しない。
    - 「常時green」は満たせても、独立commit単体では未使用または実挙動と未接続になる。bisect/revert時の意味を明記した方がよい。

20. **凍結specから逸脱した場合の具体的停止点がない**
    - checkbox variant不成立、Radix ref合成不成立、create-pending必要判明など、実装中に仕様判断へ昇格しうる点がある。
    - Global Constraintsの一般文だけでなく、これらを明示的なstop checkpointにすべき。

## リスク / 対立しうる設計判断

- **凍結gateの厳守 vs create多重送信防止**
  - 現gateを守ると二重create競合が残る。
  - create-pendingを加えると凍結spec変更になりうる。実装前にOT裁定が必要な可能性が高い。

- **現行挙動保存 vs 失敗時の整合性**
  - `onIdMinted`をawait前に呼ぶことはauto-editを保存する一方、transaction失敗時に存在しないIDのUI markerを残しうる。
  - 完全な現行保存を優先するか、失敗cleanupを追加するかは別判断。

- **単一focus stopの簡潔さ vs 支援技術での明確さ**
  - 一つのbuttonに集約すると視覚・Tab順は簡潔になる。
  - menu buttonとsortable activatorの役割が同居し、SR利用者にとって操作モデルが複雑になる。

- **低コントラスト vs 非テキストコントラスト・発見可能性**
  - 常時50%はhover-onlyより安全だが、背景色や選択状態によっては操作部品として認識しにくい。
  - 40〜60%の体感調整だけでなく、実際のコントラスト確認が必要。

- **72px固定 vs 操作対象サイズ**
  - 密度は改善するが、checkbox hit areaやズーム時の余裕を削る。
  - 列幅を守るか、タッチ・アクセシビリティ上の余白を優先するかが対立する。

- **ローカルpending gate vs 分散整合性**
  - UI gateは同一画面の事故を減らすだけで、別クライアント競合を解決しない。
  - DB/server不触を維持するなら、「末尾追加」は強い不変条件ではなくbest effortとして扱う必要がある。

- **`<tfoot>`の構造的分離 vs sticky/pinned表示の複雑化**
  - 仮想化から切り離せる利点は大きい。
  - 一方で既存tbodyのpinned背景・z-index規則をそのまま継承できず、独自の表示不具合を生む可能性がある。

- **全DnD site一括変更 vs sprintの回帰面積**
  - a11y負債を一括解消できる。
  - 行UX変更とは独立したtag DnDまで回帰範囲が広がるため、各siteの配線testとsmokeを省略できない。

- **実装単位を大きく保つ vs 原因切り分け**
  - Task 4を一commitにすることで壊れた中間状態は避けられる。
  - sensors、Popover、ARIA、列レイアウト、DnD gatingが同時に変わり、失敗時の原因切り分けとreview負荷は増える。内部的な段階検証は必要。