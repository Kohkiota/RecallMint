# Codex plan cross-check — image-display-ux (2026-07-22)

- **作成日**: 2026-07-22
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **safe-area 要件と viewport 不変条件が両立していない**
   - 調査結果では `viewport-fit=cover` がなく、`safe-area-inset-*` は inert と明記されている。
   - 一方、要件は viewport を変更せず、PhotoSwipe のツールバーへ `env(safe-area-inset-*)` を適用するとしている。
   - このままではノッチ・Dynamic Island・横向き端末で実効的な safe-area を保証できない。viewport 変更を許すか、safe-area 対応を「best effort」に下げるか、別方式を定義する必要がある。

2. **寸法未知画像のモーダル生成手順が未確定**
   - PhotoSwipe の `dataSource` には有効な `width/height` が必要だが、DL のみ端末では mirror がない。
   - `naturalWidth/Height` は既に表示済みの画像には使えても、同じ target の未表示・未ロード兄弟画像には使えない。
   - 兄弟ごとの objectURL 解決、`Image.decode()`、decode失敗、ゼロ寸法、途中キャンセルの扱いが必要。
   - 「全画像の decode 完了を待ってから開く」「タップ画像だけで先に開き、後から追加する」のどちらかも決める必要がある。

3. **非同期解決後の `startIndex` 再計算が必要**
   - 未解決画像を除外すると、元の `targetImages` 上の index と PhotoSwipe に渡す配列上の index が変わる。
   - 並列解決して完了順に配列へ追加すると ordinal 順も壊れる。
   - 元順序を維持した結果配列を作り、タップした asset の識別子から index を再計算する必要がある。タップ画像自身の decode 失敗時の扱いも要定義。

4. **モーダル起動中の競合制御**
   - 連続タップ、dynamic import 中の再タップ、既存モーダル表示中の別画像タップ、コンポーネント unmount 後の import 完了を考慮する必要がある。
   - 単一インスタンス保証、起動中フラグ、古い要求のキャンセルまたは無視、destroy の冪等性が必要。

5. **objectURL の所有権と寿命**
   - 既存 `objectUrlCache` が URL を再利用するなら、モーダル側が勝手に `URL.revokeObjectURL()` してはいけない。
   - 一方、decode 用に新たな objectURL を生成するなら解放責任が必要。
   - gallery、resolver、PhotoSwipe のどこが所有するかを明文化しないと、表示破損または長時間セッションでのメモリリークにつながる。

6. **最大10画像の一括解決・decodeによるiOSメモリ負荷**
   - stored object は最大1600/2048px程度で、同一 target に最大10枚ありうる。
   - モーダル起動時に全兄弟を並列fetch/decodeすると、iOS WebKitで既に問題化した画像メモリ制約に再度当たりうる。
   - 同時実行数、順次decode、隣接画像だけの先読み、失敗時の縮退動作を検討すべき。

7. **モーダル起動待ちのUX**
   - Cache missでは署名URL取得と最大30秒のfetchがありうる。
   - タップ後に無反応に見えない loading 表示、二重起動防止、キャンセル、失敗通知が必要。
   - 既存サムネが表示済みでも、兄弟画像待ちでモーダル全体が遅れる設計は避ける余地がある。

8. **折り畳み判定は初回だけでは不十分**
   - `renderedWidthPx` と `capPx` は端末回転、split view、サイドピーク幅、ブラウザUI、root font-size、レスポンシブレイアウトで変化する。
   - `ResizeObserver`、orientation/viewport change、または再計算契機が必要。
   - 初回計測時に wrapper 幅が0の場合や、`getComputedStyle().maxHeight` が数値化できない場合の扱いも必要。

9. **CSSのclipと計算結果の対応が曖昧**
   - `cappedHeightPx` を返す一方、実際のclipはCSSの `max-height` に委ねる設計になっている。
   - `fold=false` だが画像高が `capPx` をわずかに超える場合、常時 `max-height` を付けるとボタンなしで画像が切れる。
   - `overflow:hidden/max-height` は `fold=true` のときだけ有効化するなど、DOM/CSS状態を明確にすべき。

