# Row-UX 設計: 行左端 UI 再編(二役グリップ + 低コントラスト常時表示 + footer 追加行 + DnD a11y 日本語化)

- 日付: 2026-08-15
- 対象 sprint: Row-UX(行 DnD sprint の直上に積む)
- 種別: feat(UI 再構成のみ — **DB migration なし・wire 変更なし・server 変更なし・sync 変更なし**)
- 状態: **確定・凍結**(2026-08-15 OT 承認 — §13 の 9 点承認済。承認時指示の修正 4 点を反映した上で凍結: ① footer gate に `dataReady = liveData !== undefined` を追加(未解決中の `addCard([], 0)` 発行防止・0 件 footer の有効化は query が空配列へ解決した後のみ・deferred test 追加)② footer gate に `movePending` を追加(ドラフトの「塞がない」を裁定で反転 — card_move と create は wire が別でも**同じ base_order 空間**を更新し、move 側 snapshot 読取後の並走 create が再採番 assignment から漏れて「末尾追加」を破るため)③ `dragAvailable` と `dragEnabled` を分離(dnd attributes / aria-roledescription / dnd instructions は `dragEnabled = dragAvailable && !locked && !pending` の時だけ。locked 時は menu button semantics + `lockedReasonId` のみ。`setActivatorNodeRef` は dragAvailable 中維持)④ `useAddCard` の順序 = card id mint → `buildEmptyCard` → `onIdMinted` → 最初の await(現行挙動保存)+ distance 表記を ≤4px click / >4px drag に訂正)。**以後、本 spec は実装フェーズで書き換えない** — 仕様判断が必要になった時点で停止し OT に相談する。
- 入力: OT kickoff(確定 10 項・2026-08-15)/ Row-UX fact-finding(`docs/superpowers/sessions/2026-08-15-row-ux-factfinding.md` — dnd-kit dist 実読・Tailwind v4 生成 CSS 実読の根拠 file:line は同 doc)/ 行 DnD spec(凍結・`2026-08-15-row-dnd-design.md`)/ 行 DnD session doc(`sessions/2026-08-15-row-dnd.md`)/ Codex 裁定 2 本(方針レビュー + hover 出現 NO-GO — claude.ai 側裁定。repo 内に raw doc は無く、結論は kickoff 決定 2 に集約済)
- 前提: 行 DnD sprint は実装完了・push 済・stg smoke 11/12 PASS(#8 touch のみ OT 実機待ち)・**prod 未反映**。本 sprint はその上に積み、smoke を合わせて**まとめて prod 反映**する。行 DnD の凍結契約(`placementForRowDrop` / 同期 ref guard / DragOverlay / `useMoveCards` 素通し)は**不触** — 変更が必要になったら停止して OT 相談。

## 0. 目的

テーブルビュー行左端(select 列)を「グリップ ⠿ + チェックボックス ☐」の 2 要素に再編する。グリップは二役(ドラッグ = 並べ替え / クリック = メニュー)で、「開く」常設ボタンと ⋯ 行メニューの機能を吸収する。表示は常時表示 + 低コントラスト(hover 出現は NO-GO 裁定済 — §12)。テーブル末尾に「+ カードを追加」footer 行を新設し、作成ロジックはカードビューと共有の `useAddCard` に抽出する。dnd-kit の SR 既定文言(英語 + 生 card id)は日本語 instructions / announcements で全 DnD site 一括解消する(既起票 a11y follow-up の履行)。

## 1. 決定事項

### 1.1 OT 確定(kickoff 10 項 — 本 spec の前提)

1. select 列 = グリップ + checkbox の 2 要素のみ。「開く」常設ボタンと ⋯ 行メニューは撤去(機能はグリップメニューへ)。列幅 112 → 72〜80px 目安。
2. 常時表示 + 低コントラスト(通常時 `text-muted-foreground/40〜60`・行 hover / focus-visible で通常色・選択済み ☐ は常時通常色)。DOM / hit area(size-6)/ レイアウトは全環境同一。`opacity-0` 化・conditional mount・メディアクエリ分岐は**禁止**。hover 出現の NO-GO 理由と Codex 妥協案の再訪条件は scope 外節に記録(§12)。
3. グリップ二役: ドラッグ = 並べ替え(現行どおり)/ クリック = メニュー。MouseSensor に `distance: 4〜6` の activationConstraint を**行 DnD 専用 option** として追加(`useSortableSensors` の option 引数化・tag 3 site は既定値で無影響)。activation 前の click は dnd-kit が抑止しない(dist 確認済)ため**追加の click 制御は書かない**。
4. メニュー項目 = 開く(サイドピーク)/ ここに取り込む。既存 row-menu 実装を土台に統合。
5. gating 分離: `positionLocked` / `movePending` は「ドラッグのみ無効」(listeners を渡さない)。メニューは sort/filter 中も 1 枚でも常に生きる。`rows >= 2` は「ドラッグ役のみ」の条件に変更。locked 理由の提示先はドラッグ役の無効表示に限定(文言は既存 `ROW_DND_LOCKED_REASON`)。
6. Keyboard: Space = drag / Enter = menu(`keyboardCodes` カスタマイズ。Enter を start から外すと native button click がメニューへ届く — dist 確認済)。日本語 `screenReaderInstructions` を同 sprint で導入し、既起票 a11y follow-up(SR 英語既定文言 + 生 card id 露出)を一括解消。
7. モバイル: 端末判定による無効化・分岐は一切しない。TouchSensor `delay: 250` がタップ起動を既に防いでおり、タップ = メニュー / 長押し = ドラッグが全環境一様。
8. footer「+ カードを追加」: テーブル末尾・非仮想 footer(virtualizer / SortableContext の item に含めない)。sort/filter 中は disabled + 理由表示。`buildEmptyCard` には**基準順全件の `data`** を渡す(`getRowModel().rows` 禁止 — 呼出契約)。作成ロジックはカードビューと共有の `useAddCard` に抽出。
9. 「この行の下にカードを追加」は scope 外(次 sprint)。
10. DB / wire / server / sync / `useMoveCards` / card_move 契約は不触。行 DnD の凍結契約も不触。

### 1.2 spec が確定する設計判断(→ §13 に OT 確認点として集約)

- D-a **二役は 1 button 兼用**(視覚 1 要素・内部分離の 2 button 案は不採用)— §2.1
- D-b **統合の置き場 = `exam-card-row-menu.tsx` の `ExamCardRowMenu` を再構成**(trigger を grip 化)。`exam-card-row-dnd.tsx` は `RowDragHandle` を撤去し `useRowDnd()` accessor を export — §2.2
- D-c **dnd attributes / aria-roledescription / dnd instructions は `dragEnabled = dragAvailable && !locked && !pending` の時だけ付与**(OT 修正 3)。locked / pending 中は menu button semantics + `lockedReasonId` のみ。`aria-disabled` は常に外す(button は menu 役で常に操作可能なため)。listeners は dnd-kit の `useSortable({disabled})` 経路に委ね、条件分岐を自前で書かない — §2.4/§4
- D-d **locked 提示 = grip の `title` + `aria-describedby = lockedReasonId` 単独**(dragEnabled 時は dnd 側 id 単独 — 両状態が排他になるため、行 DnD 実装の空白合成ロジックは grip 統合で不要になる)。native `disabled` は廃止 — §4
- D-e **sensors option 化のシグネチャ** = `useSortableSensors(options?: { mouseActivationConstraint?, keyboardCodes? })`・呼出側は module スコープ凍結定数で渡す。distance = **4**(kickoff 承認帯 4〜6 内の smoke 実測調整は spec 変更にあたらない)・`tolerance` は付けない — §3
- D-f **keyboardCodes = `{ start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] }`**(Enter は end に残す = ドラッグ中 Enter は drop・非ドラッグ時 Enter は menu)— §3
- D-g **a11y 共有部品 = `lib/dnd/accessibility.ts` 新設**: `buildJaAnnouncements(getLabel)` factory + site 別 instructions 定数。**DndContext 5 instance(4 file)全部**に配線 — §7
- D-h **メニュー「開く」= 既存 `openCard` トグル契約をそのまま呼ぶ**(label 固定「開く」・peek open 中の再選択は閉じる)。`openCard` 未配線時は項目非描画(既存 optional 規約と同型)— §5
- D-i **select 列幅 112 → 72**(kickoff 目安帯の下端側。grip 24 + gap 4 + checkbox 16 + 余白)— §6
- D-j **低コントラストの具体クラス**(grip = `text-muted-foreground/50` 基調 / checkbox = `opacity-50` 基調 + `checked:opacity-100`)。「group-hover は表示強度の変更であって出現ではない」の線引きを §6 に明文化 — §6
- D-k **footer は `<tfoot>`**(spacer 計算と無関係・`MemoizedTableBody` 凍結の外)・新 file `exam-card-table-add-footer.tsx`。gating = **`!dataReady || positionLocked || movePending`**(OT 修正 1/2。dataReady = `liveData !== undefined` — 未解決中に `addCard([], 0)` を発行させない。movePending を含める理由: card_move と create は wire が別でも**同じ base_order 空間**を更新し、move 側の snapshot 読取後に並走 create が入ると再採番 assignment から漏れて「末尾追加」が破れる)— §8
- D-l **`useAddCard` の抽出形** = `addCard(baseOrders, count, opts?): Promise<string>` + `onIdMinted` 同期 callback(rule-of-three 未満だが、同期採番の順序契約を 2 箇所で手書き再現させる方が危険 — fact-finding §6.3 の理由をそのまま採る)。実行順 = **card id mint → `buildEmptyCard` → `onIdMinted` → 最初の await**(現行 `handleAddCard` の順序を保存 — OT 修正 4)— §8.2

## 2. 二役グリップ

### 2.1 単一 button 兼用の根拠(D-a)

dnd-kit は「activation しなかった押下」に click 抑止 listener を**そもそも張らない**(`core.esm.js:1494-1510` — 抑止は `handleStart()` 内のみ / `:1450-1468` — 距離制約下の `attach()` は pending で early return)。よって:

- **押して移動 ≤4px で離す = click** → `handleStart` 未実行 → 抑止なし → native click → menu が開く(activation は distance の**超過**で発火するため、しきい値ちょうどは click 側)
- **>4px のドラッグ** → `handleStart` → document capture の stopPropagation で click が React root に届かない → **drop 後に menu は開かない**。`detach()` の listener 除去は 50ms 遅延(`:1476-1479`)で mouseup → click の順序を確実に覆う
- pending 中(閾値超過前)は `Action.DragStart` が dispatch されない(`:3045-3066`)= transform / DragOverlay とも一切出ず、見た目は「ただのクリック」

内部分離(重ねた 2 button)案は不採用: focus stop が 2 つに戻り決定 1 の趣旨(要素削減)に反し、hit 領域の重なり調停という新しい問題を持ち込む。

### 2.2 実装形(D-b)

- `ExamCardRowMenu`(`exam-card-row-menu.tsx`)の trigger を ⋯ から **grip button** に差し替え、menu 項目を「開く」+「ここに取り込む」の 2 つにする。Popover wrapper・`PullIntoDialog`・`PullIntoDispatch` 契約・picker 接続は現行のまま。
- `exam-card-row-dnd.tsx`: `RowDragHandle` を削除し、`RowDndContext` の consumer accessor `useRowDnd(): RowDndValue | null` を export(row-menu が raw context を import しない)。`SortableRow` / `RowDragPreview` / `ROW_DND_LOCKED_REASON` は不触(文言含む)。
- grip button = Radix `PopoverTrigger asChild` の child。ref は **setActivatorNodeRef + triggerRef(picker focus 復帰用・既存)+ Radix 内部 ref** の 3 者を安定 callback ref でマージ(SortableRow の merge ref と同じ identity 固定規律 — inline arrow 禁止)。
- `onClick` の `stopPropagation`(select td 行選択トグル遮断)は現行 grip / ⋯ と同一 pattern を維持。Radix toggle は defaultPrevented 判定のため stopPropagation では止まらない(既存コメントの確認済事実)。

### 2.3 入力経路の全 matrix

| 入力 | dragEnabled(rows≥2・非 locked・非 pending) | drag 役 locked(sort/filter/pending) | drag 役なし(rows<2 / provider 不在) |
|---|---|---|---|
| mouse click(≤4px) | menu | menu | menu |
| mouse drag(>4px) | 並べ替え(drop 後 click 抑止 = menu 開かず) | 不発(listeners なし)→ click で menu | 同左 |
| tap | menu(250ms 未満 = 起動前) | menu | menu |
| 長押し 250ms | 並べ替え | 不発 → menu(touchend の click) | 同左 |
| Space | drag grab(keydown preventDefault で click 不発生) | native click(keyup)→ menu | 同左 |
| Enter | menu(start 外 = preventDefault されず native click)。**ドラッグ中**は end code = drop(`handleEnd` が preventDefault — `core.esm.js:1319-1323` — で menu 開かず) | menu | menu |

locked / rows<2 時に Space が menu に回るのは native button の既定動作で、抑止しない(ドラッグ役が不在なら全 activation は menu 役に落ちる、が設計意図)。

### 2.4 aria の同居(D-c / D-d)

- spread 順: `{...listeners}` → `{...attributes}`(**dragEnabled 時のみ** — OT 修正 3)→ 明示 override。
- override: ① `aria-disabled` を**常に undefined に上書き**(button は menu 役で常に操作可能。dragEnabled 時の attributes は `false` を持つが属性自体を出さない)② `aria-describedby`: dragEnabled = dnd 側 id(instructions 参照)**単独** / dragAvailable かつ locked = `lockedReasonId` **単独** / それ以外 = なし。両状態は排他のため**空白合成は不要**(行 DnD 実装の合成ロジックは grip 統合で撤去)③ `aria-label` = 「行の操作: {card.title}」(二役を包む中立文言・仮置き §13-6)。
- Radix trigger 由来(`aria-haspopup` / `aria-expanded` / `aria-controls` / `data-state`)と dnd 由来(`role="button"` / `tabIndex` / `aria-roledescription="sortable"` / `aria-pressed`(drag 中のみ・`core.esm.js:3436`)/ `aria-describedby`)は key 衝突がなく共存する。`aria-roledescription` は既定 `"sortable"` のまま(既存 test / smoke の pin を維持。日本語化は scope 外 §12)。
- dragEnabled でない間(locked / pending / rows<2 / provider 不在)は dnd attributes を spread しない = `aria-roledescription` も dnd instructions への参照も付かない **menu button semantics のみ**になる(test の判別点。locked 中に「Space でつかむ」と SR に案内しない、が意図)。

## 3. sensors hook の option 引数化(D-e / D-f)

`lib/dnd/use-sortable-sensors.ts`:

```ts
export type SortableSensorOptions = {
  mouseActivationConstraint?: PointerActivationConstraint   // @dnd-kit/core export 済
  keyboardCodes?: KeyboardCodes                             // 同上
}
export function useSortableSensors(options?: SortableSensorOptions)
```

- 未指定 = 現行と完全同一(Mouse 即時 / Touch `{delay:250, tolerance:5}` / Keyboard `sortableKeyboardCoordinates`)。**tag 3 site は無変更・既存 4 assert がそのまま pin を続ける**。
- `useSensor(sensor, options)` は options の参照で memo するため(`core.esm.js:190-205`)、**呼出側は module スコープの定数を渡す**(安定参照が本質)。行 DnD 用は `exam-card-table.tsx` module スコープに:
  `const ROW_DND_SENSOR_OPTIONS: SortableSensorOptions = { mouseActivationConstraint: { distance: 4 }, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] } }`
  (`KeyboardCodes` は `KeyboardEvent['code'][]` の plain 型 — enum 縛りなし・文字列 literal で成立。`as const` は readonly 化で型不一致になるため使わない)
- `distance` に `tolerance` を**付けない**(付けて超過すると `handleCancel` に落ちる — `core.esm.js:1541-1544`)。
- hook 内部の inline literal(現行も毎 render 新 object)は default をモジュールスコープ定数化して同時に解消する(挙動不変・「引数化するなら安定参照を要求する」規律の自足)。
- 全 option 素通しの汎用化はしない(この 2 key のみ — YAGNI)。

## 4. gating 分離(kickoff 決定 5 / D-c / D-d)

`RowDndValue` を再定義: `{ listeners, attributes, setActivatorNodeRef, dragAvailable, locked, pending, lockedReasonId }`(`showHandle` → `dragAvailable` に改名 = rows>=2 判定。算出は現行どおり `ExamCardTable` の `data.length >= 2` で columnFilters 非依存)。

- `SortableRow` の `useSortable({ disabled })` は `locked || pending || !dragAvailable` に拡張。dnd-kit が disabled 時に `listeners = undefined` を返す(`core.esm.js:3446`)ため、grip 側は無条件 `{...listeners}` で正しく no-op になる — **listeners の条件分岐を自前で持たない**(fact-finding §2.2(A))。
- grip は **`dragEnabled = dragAvailable && !locked && !pending` を導出**し(OT 修正 3)、dnd attributes の spread(§2.4)・`cursor-grab`・drag 役の視覚をこれで切る。`dragAvailable` は「この試験で並べ替えが意味を持つか」、`dragEnabled` は「今この瞬間ドラッグできるか」— 別の関心事として名前を分ける。
- `setActivatorNodeRef` は **dragAvailable の間は locked / pending 中も付けたまま**(ドラッグ可能な状況で ref を外すと KeyboardSensor の activator 判定が死ぬ — fact-finding §2.2 注意。OT 修正 3 で明示承認)。
- **native `disabled` / `disabled:` 系 class は廃止**。locked 提示 = `cursor-grab` を外す + `title = ROW_DND_LOCKED_REASON` + `aria-describedby = lockedReasonId` 単独(§2.4 ②)。pending は一時状態のため理由提示なし(現行 handle と同じ扱い)。menu 役の視覚(icon 色・hit area)は不変。
- table レベルの sr-only 理由要素(`lockedReasonId` 1 個)は不触。
- **onDragEnd の 3 層目再検査(`handleRowDragEnd` 手順①〜⑥)は一切触らない**(凍結契約)。

## 5. メニュー(kickoff 決定 4 / D-h)

- 項目順: **① 開く ② ここに取り込む**。
- 「開く」: `meta.openCard(card.id)` を呼ぶだけ(トグル契約・`activeCardId` 状態・prune effect・`ExamCardSidePeek` 配線はすべて不触)。項目 click 時は menu を閉じてから発火(既存「menu を閉じてから picker」と同規約)。`openCard` 未配線(単体 harness)では項目非描画。旧 button の `aria-pressed` 表現は menu 項目には持ち込まない(open 中の再選択 = 閉じる、は従来の openCard 契約のまま)。
- 「ここに取り込む」: 現行実装(`positionLocked` で項目 disabled + `POSITION_LOCKED_REASON` / `PullIntoDialog` / picker 上限 200 / dispatch 契約)を**そのまま**移植。
- `ExamCardRowMenuProps` に `openCard?: (cardId: string) => void` を追加(meta から cell renderer 経由で渡す)。`exam-card-table-columns.tsx` の select cell は `<ExamCardRowMenu …>`(grip 内蔵)+ checkbox の 2 要素構成になる。menu の描画条件は現行どおり `meta.rowMenu` 存在時(1 枚でも・sort/filter 中も生存 — 決定 5)。

## 6. select 列再構成 + 低コントラスト表示(D-i / D-j)

- 列幅 `size: 112 → 72`。内訳: grip 24 + gap 4 + checkbox 16 + px-1 左右 8 = 52 + 余裕 20(checkbox の hit 補助・pinned 境界の窮屈回避)。`--col-title-start` 等 pinned offset の既存 fixture 更新が連鎖する(§10-7)。
- **grip**: 通常 `text-muted-foreground/50` → 行 hover(`group-hover:text-muted-foreground`)/ 自 focus(`focus-visible:text-muted-foreground`)で通常色、direct hover は現行どおり `hover:text-foreground`。
- **checkbox**: 通常 `opacity-50` → `group-hover:opacity-100` / `focus-visible:opacity-100` で通常表示、`checked:opacity-100` で**選択済みは常時通常表示**。
- **線引き(明文化)**: `group-hover:` は Tailwind v4 で `@media (hover: hover)` に包まれるため、hover 無し端末では強調が一度も発火しない。これが許されるのは**基底状態が可視(50%)だから** — 強調 = 表示強度の変更。基底 `opacity-0` は同じ書き方でも**出現** = タッチ端末で永久不可視(②-4a 前に一度撤去された構造的欠陥の再導入)であり禁止。conditional mount・`pointer-coarse:` 等のメディアクエリ分岐も持ち込まない(kickoff 決定 2)。
- 40〜60 帯内の濃度調整(50 → 40/60)は smoke 目視の結果で行ってよい(kickoff が帯で承認済 = spec 変更にあたらない)。

## 7. DnD a11y 一括解消(kickoff 決定 6 / D-g)

対象 = **DndContext 全 5 instance(4 file)**を列挙して配線する(「4 site」の実体。単一点主張をしない):

1. `exam-card-table.tsx:1039`(行 DnD)2. `category-list.tsx:230` 3. `option-list.tsx:200` 4. `card-tag-add-popover.tsx:414`(stage1 カテゴリ)5. `card-tag-add-popover.tsx:512`(stage2 option)

`lib/dnd/accessibility.ts`(新設):

- `buildJaAnnouncements(getLabel: (id: UniqueIdentifier) => string): Announcements` — 4 callback(start/over/end/cancel)を日本語で返す。位置情報は `active/over.data.current.sortable`(`{containerId, index, items}` — `sortable.esm.js:463-469`)から `{index+1} / {items.length}` を導出、sortable data 不在時は位置句を省略。**生 id は文言に一切出さない**(getLabel miss 時は「カード」/「項目」等の総称 fallback)。
- instructions 定数 2 本(`ScreenReaderInstructions` 型):
  - `SORTABLE_SR_INSTRUCTIONS`(tag 3 site 用): Space / Enter でつかむ・矢印で移動・再度 Space / Enter で確定・Escape で取消。
  - `ROW_DND_SR_INSTRUCTIONS`(行 DnD 用): Space でつかむ・矢印で移動・再度 Space で確定・Escape で取消・**Enter でメニューを開く**。実キー割当(§3)と文言を一致させる。
- 各 DndContext に `accessibility={{ announcements, screenReaderInstructions }}` を配線。getLabel は site ごと: 行 = `data` から card を引き question_label ?? title の先頭 40 字(row-menu の `cardLabel` と同形・共有可否は plan 判断)/ tag = categories / options 配列から name。
- instructions 本体は DndContext の hidden 要素として常設だが、行 grip からの `aria-describedby` 参照は attributes 経由 = **dragEnabled 時のみ露出**(§2.4 — locked / pending / 1 枚時に「Space でつかむ」と案内しない)。
- 文言の確定稿は §13-7(仮置きとして本 spec の記述で実装し、OT 裁定で差し替え)。

## 8. footer「+ カードを追加」行(kickoff 決定 8 / D-k / D-l)

### 8.1 DOM / gating

- `<tfoot>` を `<table>` 直下・`MemoizedTableBody` の後に `ExamCardTable` が直接描画(新 file `exam-card-table-add-footer.tsx` の `ExamCardTableAddFooter` が `<tr><td colSpan={visibleColCount}>` を返す)。tfoot 採用の理由: 仮想化 spacer の高さ計算と完全に無関係・memo 凍結の外(resize 中も操作可能)・virtualizer `count` にも `SortableContext.items` にも触れない(kickoff 決定 8 の「非仮想・item に含めない」を構造で満たす)。
- `visibleColCount` は親で `table.getVisibleLeafColumns().length`(TableBody 内の同式と同値・列 visibility 変化に追従)。
- td 内は `sticky left-0` の inline wrapper に button を置く(横スクロール時も左端に残る — pinned 列と同じ CSS 機構・JS なし)。
- button 文言 / スタイルはカードビューと同一(「＋ カードを追加」・dashed border)。
- gating(D-k・OT 修正 1/2)= `!dataReady || positionLocked || movePending` で native `disabled`(footer は純粋な追加ボタンなので native disabled で良い — 既存 row-menu 項目と同 pattern):
  - `dataReady = liveData !== undefined`(`ExamCardTable` から prop で渡す)。**未解決中に `addCard([], 0)` を発行させない** — undefined の間 `data` は `[]` に畳まれており、この一瞬に click が通ると空 baseOrders で先頭採番の card が作られる。理由表示なし(読込中の一瞬)。
  - `positionLocked`: disabled + 理由表示(`title` + button 隣の text-xs 併記)。文言(仮置き・§13-6): `ADD_CARD_LOCKED_REASON = 'ソート/フィルタ適用中はカードを追加できません(解除すると追加できます)'`。理由: フィルタ非合致の新カードは画面に現れず「押したのに何も起きない」に見える(fact-finding §6.2 の無効化案を kickoff が採用)。
  - `movePending`: disabled・理由表示なし(一時状態)。理由: card_move と create は wire が別でも**同じ base_order 空間**を更新する。move 側(`useMoveCards`)は snapshot 読取 → 再採番 assignment 計算 → 書込の途中に並走 create が入ると、その新 card が assignment から漏れて「末尾追加」の不変条件が破れる。
- 追加成功後の auto-edit / auto-scroll はしない(scope 外 §12。新行は footer 直上に現れる)。**0 件の exam でも footer は描画する**が、有効化(enabled)は query が**空配列へ解決した後のみ**(undefined と 0 件を dataReady で区別する — OT 修正 1)。

### 8.2 `useAddCard` 抽出(D-l)

`app/(app)/app/exams/[id]/_hooks/use-add-card.ts`(新設):

```ts
useAddCard({ userId, examId }): {
  addCard(
    baseOrders: number[],          // 対象 exam の全 card の base_order(部分集合禁止)
    count: number,                 // 同・全件数(nextCardTitle 用)
    opts?: { onIdMinted?: (id: string) => void },  // buildEmptyCard 後・最初の await より前に同期発火
  ): Promise<string>               // 新 card id(tx 成立後 resolve)。失敗は rethrow
}
```

- 中身 = `inline-card-list.tsx` の `handleAddCard` から view 非依存部を verbatim 移送。実行順は**現行挙動を保存**(OT 修正 4): `newId()` **同期採番**(Sprint I W5: card id が最初の採番)→ `buildEmptyCard(baseOrders, count)`(option uid の mint は card id より後)→ `onIdMinted` 同期発火 → `runOptimisticCreate({... throwOnError: true})`(最初の await)。`logEvent` は `'card_inline.add.tx_failed'` のまま(同一論理操作・観測の連続性優先)。
- カードビュー側は `onIdMinted` で `setNewCardIds`(auto-edit marker)、catch で inline error — **順序契約(同期採番 → buildEmptyCard → marker 同期発火 → await)を hook 構造で保存**。table 側は `onIdMinted` 不使用・catch で footer 隣に inline error(カードビューと同文言)。
- rule-of-three 未満(実消費 2 site)で抽出する理由: 「id 同期採番が最初」「marker は await 前」という**非自明な順序契約を 2 箇所で手書き再現させる方が、抽象より危険**(fact-finding §6.3)。
- `buildEmptyCard` の呼出契約(`lib/cards/empty-card.ts:22-23`: 基準順**全件**の base_order。フィルタ後・ソート後の部分集合禁止)を hook の JSDoc に転記し、table 呼出側は `data.map((r) => r.card.base_order)` / `data.length` を渡す(`table.getRowModel().rows` **禁止** — kickoff 決定 8)。

## 9. 触る箇所の全列挙

- **dnd 共有**: `lib/dnd/use-sortable-sensors.ts`(option 引数化)/ `lib/dnd/accessibility.ts`(新設)
- **UI**: `exam-card-row-menu.tsx`(trigger grip 化 + 「開く」項目 + `useRowDnd` 消費)/ `exam-card-row-dnd.tsx`(`RowDragHandle` 撤去・`useRowDnd` export・`RowDndValue` 再定義)/ `exam-card-table-columns.tsx`(select cell 再構成・size 112→72)/ `exam-card-table.tsx`(sensors option・accessibility 配線・`showDragHandle`→`dragAvailable` 改名・tfoot 配線)/ `exam-card-table-add-footer.tsx`(新設 — `useAddCard` 消費・inline error は本 component の local state で持ち、table へ lift しない)
- **hook**: `app/(app)/app/exams/[id]/_hooks/use-add-card.ts`(新設)/ `inline-card-list.tsx`(`handleAddCard` を hook 消費に置換 — 挙動不変 refactor)
- **tag 3 site**: `category-list.tsx` / `option-list.tsx` / `card-tag-add-popover.tsx`(accessibility 配線のみ。sensors は無変更)
- **DB / wire / server / sync**: **変更なし**
- **test**: §10

## 10. テスト戦略

jsdom で実 pointer drag / click 抑止は再現不能(行 DnD spec §8-4 と同じ制約)— 実挙動の分岐(§2.3 matrix)は dist 実読(fact-finding §1.2/§3.1)+ stg smoke(§11)が本体で、unit は**配線と構造**を pin する。

1. **sensors option**(`use-sortable-sensors.test.ts` 拡張): 既存 4 assert 不変(default 経路 = tag 3 site の保証継続)+ 新規 pin: `mouseActivationConstraint` 透過 / `keyboardCodes` 透過 / 未指定で両方 undefined。
2. **二役構造**(row-menu / columns test 再構成): grip click → menu open(項目 2 つ・順序)/ locked 中も rows==1 でも menu open / 「開く」click → `openCard(card.id)` 1 回 / 「ここに取り込む」→ picker(既存 test 流用)/ grip click で行選択が変わらない(stopPropagation 継承)。
3. **gating 分離**: **dragEnabled 時のみ** `aria-roledescription="sortable"` + dnd instructions 参照(locked / pending / rows==1 / provider 不在では付かない — §2.4 の判別点)/ locked で `title` = 理由 + `aria-describedby = lockedReasonId` **単独**(参照先 text まで見る既存形式を踏襲・dnd 側 id が同居しないことも pin)/ grip が **native disabled でない**(`toBeEnabled` — 旧 test の disabled 前提 assert は書き換え)/ `useSortable` へ渡る `disabled` に `!dragAvailable` が含まれる。
4. **footer**: click → `addCard` に渡る `baseOrders` が**基準順全件**(スパイで引数 pin — kickoff 決定 8 の契約 pin)/ **deferred test: `liveData` 未解決(useLiveQuery undefined)中は disabled で `addCard` 不発**(OT 修正 1 — `addCard([], 0)` の発行防止)/ `positionLocked` で disabled + 理由 / **`movePending` で disabled**(OT 修正 2)/ `colSpan` = 可視列数 / 0 件(解決済)で enabled 描画。
5. **`useAddCard`**: `onIdMinted` が **`buildEmptyCard` 後・最初の await より前**に同期発火(順序 pin・red 検証必須)/ 返り値 id = mint した id / 失敗 rethrow。`inline-card-list` 既存 test はそのまま green(= 挙動不変 refactor の保証)。
6. **a11y**: `buildJaAnnouncements` unit — label を含み**生 id を含まない**(getLabel miss の総称 fallback 含む)/ sortable data 有無の両分岐。instructions 定数と実 keyboardCodes の対応は文言 pin。
7. **既存 test への影響 inventory**(kickoff 設計点「distance activation 導入後の影響」への回答): `use-sortable-sensors.test.ts` = default 不変で green / `exam-card-table-dnd.test.tsx`(onDragEnd 接続契約 16 件)= handler 不触・DndContext mock 方式のため sensor 変更の影響なし / `exam-card-row-dnd.test.tsx` = `RowDragHandle` 系を新構造へ移行 / `exam-card-table-columns.test.tsx` = select 112→72 fixture・「カードを開く」button 帯(:816-970)を menu 項目 test へ移行・`--col-title-start` 連鎖 / `exam-card-row-menu.test.tsx` = trigger query 変更(⋯ → grip)/ tag 3 site test = sensors default 不変・accessibility 配線で hidden live region の文言が変わるため既存 query との衝突有無を plan で個別確認。
8. **gate**(既存どおり): whole-repo `pnpm lint --max-warnings=0` / `typecheck` / `build`(postbuild 込)/ `test` / `test:iso`(無条件)/ `pnpm run audit` 全 exit 0。依存・Next 設定 file 不触。

## 11. stg smoke(push 後・OT 指示で実走)

### 11.1 実機必須 3 点(kickoff 明記 — emulation では答えが出ない)

| # | 項目 | 期待 |
|---|---|---|
| M1 | distance しきい値の体感 | クリックのつもりで menu が開き(≤4px)、掴むつもりで >4px から素直に掴める(誤ドラッグ / 掴めない、の両方向) |
| M2 | タップと長押しの分離 | タップ = menu / 長押し 250ms = ドラッグが実機 touch で分かれる(行 DnD smoke #8 と統合実施) |
| M3 | ドラッグ後にメニューが誤開しない | drop 直後に menu が開かない(click 抑止の実機実証) |

### 11.2 Playwright MCP 実走分

| # | 項目 | 期待 |
|---|---|---|
| 1 | grip click → menu | 項目 2 つ・「開く」で side-peek 開閉・「ここに取り込む」で picker(回帰) |
| 2 | Enter / Space 分岐 | grip focus → Enter = menu / Space = grab → 矢印 → Space drop(行 DnD #11 の再走・keyboardCodes 変更後)/ ドラッグ中 Enter = drop(menu 開かず) |
| 3 | gating 分離 | ソート中: drag 不発 + **menu は開く** + title = 理由 + describedby = lockedReasonId 単独 + `aria-roledescription` 消滅(行 DnD #4 の期待値を新仕様で再定義: native disabled で**ない**こと)/ 1 枚 exam: grip 表示 + menu 可 + `aria-roledescription` 無し |
| 4 | 同位置系の再定義 | 押下 ≤4px で離す = menu(mutation ゼロ)/ >4px 動かして元位置に戻す = 無音 no-op(outbox 新規行ゼロ・toast なし — 行 DnD #2 の再走) |
| 5 | 並べ替え回帰 | 基本 1 方向 + undo(DB readback — 行 DnD #1/#3 の縮約再走。順序ロジック不触のため全 4 方向は再走しない) |
| 6 | footer | 追加 → DB readback で base_order 末尾式一致・行が footer 直上に出現 / ソート中 disabled + 理由 / 移動実行中(movePending)disabled / 横スクロール時も button 可視(sticky left-0) |
| 7 | 低コントラスト | 通常 50% → 行 hover / focus で通常色 / 選択済み ☐ 常時通常色(touch emulation では 50% 常時表示のままであること) |
| 8 | a11y 配線 | grip の describedby 参照先が日本語 instructions / drag 中 live region が日本語 + 生 id 不在(tag site 1 箇所も抜き取り確認) |
| 9 | 回帰 | console error 0 / tag D&D 3 site 従来どおり(sensors default 不変)/ カードビュー「+ カードを追加」auto-edit 従来どおり(useAddCard 移行の実機確認) |

**FAIL の扱い**: 全項目(M1〜M3 含む)FAIL = **prod blocker**。行 DnD sprint の未実施分(touch #8 = M2 に統合)と合わせて all-pass を確認してから、**行 DnD + Row-UX をまとめて prod 反映**(OT 判断)。M1 の FAIL が distance 値調整(4〜6 帯内)で解消するなら spec 変更なしで再 smoke、帯外が必要なら停止 → OT。

## 12. scope 外(明記)+ hover 出現 NO-GO 記録 + 残余リスク

**scope 外**:

- 「この行の下にカードを追加」(次 sprint — footer 末尾追加のみ)。
- table 追加後の auto-edit / auto-scroll(必要が実証されたら別 task)。
- keyboard drop 後の focus 復帰(body 落ち — 行 DnD session §5.6-A・既起票 follow-up のまま)。
- `aria-roledescription` の日本語化(既存 pin "sortable" を維持。instructions / announcements と別レイヤー)。
- row-menu **項目**(「ここに取り込む」)の native disabled 到達性(行 DnD session §7-2 の残り半分。grip 側は本 sprint の native disabled 廃止で解消するが、menu 項目側は既存 pattern 維持)。

**hover 出現の NO-GO 記録(kickoff 決定 2 の指示による恒久記録)**:

- **裁定**: hover 出現(通常時 `opacity-0` → hover で出現)は Codex 裁定で **NO-GO**(2026-08-15・claude.ai 側。結論は kickoff 決定 2 に集約)。
- **理由**: ① Tailwind v4 は `hover:` / `group-hover:` を `@media (hover: hover)` で包む(生成 CSS 実読 — fact-finding §4.2)ため、基底 `opacity-0` はタッチ端末で**永久不可視**になる。② 本 repo はこの欠陥を一度踏んで撤去済(iPad 横向き = md 以上かつ hover 無しで「開く」不可視 — `exam-card-table-columns.tsx:111-113` の現物コメント)。再導入は同じ穴の掘り直し。③ 安全化には `pointer-coarse:` 等の**端末能力判定への依存**が必須になり、「DOM / hit area / レイアウトは全環境同一」の設計原則(kickoff 決定 2)に反する。
- **Codex 妥協案(不採用・記録のみ)**: `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100`(hit-test は残す)— fact-finding §4.4 の最小安全形。
- **再訪条件**(全て満たす場合のみ再検討): ① 常時表示 + 低コントラストが実運用で視覚ノイズとして具体的に問題化する ② `pointer-coarse:` / `any-hover` 系 variant の使用前例と実機(iPad)検証手順が repo に確立している ③ 再訪時も escape hatch(タッチで常時表示)+ `group-focus-within` のキーボード経路を必須要件とし、iPad 実機 smoke を prod blocker に含める。

**残余リスク(受容・記録)**:

- Radix trigger と dnd listeners の同居、および drag 後 click 抑止は dist 実読 + smoke 担保(jsdom で実証不能)。menu open 中に同じ grip からドラッグを開始した場合 menu が開いたまま drag になる縁ケースは既知・受容(smoke #1 で観察のみ・実害があれば別 task)。
- distance 4 / 低コントラスト 50% は実機体感まで仮説(いずれも kickoff 承認帯内の調整は spec 変更にあたらない — §3 / §6)。
- 行 DnD spec §10 の残余リスク(Grid-3 継承 2 件)は不変・本 sprint は書込経路に触れないため悪化させない。

## 13. OT 確認点(spec が新たに確定した判断 — **2026-08-15 承認済**。修正 4 点は冒頭「状態」に記録・本文へ反映済)

1. **D-a/D-b**: 二役 = 1 button 兼用、統合の置き場 = `ExamCardRowMenu` の trigger grip 化(`RowDragHandle` 撤去・`useRowDnd()` 新設)— §2。
2. **D-c/D-d**: dnd attributes は **dragEnabled 時のみ** spread / `aria-disabled` 常時 override / native disabled 廃止 / locked 提示 = title + describedby = lockedReasonId 単独 — §2.4/§4。locked / rows<2 時は **Space も menu に落ちる**(native 挙動を抑止しない)ことを含めて承認済 — §2.3。
3. **D-e/D-f**: sensors option 化(2 key のみ)・distance **4**(≤4px click / >4px drag)・keyboardCodes(Enter は end に残す)— §3。
4. **D-i/D-j**: select 列幅 **72** / 低コントラストの基準値(grip 50% / checkbox opacity-50・`checked:` で常時通常)— §6。
5. **D-k/D-l/文言**: footer = tfoot + 新 file / gating = `!dataReady || positionLocked || movePending` / `useAddCard` 抽出(rule-of-three 未満の理由付き・順序 = mint → buildEmptyCard → onIdMinted → await)/ `ADD_CARD_LOCKED_REASON` 仮置き文言 — §8。
6. **aria-label 仮置き**: grip「行の操作: {title}」(旧「行を並べ替え: {title}」から変更)— §2.4。
7. **SR 文言仮置き**: instructions 2 本 + announcements の日本語文言(§7。確定稿は plan までに裁定)。
8. **smoke の再走範囲**: 行 DnD smoke の再走は影響項目のみに縮約(#1/#2/#3/#4/#11 相当を §11.2 で再定義。順序ロジック・auto-scroll・1200 枚・sticky は不触のため全再走しない)— §11。
9. **prod 反映の束ね**: 行 DnD(touch #8 = M2 統合)+ Row-UX の all-pass を確認してからまとめて prod 反映 — §11。
