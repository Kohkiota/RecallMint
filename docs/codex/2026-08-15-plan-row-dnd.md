# Codex plan cross-check — row-dnd (2026-08-15)

- **作成日**: 2026-08-15
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. ドラッグ開始時と drop 時で基準順が変化する競合

`placementForRowDrop` が drop 時点の `data` を使う場合、ドラッグ中の liveQuery 更新、別入口からの移動、同期反映、削除などで、dnd-kit が認識した配置と `baseOrderIds` が食い違う可能性がある。

- ID 消失は null で安全に中止できる。
- しかし両 ID が残ったまま順序だけ変わった場合、意図しない位置へ正常 dispatch され得る。
- 「drag-start 時のスナップショットを使う」「drop 時の現行順を使う」「順序変更を検出して no-op/失敗扱いにする」のどれが契約か明示が必要。
- 凍結 spec にない判断が必要なら、実装中に暗黙決定せず OT 停止対象にすべき。

2. `UniqueIdentifier` と string ID の境界

dnd-kit の `active.id` / `over.id` は `UniqueIdentifier` であり、必ずしも型上 string ではない。一方、pure 関数、`data`、`moveCards` は string を要求する。

正規化地点を一つに固定しないと、以下が起き得る。

- `data.find(... === active.id)` が失敗して overlay が出ない。
- `placementForRowDrop` の引数で型エラーになる。
- placement は未発行なのに、`moveCards` だけ `String(active.id)` を使う不整合。

このアプリでは card ID が string であるという不変条件を、境界で型・runtime のどちらで保証するかが必要。

3. 基準順配列の不変条件

`placementForRowDrop` は、少なくとも次を暗黙に前提としている。

- ID は一意。
- 対象 exam の全 card を含む。
- `compareByBaseOrder` 後の確定的な順序である。
- active/over と同じ ID 名前空間である。

重複 ID があると `indexOf` と「最終列比較」が曖昧になり、anchor の常駐保証も崩れる。通常は上流保証でよいが、関数契約またはテスト上の前提として明文化すべき。

4. 仮想化中の全 ID と実際の drop 到達範囲

SortableContext に全 ID を入れても、未 mount 行は droppable ではない。したがって「全順序を扱える」ことと「任意の行を直接 over にできる」ことは別問題。

特に確認すべきなのは以下。

- auto-scroll 中に新規 mount 行へ collision が安定して移るか。
- active 行 unmount 後、over が一時的に存在しない区間でも auto-scroll が継続するか。
- DragOverlay は表示を保持するが、active node の登録や scroll ancestor を保持するものではない点。
- 高速スクロール時に `over=null` で意図せず無音終了する頻度。

5. locked 理由表示と native `disabled` のアクセシビリティ

native disabled button は通常フォーカスできず、環境によって hover/title も不安定である。このため、

- `disabled`
- `aria-disabled`
- `aria-describedby`
- disabled 理由をキーボード利用者にも伝える

を同じ button だけで同時に満たせるか確認が必要。必要なら説明を受け持つ wrapper 等が要るが、それは凍結 UI 契約との照合対象になる。

また、pending 中は disabled だが理由なし、locked+pending 時は locked 理由、という優先順位も明確にすべき。

6. handle のイベント分離範囲

`click.stopPropagation()` だけでなく、実際には次の経路が絡む。

- pointer down / mouse down
- touch activation
- drag 完了後に発生する click
- Space/Enter による button activation
- select `<td>` の click handler
- checkbox、side peek、行メニュー

「選択が変化しない」を click 単体ではなく、mouse/touch/keyboard の操作結果として検証する必要がある。

7. 排他制御の範囲

`dragCommitRef` は DnD の二重 `onDragEnd` には有効だが、既存の一括移動・切り出し・取り込みとの同期 ref ではない。`setMovePending(true)` は React state 更新なので、同一 tick の別入口操作まで同期的に遮断する保証はない。

「既存入口と相互排他」が強い契約なら、次を区別する必要がある。

- 次 render 以降の UI disable
- DnD 内の同期二重発行防止
- 異なる入口間の同一 tick 二重発行防止

8. commit 中のライフサイクル

mutation 待機中に以下が起きた場合の扱いが必要。

- exam/view の切替や component unmount
- liveQuery により active card が消える
- sorting/filtering 状態が変わる
- undo toast slot が別操作で置換される

書込をキャンセルしない設計なら、結果 toast の表示先と state cleanup が安全であることを確認すべき。