10. **ボタンを「画像外」に置くDOM構造**
    - overflow wrapper 内に置くとボタン自身がclipされる可能性がある。
    - wrapper、clip領域、gradient、外部ボタンの階層を分ける必要がある。
    - gradient は `pointer-events:none` とし、画像タップを妨げないことも必要。

11. **複数画像レイアウトは高さを完全には有界化しない**
    - 128pxタイルをflex-wrapしても、同一target 10枚なら複数行になり、合計高は増える。
    - 「青天井を構造で防ぐ」は厳密には成立しない。最大10枚による有限上限という意味なのか、行数制限・横スクロール等で実表示高を制限するのか整理が必要。

12. **「縦スクロール」とPhotoSwipeのパンの意味差**
    - 長尺画像の `'fill'` は通常のDOMスクロールではなく、PhotoSwipe内部のドラッグ／パンになる可能性が高い。
    - 1本指で自然に上下閲覧できるか、スクロール端で背景へ伝播しないか、キーボードや支援技術でも移動できるかを確認すべき。
    - 要件上の「縦スクロール」がネイティブスクロールを要求するなら、`fill` だけでは充足しない可能性がある。

13. **ズームボタンの境界動作**
    - `現在倍率×step` だけでは、min/max clamp、disabled状態、連打、アニメーション中操作、slide変更後の状態更新が未定義。
    - リセット先も文字列の `'fit'/'fill'` ではなく、現在slideの実数 initial zoom を取得する必要がある。
    - 長尺画像でリセットすると閲覧位置を先頭に戻すか、中央へ戻すかもUX判断になる。

14. **フォーカス管理の具体化**
    - `returnFocus:true` だけで、React上の起動要素へ確実に戻れるとは限らない。
    - 画像を単独buttonで包むなら起動要素refを保存できるが、削除でDOMが消えた場合などのfallbackも必要。
    - 「開いた直後に閉じるボタンへfocus」とPhotoSwipe既定focus処理の競合も確認が必要。

15. **キーボード表示中の必須smoke経路が不安定**
    - テキスト入力から画像をタップすると、通常は入力がblurしてソフトウェアキーボードが閉じる。
    - 「キーボード表示中のままモーダルを開く」をどう再現するかが定義されていない。
    - プログラム起動、画像ボタンへのpointerdown時点、キーボード遷移中など、再現可能な手順と観測時点が必要。

16. **scroll-lockの共有・復旧安全性**
    - bodyの既存 `overflow`、`position`、`top`、幅、scroll位置を保存・復旧する必要がある。
    - React Strict Mode、重複open、例外、route change、unmountでも解除されなければならない。
    - 他モーダルとのネストを考慮し、単純な設定・解除ではなく参照カウントまたは所有トークンが望ましい。

17. **`position:fixed` lockの副作用**
    - scrollbar消失による横揺れ、fixed要素、VisualViewport、横向き、ページズーム中の座標復元が論点になる。
    - `window.scrollTo()` のタイミングと、フォーカス復帰による自動スクロールの順序も決める必要がある。

18. **サイドピークとのモーダル階層**
    - `modal={false}` のRadix Dialog上からPhotoSwipeを開いた際、z-index、Escapeの伝播、focus trap、閉じた後のfocus復帰先を確認する必要がある。
    - Escape一回で画像モーダルだけが閉じ、side-peekまで閉じないことを保証すべき。

19. **アクセシブルネーム**
    - alt改善自体をOutにしても、クリック可能画像をbutton化するならbuttonの名前は必要。
    - 空altや不十分なaltがありうるため、「画像を拡大」「画像Nを拡大」等のfallbackが必要。
    - counterや現在倍率の伝達を行うかも検討対象。

20. **PhotoSwipe API・既定値への依存**
    - `'fill'` の正確な意味、vertical dragがfit時だけ閉じるという挙動、既定の secondary/max zoom、destroy/close lifecycleなどを実ライブラリで確認する必要がある。
    - mock unitだけでは、設定値が渡されたことしか証明できず、要件どおりの実挙動は証明できない。

