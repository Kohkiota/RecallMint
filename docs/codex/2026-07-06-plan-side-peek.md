# Codex plan cross-check — side-peek (2026-07-06)

- **作成日**: 2026-07-06
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **side peek の「単票全項目」の境界**
   - 要件列挙には「問題文」「選択肢 ID」「カード削除」「選択肢追加削除」が明示されていない一方、調査では InlineCardList はそれらを含む。
   - 「単票の全項目」を InlineCardList 1 枚分と同義にするのか、peek 固有の編集対象だけに絞るのかは明文化が必要。
   - 特にカード削除は単票 UI にはあるが、peek 中削除は active row 消滅・ActionBar 選択状態・確認 dialog z-index と絡む。

2. **non-modal overlay の操作モデル**
   - overlay 採用自体は要件通りだが、modal か non-modal か、外クリックで閉じるか、テーブル操作を許すかは要件に明示されていない。
   - non-modal にすると「peek を開いたままテーブルも編集できる」反面、同一カードを peek と table で同時編集できるため、blur commit 順・楽観更新順・表示更新の見え方が論点になる。

3. **Esc の意味**
   - InlineTextField に Esc cancel がないため、peek 内入力中に Esc close すると blur commit で保存される可能性がある。
   - 「Esc = 閉じる」なのか「編集中 Esc = 編集キャンセル/閉じない」なのかは UX 上かなり重要。
   - tag popover 等 radix layer との優先順位も仕様化が必要。

4. **専用トリガーの形**
   - 行クリック不可は確定。
   - 専用アイコンを title セル内に置くか、専用列にするか、pinning/hideable/mobile 常時表示/キーボード到達性を含めて決める必要がある。
   - 専用列の場合、既存列幅・pinning 境界・選択 checkbox 近傍の誤タップ・列 toggle 除外が論点。

5. **rowSelection / ActionBar との直交性**
   - peek の activeCardId と選択状態は別概念。
   - peek 中に同じカードを bulk delete した場合、peek をどう閉じるか。
   - peek 中に複数選択 ActionBar が残るなら、ActionBar 操作が peek の背後で実行される UX を許容するかが必要。

6. **z-index 体系**
   - 既存は z-50 帯に popover/dropdown/confirm/billing が密集。
   - peek 自体、peek 内 popover、confirm-dialog、ActionBar、FAB、sticky header/pinned cells の上下関係を明示する必要がある。
   - 特に non-modal かつ backdrop なしなら、背面 UI の可視性とクリック可能性も z-index とセットで決める必要がある。

7. **データ供給と active row の寿命**
   - 手元 row 流用・追加 fetch なしは妥当。
   - ただし activeCardId が filter/sort/削除/exam 移動/同期 pull により data から消えた場合の close 条件を明文化する必要がある。
   - フィルタで不可視になっても開き続けるかは、編集途中の事故防止と「一覧に存在しないものを編集している」違和感のトレードオフ。

8. **live 更新の競合・反映順**
   - table と peek が同一 mirror を共有するため追加配線不要。
   - 一方で、peek のローカル編集中 state が useLiveQuery 更新で上書きされるか、`useCardOptions` merge が意図通りか、カード切替時に stale state が残らないかはテスト対象にすべき。

9. **既存プリミティブ再利用の適合性**
   - InlineCardList から「1 枚分」を切り出す場合、既存 component が list 前提・autoEdit 前提・削除ボタン込み・余白/幅前提を持っていないか確認が必要。
   - fork 禁止なら、必要 props が足りない場合にどこまで既存 component を薄く再構成するかが設計論点。

10. **モバイル方針**
   - design-policy は「モバイル = full page 遷移」だが、遷移先 route は廃止済。
   - 新 route 新設か、全幅 overlay か、card view 誘導かを工数だけでなく、戻るボタン、URL 共有、モバイルキーボード、fixed overlay、テーブル横スクロールとの干渉で比較する必要がある。