9. overlay の内容とレイアウト境界

`question_label ?? title` は「番号・タイトル」の両方を示す要件と一致するか注意が必要。`??` では片方しか表示しない可能性がある。

さらに、長いタイトル、空文字、改行、画像等を含む文字、横スクロール中の幅、z-index、ダークモード、portal 先での CSS variable 継承も確認対象。

10. transform と table 固有挙動

sticky 以外にも次が実ブラウザ依存となる。

- border-collapse / 行高計測
- transform 中の `<tr>` の描画
- pinned cell の z-index 重なり
- focus outline
- 横スクロール位置
- ResizeObserver 再計測と transition の相互作用

「sticky が見える」だけでなく、drop 後の計測値が壊れていないことまで確認したい。

11. keyboard DnD と仮想化

基本的な Space/矢印/drop だけでなく、

- viewport 外へ移動できるか
- mount 境界で over が失われないか
- Escape cancel
- drop 後の focus 復帰
- locked/pending 化した際の grab 状態解除

がアクセシビリティ上の主要論点。

12. toast / undo の並走

連続 DnD で toast slot が置換された場合、どの操作を undo するのか確認が必要。既存機構の仕様を消費するだけでも、1回目の undo 素材と2回目の結果が混ざらないことは接続テスト対象になる。

13. smoke の再現性と証跡

DB readback/outbox確認には、以下が必要。

- 操作前の基準順と outbox 件数の保存
- 並走同期を避けるか識別する方法
- 使用 card ID / exam ID / reqid
- 各ケース後のデータ復元
- 1200枚試験の端末・viewport・CPU条件
- touch emulation と実機結果の区別

単に目視で「動いた」では、no-op、絶対値復元、相対順保持を判定できない。

## plan ドラフトへの抜け・未考慮指摘

1. stg smoke が実行 task に含まれていない

Task 5 は smoke を「実施待ち一覧」として記録するだけだが、凍結 spec は全12項目の FAIL を prod blocker としている。したがって、Task 5 完了を「sprint 完了」と扱うのは不正確。

少なくとも plan 上で以下を分離すべき。

- 実装・静的 gate 完了
- push 後 smoke 実行
- DB/outbox readback と証跡保存
- 全12項目 pass 後の prod-ready 判定

2. drag 中の `data` 変更に対する契約がない

Task 4 は handler の closure 内の `data.map(...)` をそのまま利用するが、drag-start から drop までに順序が変わった場合の判断がない。spec の「items changed は dnd-kit に委ねる」は表示再計測の説明であり、mutation の意味論までは保証しない。

3. ID 正規化が不統一

Task 4 は `moveCards` だけ `[String(active.id)]` としている一方、

- `activeDragCard` の検索
- `placementForRowDrop`
- `over.id`

の正規化が記載されていない。境界で一括して string と検証する必要がある。

4. DndContext の partial mock 方針が危険

計画では実 DndContext を透過 wrapper に置換して props を捕捉するが、`SortableRow/useSortable` は実 DndContext の内部 context を必要とする。単に children を返す mock では、handle listeners/attributes が生成されず、テストが壊れるか本物と異なる状態になる。

実 DndContext を内側に保持して捕捉するか、drop handler をテスト可能な境界へ切り出す必要がある。

5. `placementForRowDrop` のテストが spec を完全には列挙していない

Task 1 には active/over 不在等はあるが、spec が明記する「最終列が入力列と一致した場合」の明示ケースがない。通常、一意 ID 前提では `active===over` 以外に到達不能なので、到達不能理由または duplicate input の扱いを決める必要がある。

6. Drag cancel の接続テストがない

`onDragCancel` で overlay が消えること、mutation/toast が出ないこと、focus/grab 状態が破綻しないことが未検証。

7. onDragStart の gating/race テストがない

disabled handle により通常開始不能でも、sorting/pending が切り替わる瞬間や手動 callback 発火時に preview state が残らないことは未検証。少なくとも cancel/end後の cleanup を pin したい。

8. locked 理由のテストが支援技術上不十分

`disabled + aria-describedby` の属性存在だけを確認しても、disabled button が説明へ到達可能とは限らない。既存 pattern の踏襲だけで十分か、実ブラウザ/アクセシビリティ確認が必要。

9. overlay 内容の要件とのずれ

Task 3 の `question_label ?? title` は「番号・タイトルを示す preview」ではなく、どちらか一方の表示になり得る。両方表示するのか、片方のみで許されるのか照合が必要。

