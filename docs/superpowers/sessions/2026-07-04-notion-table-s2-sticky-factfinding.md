# S2 sticky(バー + 列ヘッダー固定)fact-finding(2026-07-04)

- 対象: 現 HEAD(S1 反映後 = develop b844c6e 系)`exam-card-table.tsx`(712 行)/ `exam-card-table-columns.tsx`(264 行)/ `exam-detail-view.tsx`。
- 方針: **実装しない**。現物コード + TanStack Virtual 公式 docs(Context7 `/tanstack/virtual`)根拠で確定。旧 doc の行番号は使わず再確認済。
- 重要な前提訂正: **現状 sticky header は存在しない(thead は static)。sticky 左固定列も撤去済(下記③)。** タスク文の「現状 sticky が崩れる」は旧メモ由来の想定で、正しくは「まだ sticky 化されていない」。

---

## ① 現在の縦スクロール主体

- 縦スクロールは **document(window)側**。table 領域を包む `<div ref={tableContainerRef} className="overflow-x-auto">`(:555)は **高さ制約なし**(max-h / overflow-y 指定なし)。よって縦は page 全体がスクロールする(smoke ④ 実測: thead `position:static`, スクロール時 thead top = -17646、非 sticky を確認済)。
- **sticky header が(付けても)流れ落ちる理由**(旧メモ仮説の精密化 — 仮説は方向として正しい):
  - Tailwind `overflow-x-auto` は `overflow-x:auto` のみ指定 → CSS Overflow 仕様の computed-value 規則「一方が visible・他方が非 visible の場合、visible は auto に計算される」により **overflow-y も auto に昇格** → この div が両軸のスクロールコンテナになる。
  - `position:sticky; top:0` の containing block はこの overflow コンテナ。しかしコンテナ自身は **高さ無制約 = 内容と同じ高さで、縦スクロールの主体は document**。sticky はコンテナ scrollport 上端(= document と一緒に流れる)に貼り付くため、viewport 上端に固定されず流れ落ちる。
  - 要旨: **sticky header を viewport 固定するには「縦スクロールの主体 = sticky の containing block(bounded container)」を一致させる必要がある。現状は不一致**。

## ②(最重要)仮想化との関係

- `useWindowVirtualizer`(:101)を使用 = **scroll element は window に固定**(getScrollElement 等は hook が window に pre-config、Context7 確認)。`count/estimateSize=120/getItemKey=card.id/overscan=5/scrollMargin/useFlushSync:false`。
- `scrollMargin`(:106, 695)= `listOffset`(:512)= `tableContainerRef.getBoundingClientRect().top + window.scrollY`(:516)= **table container 上端の document 座標**。paddingTop/Bottom は `virtualItems[].start/end - scrollMargin`(:129,133)で document 座標を補正して spacer 高を出す。
- 公式 docs(Context7): `useVirtualizer` は **特定 HTML scroll element に紐付く**(getScrollElement で返す)。`scrollMargin` = 「scroll element 先頭 ~ list 先頭の距離」で、list の前に header がある / 1 コンテナに複数 virtualizer がある場合に使う。`getBoundingClientRect()` / ResizeObserver で動的計測可。
- **bounded container を縦スクロール主体にする = `useWindowVirtualizer` → `useVirtualizer({ getScrollElement: () => container, ... })` へ切替**が必要。この時:
  - scroll 座標系が document → container に変わる。`scrollMargin` の意味も変わり、**container 先頭〜list 先頭の距離(= thead 高、または thead を sticky で list 外に出すなら実質 0)** になる。
  - 現 listOffset(document 座標)は element virtualizer では**誤値**。scrollMargin は container 相対で再定義が要る(下記④)。
  - 変更範囲: hook 差替 + scrollMargin 算出ロジック + paddingTop/Bottom の基準。`measureElement`/`overscan`/`getItemKey` はそのまま流用可。`observeElementRect`/`observeElementOffset` は useVirtualizer default で足りる見込み(明示指定不要)。

## ③ 既存 sticky-left pin との両立 → **前提が古い(pin は撤去済)**

- `columns.tsx:7`: **「Fix-3 T2: sticky 左固定列は撤去(OT 方針: Notion 準拠で左端固定しない)」**。現コードに sticky-left / left-0 / z-index の pin は**存在しない**(exam-card-table.tsx / columns.tsx 全 grep でゼロ)。
- 帰結: **角セル(pin ∩ header)の z-index 階層問題は現状発生しない**。sticky header 単独なら header 行の z-index を body より上にするだけ(pin 交差なし)。将来 pin を再導入するなら別途検討だが本 S2 の scope 外。

## ④ ResizeObserver / listOffset / 条件バー

- 現状: `useLayoutEffect`(:513)で ①初回 recompute ②`filterBarWrapperRef`(条件バー wrapper)の ResizeObserver ③window resize、で listOffset を再計測。**目的 = 条件 chip 追加/削除でバー高さが変わると table container の document 位置がズレ → window virtualizer の scrollMargin(document 座標)が stale になり wrong row window を生むのを防ぐ**。
- bounded container 化した場合の影響:
  - **条件バーを scroll container の外(上)に置く**なら: バー高さ変化は container 内の list 原点に影響しない → scrollMargin は thead 高 or 0 で **バー高非依存**。現 ResizeObserver→listOffset の役割は消える。ただしバー高が可変で container を `max-h-[calc(100vh - バー高 - α)]` にする設計なら、ResizeObserver は **listOffset でなく container 高(または上部 offset)の調整**に用途が変わる。
  - **条件バーを scroll container の内(上)に置き sticky**にするなら: sticky header の `top` = バー高 になり、バー高変化で header top を動かす必要 → ResizeObserver をその連動に使う(CSS 変数で header top を駆動)。stacking が一段複雑。