21. **ブラウザ戻る操作**
    - 全画面モーダル表示中のiOS back swipe、Android back、履歴との関係が未定義。
    - PhotoSwipeを閉じるだけか、ページ遷移するかを少なくともsmoke対象として明確にしたい。

22. **表示面ごとの回帰**
    - 編集、テーブル、サイドピーク、スマート復習、カスタム演習に加え、選択肢の操作領域との干渉を確認する必要がある。
    - buttonラップによりflex寸法、drag/select、削除ボタン配置、table cellのkeyboard操作が変わる可能性がある。

## plan ドラフトへの抜け・未考慮指摘

1. **Task 4がspecの兄弟画像decode要件を実装していない**
   - planは `media_assets → <img>.naturalWidth` としているが、兄弟画像用の `Image().decode()` が手順・testとも欠落している。
   - 非表示兄弟のDOM `<img>` refは得られない可能性が高い。

2. **Task 4の `openModal(startIndex)` はindex破綻の危険がある**
   - 未解決画像をfilterした後のindex再計算、ordinal順維持、タップasset照合が明記されていない。
   - `Promise.all` の結果順維持とasset ID基準のindex決定をtestでpinすべき。

3. **Task 4/5の責務境界に無理がある**
   - Task 4で `display='inflow'` を追加するが実挙動はthumbのままという、一時的に意味と表示が食い違う状態を作る。
   - 中間commitが出荷可能という説明とも整合しない。公開propはTask 5で追加する方が自然。

4. **Task 3のCSS import位置がde-risk不足**
   - 一時spikeを「任意のclient component」で行うだけでは、最終配置であるhook moduleからのグローバルCSS import可否を実証しない。
   - spikeは本番予定と同じimport境界で行うべき。

5. **Task 3のlifecycle test記述が曖昧**
   - 「closeでdestroy呼出」とある一方、実装制約は `destroy` eventで参照解放、unmount時はcloseとしている。
   - `close()` と `destroy()` の責務、イベント順序、二重呼出、dynamic import中unmountを分けてtestすべき。

6. **Task 3に起動競合の設計・testがない**
   - 二重open、既存インスタンス、import解決前のunmount、open失敗時の参照解放が未考慮。

7. **Task 3の明示フォーカス制御が抜けている**
   - 凍結specの「開いた直後に閉じるボタンへfocus」「トリガーへ復帰」が制約・testに十分反映されていない。
   - `returnFocus:true` のassertだけでは不足する。

8. **Task 3のズームボタンtestが浅い**
   - registerされたことしか確認せず、倍率計算、min/max clamp、reset先、current slide不在時、slide切替後の動作を検証していない。
   - WCAG代替操作の実効性をmock unitでももう一段検証できる。

9. **Task 5にresize/reflow再計算がない**
   - `getComputedStyle` と `renderedWidthPx` の初回評価だけで、回転・split view・container resize後に再評価されない。
   - `ResizeObserver` 相当とcleanupの設計・testが必要。

10. **Task 5はfold=false時のCSS clipを明確にしていない**
    - wrapperへ常に `max-height` と `overflow:hidden` を付ける記述なので、閾値未満だがcap超過の画像が無告知で切れる。
    - これはcomputeFoldの「数px超過なら畳まない」と直接矛盾する。

11. **Task 5のDOM構造が未指定**
    - 「画像外ボタン」がclip wrapperの内側か外側か、フェードとの重なり、pointer eventsが未定義。
    - component testにはDOM階層とクリック可能性も必要。

12. **Task 5のjsdom testは実CSS解決を証明できない**
    - `min(70svh,44rem)` のcomputed pixel値や実layout widthはjsdomで信頼できない。
    - `getComputedStyle`/ResizeObserverを抽象化してunit化し、実ブラウザtestでCSSとの一致を確認する必要がある。

13. **Task 6のsafe-area対応は現状成立しない**
    - `viewport-fit=cover` を変えないnon-goalと、safe-area env適用が衝突している。
    - planはこの矛盾をそのまま実装項目にしており、合否判定もない。