10. overlay 自体のテストが薄い

次が接続テストにない。

- drag start で正しい card preview が出る
- end/cancel で消える
- unknown/stale active ID では安全に表示しない
- portal の SSR guard
- table row を生成しない
- タイトル省略・fallback

11. 既存入口との相互排他テストがない

plan は `movePending` 共有により相互排他と説明するが、テストは DnD 同士だけである。少なくとも commit中に一括バー等が disabled になること、または同一 tick の限界を明示すべき。

12. ref マージの挙動テストがない

安定 callback ref は重要な承認事項だが、計画は実装記述だけで、rerender時に旧 refへ不要な null/new node 通知が発生しないことを pin していない。実装レビューで見落としやすい箇所。

13. `MemoizedTableBody` 凍結中の props 更新が未評価

Task 4 は TableBodyProps に locked/pending/showHandle 等を追加しつつ comparator を不触とする。resize中は tbody が意図的に凍結されるため、その間の gating・pending・drag state変化がいつ反映されるか確認が必要。これは smoke #9だけでなく、設計上の既知挙動として記録した方がよい。

14. event 分離テストが click に偏っている

touch/keyboard/drag完了後clickで選択が変わらないことが未考慮。spec の「handle click」は満たしても、ユーザー観測上の「dragで選択が変わらない」を十分に保証しない。

15. rows 1件から2件への動的変化が未検証

初期1件でhandle非描画後、liveQueryで2件になった場合にhandleが現れ、逆方向でも消えることが未検証。context/providerとmemoized tbodyの組合せ上、静的ケースだけより重要。

16. process 記述が内部矛盾している

Global Constraints は「各 feat taskをcanonical/Codex review」とする一方、Task 2 は `[no-review]`。レビュー対象外例外を認めるなら、どちらが優先か明示すべき。

17. smoke FAIL 時の分岐が作業手順になっていない

停止条件はsession docに書くだけでなく、planに明示的な分岐が必要。

- FAILを記録
- 追加修正を開始しない
- 数値・スクリーンショット・reqidを保存
- OTへ報告
- prod移行を停止

18. smoke #2 の測定方法がない

同位置dropの「outbox不増」を確かめるには操作直前直後の件数またはreqid照合が必要。バックグラウンド同期がある環境で単純な総件数比較は誤判定し得る。

## リスク / 対立しうる設計判断

- drag-start時スナップショット vs drop時の最新順  
  前者はユーザーが見て開始した順序に忠実、後者は最新DB状態に忠実。ただし後者は並走更新で意図しない位置へ動かす危険がある。

- stale順序を no-op とするか失敗toastにするか  
  無音no-opは衝突を隠し、失敗toastは一時的な同期変化でも騒がしくなる。凍結specのplacement nullとdispatch後失敗の境界に関わるため、実装者判断にしない方がよい。

- native disabled vs 理由説明可能なhandle  
  native disabledは操作防止が強い一方、フォーカス不能で理由を伝えにくい。`aria-disabled`のみは説明可能だが、イベントを完全に抑止する追加実装が必要。

- overlayがあれば長距離drag成立とみなすか  
  overlayは視覚を保持するが、droppable登録・collision・scroll ancestorまでは保証しない。長距離成立はsmoke結果依存。

- 既存 `movePending` の共有で十分か  
  UI上の通常操作には十分でも、同一tickや異なるhandler間の厳密な相互排他には弱い。強化すると既存入口や契約へ触れる可能性がある。

- 全ID SortableContext vs mount済みIDのみ  
  全IDは論理順を表現できるが、sparse rectと再計測負荷を伴う。mount済みのみは軽いが、順序indexと仮想化境界の意味論が複雑になる。後者への変更は凍結spec変更。

- 常時DndContext mount vs disabled時の完全除去  
  常時mountはtable subtreeのremountを避ける一方、全行にsortable hookとcontext更新コストを持たせる。1200枚時はmount行だけとはいえ計測コストを実測する必要がある。

- 既定auto-scroll継続 vs内部container専用制御  
  既定は依存追加なしで簡潔だがdocument優先の挙動がある。内部container制御はUXを安定させ得るが、凍結spec上はsmoke失敗後のOT再判断事項。

- 実装gate完了 vsリリース可能  
  unit/lint/buildが全greenでも、sticky・auto-scroll・1200枚・touch・resizeは未検証である。smoke完了前は「実装完了」ではあっても「prod-ready」ではない。