11. **アクセシビリティ**
   - Dialog として出すなら `role=dialog`、Title、Close、focus 移動、Tab 移動、aria-label が必要。
   - non-modal Dialog の場合、背景操作を許すことと screen reader 上の dialog 表現が矛盾しないか確認が必要。
   - 専用 open button のラベル、開いている状態の表現、再クリック close の説明も論点。

12. **仮想化・DOM 寿命**
   - 行仮想化済みなので、開いた行がスクロールアウトして DOM unmount されても peek は維持されるべき。
   - open トリガーセル自体の再描画・virtualizer 計測・列追加による幅計算への影響を確認する必要がある。

13. **テスト境界**
   - component/unit で担保できるものと、実機 smoke が必要なものの分離が必要。
   - fixed overlay、mobile keyboard、animation、z-index、popover layering は RTL だけでは十分に担保しにくい。

14. **旧 spec/plan 破棄の扱い**
   - 旧 spec が「表示専用/judged 確認」を持っていたため、今回の spec が唯一の正であることを明記する必要がある。
   - judged 風確認ビューを OUT にする場合、なぜ side peek の価値から外すのかも明文化した方がよい。

## plan ドラフトへの抜け・未考慮指摘

1. **non-modal 採用が要件から一段踏み込んだ設計判断**
   - 要件は overlay 方式を指定しているが、non-modal/backdrop なし/外クリックで閉じないまでは確定していない。
   - plan はかなり妥当な理由を書いているが、これは「OT 確定」ではなく追加設計判断として扱うべき。

2. **Esc 中の保存挙動が危険仕様になりうる**
   - plan は「input 編集中 Esc = blur commit + close」を仕様化している。
   - これは破壊ではないが、一般的な期待では Esc はキャンセル寄りに受け取られやすい。少なくとも Open Question または UX リスクに上げるべき。

3. **Dialog.Close と `onClose` の二重発火確認**
   - `Dialog.Close` の × button と `onEscapeKeyDown`/`onOpenChange` の扱いが曖昧。
   - plan は `onEscapeKeyDown → onClose` と書くが、Radix Dialog は `onOpenChange` 経由でも close が流れる可能性がある。実装方針を一元化しないと `onClose` 二重呼びや Esc 挙動のテスト不安定化がありうる。

4. **focus trap/scroll lock に関する Radix Dialog の実挙動確認が必要**
   - plan は `modal={false}` なら scroll lock・focus trap がない前提で書いている。
   - 実際に `Dialog.Content` の focus 移動、outside interaction、autoFocus、restore focus がどう動くかは確認対象に入れるべき。

5. **「単票全項目」からカード削除を OUT にする根拠が弱い**
   - 要件は「単票の全項目」としており、調査では InlineCardList にカード削除が含まれる。
   - plan はカード削除を OUT にしているが、これは妥当でも仕様判断であり、Open Question 側に残す方が安全。

6. **選択肢追加削除の扱いがやや埋もれている**
   - spec 側では編集範囲に含めているが、Task 1 の完了条件には選択肢追加削除の表示・動作確認が明確に入っていない。
   - 「InlineOptionList を置けば入る」前提でも、peek 配線として最低限の存在確認は欲しい。

7. **同時編集の競合テストが薄い**
   - table セル編集 → peek 反映、peek 編集 → table 反映は smoke にあるが、unit 完了条件では限定的。
   - 特に同じフィールドを peek で編集中に table 側/live 側が更新された場合の挙動は未整理。

8. **仮想化行が unmount された場合の維持確認がない**
   - activeRow は data 由来なので理屈上維持されるが、open trigger のある行がスクロールアウトしたときの挙動は plan のテストにない。
   - virtualizer 回帰として軽く確認対象にしてよい。