14. **Task 6がscroll-lock方式をsmoke後判断として先送りしている**
    - iOS実機結果がOT acceptanceなのに、結果次第で製品コード変更が必要となる。
    - その場合、Task 6の「実装完了・レビュー・全gate」と「OT smoke」の順序が循環する。
    - 実機smokeをリリース前gateにするか、最初から堅牢なfixed-body方式を実装するか、fallback用追加phaseを設けるべき。

15. **OT smoke完了前でもTask 6完了扱いに読める**
    - 必須合否としつつ「依頼パッケージ提示」で完了条件を満たす記述になっている。
    - 「実装完了」と「実機acceptance待ち」を別ステータスにすべき。

16. **smokeに性能・失敗経路がない**
    - Cache miss、低速回線、オフライン、兄弟画像一部失敗、10画像target、decode失敗、モーダル連続開閉が欠落している。

17. **smokeに表示面別の重なり確認が足りない**
    - side-peek上、table cell、編集面削除ボタン隣接、スマート／カスタム両演習を明示すべき。
    - z-index、Escape伝播、focus復帰の確認も必要。

18. **PhotoSwipe実挙動のde-riskがTask 1にない**
    - Task 1はbuild/hydration/auditのみで、長尺`fill`、vertical drag条件、画像tap非close、ズームボタンAPIは確認しない。
    - 重要なAPI仮定は実装後の最後のsmokeまで不明なままになる。最小実ブラウザspikeをTask 1に含める価値がある。

19. **`errorMsg`だけでは解決前失敗を扱えない**
    - PhotoSwipeへ渡す前のobjectURL取得・decode失敗はPhotoSwipeの `errorMsg` 対象外。
    - gallery側の通知・縮退・再試行がplanにない。

20. **objectURL解放方針が全Taskで欠落**
    - resolverキャッシュURLと一時decode URLを区別した所有権テスト・cleanup規約が必要。

21. **CSP確認の観点が不十分**
    - blob画像だけでなく、dynamic import chunk、inline SVG/UI element、style適用が既存CSP下で動くことを確認すべき。
    - consoleに違反がない、だけでなくズームUIとCSSが実際に適用されることを合否に含めたい。

22. **依存追加NG時の代替案が不適切**
    - 「自前 confirm-dialog案」はピンチ、パン、長尺、WCAG操作を満たす大幅な別設計であり、単純な対抗案ではない。
    - NG時は停止して再設計、という扱いが妥当。

## リスク / 対立しうる設計判断

- **viewport不変 vs 実効的safe-area対応**  
  現在の条件では両方を完全には満たせない。凍結specの変更判断が必要。

- **全兄弟を準備してから開く vs 即時にモーダルを開く**  
  前者は順序とcounterが安定するが遅く、iOSメモリ負荷が高い。後者は応答性が高いが、後挿入や失敗時UXが複雑になる。

- **PhotoSwipeのパンを「縦スクロール」と認めるか**  
  タッチUXとしては成立しうるが、ネイティブスクロールや支援技術操作とは異なる。受入基準を明確にする必要がある。

- **軽量な `overflow:hidden` vs 堅牢なfixed-body lock**  
  前者は副作用が少ないがiOS要件を満たさない可能性が高い。後者は強いが、座標復帰・フォーカス・他overlayとの競合が増える。

- **PhotoSwipe既定値依存 vs 明示設定**  
  既定値利用はコードが簡潔だが、ライブラリアップデートで挙動が変わりやすい。UX要件に属する倍率は明示値とtestで固定する方が安全。

- **複数画像のwrap表示 vs 実表示高の上限制御**  
  wrapは単純だが、10枚時の演習フローを圧迫する。高さ抑制を本当に要件とするなら、横スクロールや表示枚数制限との比較が必要。

- **alt改善Out-of-scope vs クリック可能buttonの命名**  
  assetのalt品質改善は分離できるが、新規操作要素のアクセシブルネームまで除外すると新たなa11y退行になる。fallback名は今回必要。

- **OT実機acceptanceを完了後に置くか、リリースgateにするか**  
  scroll-lockが必須要件なら、依頼提示だけで実装完了にはできない。少なくとも「コード完了」と「実機受入完了」を分離すべき。