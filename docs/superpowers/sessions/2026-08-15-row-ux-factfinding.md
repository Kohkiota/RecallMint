# 行左端 UI 再編(Row-UX)— 設計判断材料(2026-08-15 / 調査のみ・実装なし)

前提: 表外グリップは不採用確定。争点 = **二役グリップ(ドラッグ + クリックメニュー)の成立コスト**。

確認対象は現物のみ: `@dnd-kit/core@6.3.1` / `@dnd-kit/sortable@10.0.0` の dist 実読、行 DnD 実装(row-dnd sprint 完了時点 = `c2e6cb2`)、Tailwind v4.3.3 の**生成 CSS**。

---

## 0. 結論(先出し)

1. **二役グリップは成立する。しかも dnd-kit 側の設計がそれを前提にしている** — 距離制約下では activation しなかった場合に click 抑止 listener が**そもそも張られない**(dist 実読で確定)。追加の click 制御コードは不要。
2. **最大のコストは gating の作り替え**。現行 handle は native `disabled` と `showHandle` の 2 つで「描画ごと消す/押せなくする」設計で、**メニューが常時生きる必要がある二役とは正面から衝突**する。ただし置き換え先は `listeners` を渡さないだけで、実装量は小さい。
3. **Space=drag / Enter=menu の分離は可能**(`keyboardCodes` は sensor option・dist 確認済)。ただし sensor option はグローバルなので、#1 と同じ「hook の引数化」が前提条件になる。
4. **hover 出現(#4/#5)は本 repo で一度「構造的欠陥」として除去された設計**。Tailwind v4 は `hover:`/`group-hover:` を `@media (hover:hover)` で包むため、素朴に書くと**タッチ環境で永久に不可視**になる。採るなら escape hatch 必須。
5. footer 行(#6)は構造的には容易。**唯一の落とし穴は `buildEmptyCard` の呼出契約**(フィルタ後の部分集合を渡してはならない、と実装側が明記)。
6. mobile 無効化(#7)は **sensor 不装着より listeners 非付与が安全**。二役グリップを採る場合は sensor 不装着は**そもそも採れない**(メニューまで消える)。

---

## 1. MouseSensor の距離制約を「行 DnD だけ」に適用する

### 1.1 hook 引数化の影響(tag 3 site)

現行 `lib/dnd/use-sortable-sensors.ts:27-35` は引数なし。呼出は 4 site すべて `useSortableSensors()`:
`category-list.tsx` / `option-list.tsx` / `card-tag-add-popover.tsx` / `exam-card-table.tsx`。

**既定値維持で tag 3 site は無影響にできる**(optional 引数 + 現行値を default)。ただし 1 点、dist に由来する注意がある:

- `useSensor(sensor, options)` は `useMemo(..., [sensor, options])`(`core.esm.js:190-196`)、`useSensors` は `useMemo(..., [...sensors])`(`:198-205`)。**options に毎 render 新しいオブジェクト literal を渡すと両方の memo が無効化**され、sensors 配列の identity が毎 render 変わる。
- **これは既に現行コードで起きている** — `use-sortable-sensors.ts:30-33` が `{ activationConstraint: { delay: 250, tolerance: 5 } }` と `{ coordinateGetter }` を inline literal で渡している。実害は「DndContext が sensors prop の変化を毎 render 見る」程度で、今のところ問題化していない。
- 引数化するなら **default をモジュールスコープの凍結定数にし、呼出側にも安定参照(モジュール定数 or `useMemo`)を要求**するのが正しい。ここを緩めると「行 DnD だけ」の変更が 4 site 全体の再 memo 化を悪化させる。

**推奨シグネチャ**(全 option の素通しにしない = YAGNI):
```
useSortableSensors(opts?: { mouseActivationConstraint?: PointerActivationConstraint })
```
`PointerActivationConstraint` は `@dnd-kit/core` が export 済(`dist/index.d.ts`)。

### 1.2 距離制約下で click が handle まで届くか → **届く(dist で確定)**

`AbstractPointerSensor`(`core.esm.js:1383-1580`)の実読:

| 事実 | 位置 |
|---|---|
| click 抑止 listener を張るのは **`handleStart()` の中だけ**: `documentListeners.add(EventName.Click, stopPropagation, { capture: true })` | `:1494-1510` |
| `attach()` は距離制約があると `handlePending()` して **early return**(`handleStart()` を呼ばない) | `:1450-1468` |
| `handleMove()` は `hasExceededDistance(delta, distance)` を満たしたときだけ `handleStart()` | `:1516-1560` |
| 閾値未満で pointerup → `handleEnd()` → `detach()`。`activated === false` なので `onAbort` のみ | `:1563-1575` |
| `detach()` は documentListeners の除去を **50ms 遅延**(コメント: 「`click` を listen しているため」) | `:1476-1479` |

したがって:

- **押して閾値未満で離す** → `handleStart` 未実行 → **抑止 listener が存在しない** → native click が発火し、React root の delegated listener に届く → **メニューが開く** ✓
- **閾値を超えてドラッグ** → capture 段階で document が click を stopPropagation → **button の onClick は発火しない**(ドラッグ後に誤ってメニューが開くことはない)✓ 50ms 遅延除去が mouseup→click の順序を確実にカバーする。

**さらに重要**: pending 中は `active` が立たない。`onPending`(`:3045-3066`)は callback と monitor event を撃つだけで、`Action.DragStart` の dispatch は `onStart`(`:3067-`)にしかない。→ **閾値未満の押下では transform も DragOverlay も一切出ない**(視覚的に「ただのクリック」に見える)。二役の見た目上の要件を dnd-kit が満たしている。

**注意 2 点**:
- 距離制約に `tolerance` を**付けない**こと。付けて超過すると `handleCancel()` に落ちる(`:1541-1544`)。`{ distance: 4 }` 単体で良い。
- **TouchSensor は変更不要で二役が成立する**。`{delay:250}` の delay 制約も同じく「`handleStart` 未実行 → 抑止なし」なので、**タップ = メニュー / 長押し = ドラッグ**が自動的に成立する(#7 と直結)。

---

## 2. 二役の gating 分離(drag だけ無効・click は有効)

### 2.1 現行が二役と衝突する箇所

| 現行 | 位置 | 二役での問題 |
|---|---|---|
| `disabled={locked \|\| pending}`(native) | `exam-card-row-dnd.tsx:138,158` | **native disabled は click ごと殺す** → ソート中にメニューが開けない |
| `if (!ctx \|\| !ctx.showHandle) return null`(1 枚以下で非描画) | `:135` | **1 枚の exam でメニューが消える** |
| `title={locked ? ROW_DND_LOCKED_REASON : undefined}` | `:159` | 文言が「並べ替えできません」= コントロール全体が死んでいる含意 |
| `disabled:opacity-50 disabled:cursor-not-allowed` | `:166` | native disabled 前提の視覚 |

参考: **行メニュー(⋯)は既に「trigger は常時有効・menu 項目だけ disabled」** という形を採っている(`exam-card-row-menu.tsx:116-119`)。二役グリップはこの形をグリップ側に持ち込むことになる。

### 2.2 実装形の候補

**(A) native `disabled` を外し、dnd-kit の listener 抑止に委ねる — 推奨・最小**

`useSortable({ disabled: true })` の内部経路を dist で確認:
- `normalizeLocalDisabled(true, ...)` → `{ draggable: true, droppable: false }`(`sortable.esm.js:625-640`)
- → `useDraggable({ disabled: disabled.draggable })`(`sortable.esm.js:497-504`)
- → `listeners: disabled ? undefined : listeners`(`core.esm.js:3446`)

つまり **`disabled` 時は `listeners` が `undefined`** で、`{...undefined}` の spread は no-op。**button は押せるがドラッグは起動しない**状態が、追加コードなしで得られる。

必要な差分:
1. `disabled={...}` を削除(native disabled をやめる)
2. `{...attributes}` の**後**に `aria-disabled` を上書き。`attributes` は常に `'aria-disabled': disabled` を含む(`core.esm.js:3432-3439`)ため、放置すると「押せるのに aria 上は無効」という嘘になる
3. `title` / `disabled:` 系 class を、`data-drag-disabled` 等の属性駆動に置換
4. `showHandle` を **描画 gate から drag gate へ降格**: button は常に描画し、`listeners` / `setActivatorNodeRef` を `showHandle && !locked && !pending` のときだけ渡す

**規模**: `exam-card-row-dnd.tsx` の `RowDragHandle` 内で完結(±20 行程度)。`SortableRow` の props 型に変更なし。呼出側(columns / table)は無変更で済む。

**注意**: `setActivatorNodeRef` を外す条件は慎重に。KeyboardSensor の activator は `event.target !== activator` なら `return false` する(`core.esm.js:1357-1362`)ので、**ドラッグ可能な状況で ref を外すとキーボードドラッグが死ぬ**。「ドラッグが元々不可能なときだけ外す」なら安全。

**(B) メニューを別コントロールに残す(= 現行構造)** — コスト 0 だが二役という前提を満たさない。

**(C) 入れ子の focus stop 2 つ** — #3 の代替案。§3.3 で述べる。

---

## 3. Keyboard / SR: Space=drag / Enter=menu に分けられるか

### 3.1 可能(dist で確定)

```
defaultKeyboardCodes = { start: [Space, Enter], cancel: [Esc], end: [Space, Enter, Tab] }
```
(`core.esm.js:1098-1102`)

`keyboardCodes` は **sensor の options から読まれる**:
- activator 側: `handler: (event, { keyboardCodes = defaultKeyboardCodes, onActivation }, { active }) => ...`(`:1345-1370`)
- instance 側(end/cancel 判定): `const { keyboardCodes = defaultKeyboardCodes, ... } = options`(`:1183`)

→ `useSensor(KeyboardSensor, { keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space','Enter','Tab'] }, coordinateGetter })` で分離できる。

**なぜ Enter がメニューに回るか**: activator が `start` に含まれない code で `return false` すると、**dnd-kit は `event.preventDefault()` を呼ばない**(`:1364` は start 分岐の内側)。`<button type="button">` の Enter は keydown で native click を生むため、そのまま onClick に届く。
逆に Space は start 分岐で `preventDefault()` されるので、**Space は click を生まない**(ブラウザの button Space→click は keydown の既定動作抑止で止まる)= ドラッグ専用になる。

### 3.2 前提条件と副作用

- **sensor option はその DndContext 全体に効く**。行 DnD だけに適用するには **#1 の hook 引数化が前提**(tag 3 site は default = Space/Enter 両方 start のまま)。
- `end` から Enter を抜くかは別判断。残せば「ドラッグ中の Enter = 確定」で、ドラッグ中でない Enter = メニュー、と文脈で分かれる。**残す方を推奨**(抜く理由がない)。
- **SR 文言との整合が悪化する**。dnd-kit 既定の `screenReaderInstructions` は英語で "press the space bar" と言っており(session doc §7 follow-up 1 で既知)、キー割当を変えると**内容がさらにズレる**。二役を採るなら `DndContext` の `accessibility.screenReaderInstructions` に日本語 + 実キーの説明を渡す作業が実質セットになる。
- `aria-keyshortcuts` を button に足すのも一手(前例なし)。

### 3.3 分離できない/したくない場合の代替

**別 focus stop に分ける**: グリップ(drag 専用)と ⋯(menu 専用)を隣接した 2 button のまま残す = **現行構造**。キーボード操作の曖昧さがゼロで、SR 文言も既定のままで矛盾しない。二役の唯一の利点(横幅 24px の節約と視覚的単純さ)を捨てる代わりに、#2/#3 のコストがまるごと消える。

---

## 4. hover 出現を CSS opacity のみで行う場合の現構造との整合

### 4.1 機構は既にある

- `<tr>` に `group` が付いている(`exam-card-row-dnd.tsx:118` = `'group hover:bg-muted/50'`)
- `group-hover:` の実使用前例あり(`exam-card-table.tsx:251` の pinned td 背景合成)

### 4.2 ただし致命的な前提: Tailwind v4 の `hover:` は media 内

生成 CSS(`.next/static/chunks/*.css`)を実読して確認:

```
@media (hover:hover){.group-hover\:bg-\[color-mix(...)\]:is(:where(.group):hover *){background-color:var(--muted)}
```

**Tailwind v4.3.3 は `hover:` / `group-hover:` を `@media (hover:hover)` で包む**。→ タッチ端末(`hover: none`)では `group-hover:opacity-100` が**一度も適用されない** → `opacity-0` のまま **永久に不可視**。

### 4.3 本 repo は既にこの欠陥を踏んで除去している

`exam-card-table-columns.tsx:108-114` のコメント(現物):

> 行操作ボタン(カードを開く)の常時表示化: title 列 hover 隠しは md: 幅ブレークポイントを hover 能力の代理にしていたが、**iPad 横向きは md 以上に該当しつつ hover が無く不可視になる構造的欠陥**だった。select 列(checkbox 隣接)へ移設し、**幅/hover 分岐なしで常時表示**する。

**hover 隠しは、この行のこのボタンについて、一度不具合として撤去された設計**。再導入は「同じ穴を別の書き方で掘り直す」提案になるため、採否は設計判断として明示的に扱うべき。

### 4.4 それでも採るなら最小安全形

```
opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100
```
- `pointer-coarse` / `pointer-fine` / `any-pointer-coarse` は **Tailwind v4.3.3 が標準搭載**(`node_modules/tailwindcss/dist/lib.mjs` に variant 名を確認)
- `group-focus-within:` は media で包まれない → キーボード経路をカバー
- **repo 内の前例はゼロ**(`focus-within` / `pointer-coarse` / `any-hover` / `@media (hover` の grep = 0 件)。初使用になるので理由コメント必須
- `opacity-0` は **hit-test に残る**(押せる不可視ボタン)。押せなくするなら `pointer-events-none` を併用するが、そうすると Tab で `focus-within` に到達できなくなる → **hit-test は残す方を推奨**

---

## 5. タイトルセル右端の「開く」hover 表示化

### 5.1 現配線

- 「開く」button は **select セル内**・常時表示(`columns.tsx:139-152`)。`aria-pressed={meta?.activeCardId === card.id}` で peek 開閉状態を反映
- title セルは **`InlineTextField` 単体**(`columns.tsx:170-186`)。size は **80**(`:167-168`)

### 5.2 差分

| 項目 | 内容 |
|---|---|
| JSX 移設 | select セル → title セル。title セルは現在ベタ描画なので `flex items-start gap-1` + field 側 `min-w-0` の wrapper 新設が要る |
| **click 競合** | `InlineTextField` の表示モードは `role="button"` + `onClick={startEdit}`(`inline-text-field.tsx:304-307`)。**セル全体が編集開始のクリック領域**なので、隣に置く button は `stopPropagation` 必須(select td の選択トグルと合わせて **2 段の伝播遮断**が要る) |
| 垂直位置 | 全 td が `align-top`(`exam-card-table.tsx:249`)→ ボタンは上端揃えになる。中央寄せしたいなら td 単位の例外が必要 |
| 列幅 | 80px に 24px ボタン + gap を入れるとテキストが ~52px。**幅の引き上げが実質必須** → `--col-title-start` の pinned offset を pin している既存 fixture(`exam-card-table.test.tsx`)の更新が連鎖 |
| hover 表示 | **§4 の結論がそのまま効く**。hover-only にすると 4.3 で撤去した欠陥の再導入になる |

**規模**: コード自体は 1 file + 幅定数 + test fixture で小さい。**判断の重心は実装量ではなく §4**。

---

## 6. 末尾 footer 行「+ カードを追加」

### 6.1 構造(spacer との関係)

現行 `<tbody>` = `[上 spacer tr?] + 仮想行 + [下 spacer tr?]`(`exam-card-table.tsx:207-279`)。spacer は `colSpan={visibleColCount}`(`:189`)を使う。

- 仮想化の `count` は `rows.length`(`:170`)なので、**footer を足しても仮想化の index には一切干渉しない**
- 置き場は 2 案:
  - **(i) `<tbody>` 内・下 spacer の後**: `colSpan={visibleColCount}` が要る。**`MemoizedTableBody` の凍結対象に入る**(comparator `next.isResizing`・`:288`)ため、列 resize 中はクリックが無視される(実害は小)
  - **(ii) `<tfoot>` を `ExamCardTable` 側で描画** — 推奨。spacer の高さ計算と完全に無関係になり、memo 凍結の外に出る。`<table>` 直下に `<tfoot>` を置けばよい

### 6.2 sort / filter 中の扱い(要判断)

**落とし穴が 1 つある**。`buildEmptyCard` の呼出契約が実装側に明記されている(`lib/cards/empty-card.ts:22-24`):

> `existingBaseOrders` は **対象 exam の全 card** の base_order(表示中のフィルタ後やページング後の部分集合を渡してはならない — 末尾でない位置に採番されるため)

→ footer は **`data`(基準順・全件)を渡す**必要がある。`table.getRowModel().rows`(sort/filter 適用後)を渡すと **末尾でない位置に採番される** = 静かなデータ不整合。

その上で、sort/filter 中に追加を許すか:
- **許す**: 採番は常に基準順の末尾で正しい。ただしフィルタに合致しない新カードは**画面に現れない**(ユーザーには「押したのに何も起きない」に見える)
- **無効化する**: DnD gating と同じ `positionLocked` を流用して disabled + 理由表示。一貫性は高い

カードビューには sort/filter がないため、**これはテーブル専用の判断**。

### 6.3 カードビューとの共有抽出点

`inline-card-list.tsx:363-423` の `handleAddCard` が単位。内訳:

| 部位 | 共有可否 |
|---|---|
| `newId()` を **await より前に同期採番**(Sprint I W5 の順序契約・`:374-375`) | 共有 |
| `buildEmptyCard(cards.map(c => c.baseOrder), cards.length)` | 共有 |
| `runOptimisticCreate({ userId, id, mirrorStore: db.cards, buildRow: buildNewClientCard, buildMutation: buildNewCardMutationPatch, logEvent, throwOnError: true })` | 共有 |
| `setNewCardIds(add)`(auto-edit marker) | **カードビュー固有** |
| `setError('カードの追加に失敗しました。')`(inline error UI) | **表示面固有** |

**抽出案**: `useAddCard({ userId, examId })` → `addCard(baseOrders: number[], count: number): Promise<string>`(新 id を返す)。auto-edit marker と error 表示は各ビューに残す。id を返すことで「await 前の同期採番」順序を壊さずに両ビューが marker を持てる。

**規律との関係**: 抽出後の実消費は **2 site**(rule of three 未満)。ただしこれは「将来のための汎用化」ではなく、**非自明な 4 段の楽観書込シーケンスに実在の 2 番目の消費者ができる**ケース。判断は分かれる — 抽出するなら「rule of three 未満だが、順序契約(同期採番)を 2 箇所で正しく再現させる方が危険」という理由を 1 行残すのが筋。

---

## 7. mobile(pointer: coarse)で DnD を丸ごと無効化する切り方

### 7.1 2 案の比較

| 案 | 実装 | リスク |
|---|---|---|
| **(a) sensor 不装着** | `matchMedia('(pointer: coarse)')` を購読し、coarse なら TouchSensor を外す | **SSR/hydration**: 初回 client render は server と一致させる必要があるため「desktop で開始 → mount 後に反転」になり、**sensors 配列が生存中に差し替わる**。dnd-kit は `useSensors` の memo で受けるが、**ドラッグ中の差し替えは未検証領域**。repo の `matchMedia` 前例は one-shot 読み取りのみ(`components/pwa/install-prompt.tsx:25-26`)で、購読の前例はない |
| **(b) listeners 非付与 / handle 非描画** | `showHandle` 相当の条件に coarse を足す、または CSS の `pointer-coarse:hidden` | **既にテストで pinned 済の経路**(`exam-card-row-dnd.tsx:135` の null 描画)。DndContext と droppable 登録は残るが無害 |

**(b) が安全**。理由は「新しい状態遷移を増やさない」こと。

### 7.2 二役グリップを採る場合は (a) が**そもそも採れない**

タップでメニューを開く設計にすると、**グリップを消す = メニューも消える**。したがって切り口は必然的に:

> **button は描画したまま、`listeners` を `pointer: fine` のときだけ渡す**

これは §2.2 (A) の「`listeners` を条件付きで渡す」設計と**同じ機構**に乗る。二役を採るなら #2 と #7 は 1 つの実装で片付く。

### 7.3 補足: タップは既に安全

TouchSensor は `{delay:250, tolerance:5}` のままなので、**タップでは `handleStart` に到達しない**(§1.2 と同じ経路)。つまり「モバイルで DnD を切る」の実質的な対象は**長押しドラッグだけ**であり、誤爆防止としては既に効いている。切るかどうかは UX の好みの問題で、安全性の問題ではない。

---

## 8. コスト概算(相対)

| 論点 | 実装規模 | 判断の重さ |
|---|---|---|
| 1. hook 引数化 + distance | 小(hook 1 file + 呼出 1 箇所) | 小(既定維持で 3 site 無影響) |
| 2. gating 分離 | 小〜中(`RowDragHandle` 内で完結・±20 行) | **中**(aria / 文言 / 視覚の意味を作り直す) |
| 3. Space/Enter 分離 | 小(#1 に相乗り) | **中**(SR 文言の日本語化がほぼセット) |
| 4. hover 出現 | 小 | **大**(一度撤去した設計の再導入) |
| 5. 「開く」を title へ | 小〜中(列幅 + fixture 連鎖) | **大**(#4 と同じ論点 + 編集セルとの click 競合) |
| 6. footer 行 | 中(抽出込み) | 中(sort/filter 中の可否 + 抽出の是非) |
| 7. mobile 無効化 | 小(#2 に相乗り) | 小 |

---

## 9. spec で決める必要がある論点

1. **二役にするか、グリップと ⋯ を別 focus stop のまま残すか**(§3.3)。二役は #2/#3/#7 を 1 本の機構に束ねられるが、a11y の作り直しが伴う
2. **hover 出現を採るか**(§4)。採るなら `pointer-coarse:` escape hatch を必須要件として spec に書く
3. **「開く」を title セルへ移すか**(§5)。移すなら列幅と test fixture の連鎖を見込む
4. **footer 行を sort/filter 中に有効にするか**(§6.2)
5. **`useAddCard` 抽出を rule-of-three 未満で行うか**(§6.3)
6. **Space/Enter 分離に伴い日本語 `screenReaderInstructions` を同 sprint で入れるか**(§3.2。既存 follow-up と統合できる)

## 10. コード読解では確定できず、実測が要る項目

- `{distance: 4~6}` の閾値が実機の指/トラックパッドで「意図せずドラッグ」と「押しても掴めない」の間に収まるか
- 二役グリップのタップ判定が、タッチ端末で **250ms 長押し(ドラッグ)** と **タップ(メニュー)** に体感上きれいに分かれるか(前回 smoke の #8 と同じく **実機必須** — emulation では調停が再現されない)
- `pointer-coarse:` を使った hover 出現が iPad(hover なし・幅は md 以上)で意図どおり常時表示になるか