9. **open 列の pinning 仕様が未確定**
   - 専用列を select 直後に置くのはよいが、pinning 対象にするのか、select と一緒に左固定されるのかが曖昧。
   - 「computePinnedLeft に自動追従」だけでは、ユーザー設定上 open 列が固定/非固定どちらになるべきかが分からない。

10. **開いている行の視覚状態がない**
   - 専用列再クリックで close するなら、現在どの行が開いているかの視覚表示や button の `aria-pressed` / active style が欲しくなる。
   - plan には active indicator がない。必須ではないが、UX と a11y の抜け。

11. **mobile 全幅 overlay の browser back 問題**
   - plan は「戻るは × / Esc」としているが、モバイルではブラウザ戻るで閉じる期待が強い。
   - 案 b を選ぶなら、戻るボタン非対応を明示的な受容リスクに入れるべき。

12. **mobile keyboard/fixed overlay が sprint 末 smoke のみ**
   - mobile overlay 案の最大リスクがここなので、採用判断前の確認項目としては弱い。
   - 少なくとも実装完了 gate ではなくても、plan 上のリスクとして強めに残すべき。

13. **z-[45] は局所解として妥当だが、Dialog/Popover Portal 順序依存が残る**
   - peek 内 popover が body 末尾 z-50 で上に出る前提は妥当。
   - ただし複数 Dialog/confirm が同時にある場合や billing-banner z-50 との競合は未整理。全面リナンバーしない判断の残余リスクとして明記が必要。

14. **外クリックで閉じない場合の「背面クリック」の意図が曖昧**
   - 背面テーブルセルをクリックすると peek は閉じず、セル編集が始まる想定。
   - その状態で peek と table の両方に編集 UI が開く可能性がある。許容するなら仕様として十分だが、テストは「閉じない」だけでなく「背面操作が実行される」まで見る余地がある。

15. **test 方針の “canonical + Codex review” は実装手順依存**
   - design spec としてはよいが、設計論点としては外部プロセス依存。
   - plan 本体の実装可能性とは別なので、承認条件と技術設計を少し分けた方が読みやすい。

## リスク / 対立しうる設計判断

1. **non-modal vs modal**
   - non-modal: Notion 的で table 併用可能。ただし同時編集・focus・Esc・背面クリックが複雑。
   - modal: 実装と a11y は単純。ただし peek 中に table を見ながら操作する価値が落ちる。

2. **mobile full-width overlay vs new route**
   - full-width overlay: 最小工数。既存 route 不要。
   - new route: design-policy に忠実で browser back/URL 共有に強いが、認可・not-found・loading・戻る導線が増える。

3. **専用列 vs title 内ボタン**
   - 専用列: 常時到達可能で非衝突。ただし表がさらに横に広がる。
   - title 内ボタン: 視覚的には軽いが、title hideable 問題と hover/mobile/focus 対応が面倒。

4. **カード削除を載せる vs 載せない**
   - 載せる: 「単票編集」として自然。
   - 載せない: bulk 削除経路と責務分離でき、確認 dialog/z-index/active row prune の複雑さを避けられる。

5. **filter で不可視になっても peek 維持 vs close**
   - 維持: 編集中に自分の変更で閉じる事故を防げる。
   - close: 一覧の可視状態と peek が一致する。ただし入力破棄/混乱のリスクがある。

6. **z-index 最小追加 vs 体系整理**
   - `z-[45]` 追加: 低リスク・低工数。
   - z-index token 化/整理: 長期的には健全だが、今回のスコープを超えやすい。

7. **既存プリミティブ完全再利用 vs peek 用薄ラッパー**
   - 完全再利用: 書込経路と挙動が揃う。
   - 薄ラッパー: レイアウト/a11y/mobile 最適化しやすいが、分岐が増える。

8. **Esc close 即保存 vs Esc 保護**
   - 即保存: 既存 blur commit と整合し、実装が単純。
   - Esc 保護: ユーザー期待には合いやすいが、InlineTextField 側に新規挙動を足す可能性がある。