- いずれも **現 listOffset(document 座標)ロジックは廃止 or 意味変更が不可避**。S1 で作った ResizeObserver 配線自体は再利用可能(監視対象・出力先が変わる)。

## ⑤ th の背景 / 現スタイル

- th(:586-590)= `relative px-1 py-1 font-medium text-muted-foreground border-b border-border`(+ select 列 text-center / canSort 列 cursor-pointer)。**背景色の指定なし = 透明**。table は `border-separate border-spacing-0`(:563)、border は td/th 側(border-b)に付与。
- sticky header 化には **全 th に不透明背景(例 bg-background)追加が必須**(透明だと下の行が透ける)。border-separate なので border-b はそのまま効く。select 列(全選択 checkbox)含め全 th に適用。角の追加スタイルは pin 不在ゆえ header 行だけで完結。

## ⑥ 回帰範囲

- `useWindowVirtualizer` 使用は **exam-card-table.tsx のみ**(全 app grep)。`InlineCardList`(card-view)は**未仮想化**(:174 コメント「将来 Grid-1 で TanStack Virtual」)= 同 scroll/sticky パターンを共有する別 component は**存在しない**。
- 親 wrapper: `exam-detail-view.tsx:107` `<div className="w-full px-2 md:px-4"><ExamCardTable/></div>`(その上は `space-y-1 pb-8`)。**高さ/overflow/sticky 制約なし**。table は full-width・document スクロール。
- 波及: 構造変更は **exam-card-table.tsx 単体(+ 必要なら exam-detail-view の wrapper 高さ)** に限局。card-view / inline 編集 / 列トグル / side peek 未実装領域は構造非共有ゆえ直接波及なし。ただし条件バーの配置(scroll container 内/外)を変えると ConditionBar/ColumnVisibilityToggle の mount 位置が動く(S1 の wrapper を触る)。

## ⑦ UX 影響(document → bounded container)

- table 領域が **独自の縦スクロールバー**を持つ(ネストスクロール)。page 全体は伸びず、table は viewport 内の固定高さ領域になる → 高さを `calc(100vh - 上部 chrome - 条件バー - α)` 等で決める必要(値は実測要)。
- 利点: 300+ 行で **ヘッダー(と条件バー)が常時可視** = 列の意味・適用中フィルタが見失われない(Notion 的挙動)。
- 難点: ①二重スクロールバー(ページ外側 + table 内側)の見え方 ②mobile 短 viewport で bounded 高さが小さくなる + 既存 fixed bottom action bar(pb-32)との干渉再確認 ③慣性スクロール/スクロール連鎖の体感変化。**OT の受容判断が要る点**。

---

## 実現方式の候補

### 方式 A(推奨): bounded container + element virtualizer で sticky 一式
- table container を bounded 高さ(`max-h-[calc(...)] overflow-auto`)にし、`useWindowVirtualizer`→`useVirtualizer({getScrollElement:()=>container})` へ。thead を `sticky top-0` + 不透明 th 背景。scrollMargin は container 相対(thead 高 or 0)へ再定義。
- 条件バーは **方式 A-out(container の外・上、非スクロール、常時表示)** を既定推奨 / A-in(container 内で sticky)も可(下記)。
- Pros: TanStack 公式の table-sticky 正道。バー + ヘッダー両方が自然に固定。横スクロールも同 container に同居。
- Cons/リスク: 変更最大(virtualizer 差替・scrollMargin/padding 基準の書き換え・listOffset 廃止)。bounded 高さの値決め(viewport calc)+ 二重スクロール UX。resize(CSS 変数)/ memo 凍結 / measureElement との相互作用の再検証必須。

### 方式 B: window スクロール維持のまま header を viewport-sticky
- `useWindowVirtualizer` を維持し、thead を `sticky top-0` で viewport に貼る案。
- 障害: 横スクロールに必要な `overflow-x-auto`(:555)が overflow-y も auto に昇格させ(①の CSS 規則)スクロールコンテナ化 → sticky containing block が viewport にならず header が固定されない。`overflow-y-visible` を足しても仕様上両軸 auto に計算され回避困難。横スクロールを別手段(内側 wrapper 分離等)にする改造が要り、結局①の構造矛盾に触れる。
- Pros: virtualizer 差替不要。Cons: CSS 構造矛盾で**クリーンに成立しにくい**。sticky バーは別途 document-sticky が要る。**非推奨(調査により viable 性低い)**。

### 条件バーの内/外(方式 A 前提)
- **A-out(外・上)**: バーは常時表示・スクロール非連動。実装単純、stacking 単純。バー高可変 → container の max-h calc に反映(ResizeObserver を container 高調整へ転用)。既定推奨。
- **A-in(内・上で sticky)**: バーも container 内で sticky。header の `top` = バー高 に連動(ResizeObserver で駆動)。stacking(バー > header > body の z-index)と top 連動が一段複雑。バーも横スクロールに追従してしまう懸念(横長 table でバーが横に流れる)→ 追加対処要。

## 停止
spec/plan は未作成・実装なし。上記の事実 + 候補 + trade-off を OT 判断材料として提示し停止。
