# Edit-2: テーブルで全項目 inline 編集 + 列の表示/非表示

- 作成: 2026-06-26
- シリーズ: 編集ビュー再構築 Edit-2(本命・完結スプリント。旧 Edit-3「列表示/非表示」を吸収)
- 種別: spec(design record)。plan は本 spec review 後。
- 前提: Edit-1 + Fix-1 は prod 反映済。Edit-2 fact-finding 報告を起点。本 spec は実装せず。

---

## 1. 目的 / ゴール

試験詳細テーブルビューで、**カードビューでできる編集を全てできるようにする(編集パリティ)+ 列の表示/非表示**を付ける。Edit シリーズの完結。

- 選択肢(options)を table 上で inline 編集可能に(現状 Edit-1 で read-only に逃がした唯一の重い項目)。
- 問題文(question_text)を editable に(Edit-1 open Q1 の解消)。
- title / sort_key / 解説 / メモ は Edit-1 で既に editable = そのまま。
- 列の表示/非表示(TanStack columnVisibility)+ 保存。
- → カードビューの全編集項目が table 上で完結。

---

## 2. 全体ルール / 制約

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① 該当 unit/component test green ② review Critical 0 ③ `[reviewed]`(feat は canonical `superpowers:requesting-code-review` 経路必須・template 改変なし)。
- **カードビュー(InlineCardList / InlineOptionList consumer)は挙動不変**。`CardTagAddPopover` 等タグ系は本 sprint 非該当。
- **書込経路を新設しない**: 選択肢 commit は既存 `runOptimisticUpdate`(`cards.update(cardId, {options, correct_answer_ids})` + enqueue `update_field/options`、single-store、Fix-1 と同じ atomic tx 規律が helper 内蔵)。問題文/text 系も `InlineTextField` 内部の `runOptimisticUpdate` 流用。**新規 atomicity 作業なし**(working-set は UI state で write-path ではない)。
- **追加 join 禁止**: 列データは `row.original.card` から(options/question_text は ClientCard に有り)。
- 全 read は `user_id` scope を維持。
- **共有部品(`inline-option-row.tsx` の `InlineOptionList`)変更のため consumer test 網羅必須**(横断規律: shared-component 変更で consumer test も per-task gate 実行)。
- Test: Vitest + RTL(+ fake-indexeddb は該当時)。AI/課金は非該当。`--no-verify` 全面禁止。

---

## 3. 確定した設計判断(OT 確定 + Step 0)

### 3.1 OT 確定
1. **1 sprint(4 task)で進める。ただし T1(`useCardOptions` 抽出)を最初に隔離**し、**T1 完了時点で per-task stop → push → カードビュー挙動不変の実機 smoke を確定してから次 task**(prod 編集器に触る本 task だけ**中間 smoke を例外的に**入れる。理由: ここが壊れると後続 task が汚染された土台に乗るため切り分けを先に済ませる)。通常 smoke は sprint 末まとめ。
2. **編集パリティ**: 選択肢(新規 compact editable cell)+ 問題文(`InlineTextField multiline` 差し替え)を editable 化。
3. **解説(explanation)の見せ方 = 常時表示**(各選択肢 text 直下に常に表示・編集可。トグルにしない)。
4. **問題文 clamp 消失は意図的選択**: editable text 列は全て非 clamp(全文表示・行高可変)で一貫。問題文 `line-clamp-2` → 全文表示で行高が伸びる。俯瞰時の行高ばらつきは列表示/非表示 + 将来の row height 設定で吸収。
5. **列の表示/非表示**(旧 Edit-3 吸収): TanStack `columnVisibility` 導入、ユーザー切替 UI、保存先 = `examViewPrefs`(sync_meta JSON + zod、schema 拡張要)。

### 3.2 Step 0 実コード確認結果
- **T1 回帰 gate は既存テストが網羅**: `inline-option-row.test.tsx`(703 行: 表示 / cell edit→mirror+enqueue / checkbox toggle / **add・delete・ghost** / auto-resize)+ `inline-option-row.debounce.test.tsx`(248 行: **500ms drain / coalesce / dirty-guard・merge reconciliation / ghost-preserving merge**)= 計 **951 行**が `InlineOptionList`(= hook consumer)を通して working-set/ghost/debounce/autoEdit/merge を固定。→ **`useCardOptions` 抽出後もこの 951 行 + `inline-card-list.test.tsx`(統合)が全 green が T1 の hard gate**(byte 同一証明は効かないが、この網羅 suite が実質不変の証明)。
- **TanStack `columnVisibility`/`columnPinning` は現状未使用**: 列の sticky-left pin は **CSS(`meta.sticky` → render が `sticky left-0` 付与)**で TanStack pinning ではない。→ columnVisibility は net-new。title 列を hidden にすると render の `getVisibleCells()` から外れ cell が描画されないだけ(TanStack pinning との相互作用なし)。
- **`InlineOptionCell` / `InlineOptionRow` は un-export**(`InlineOptionList` のみ export)。→ T2 で `InlineOptionCell` を再利用するには **export 追加(または共有 file へ移動)**が要る。

---

## 4. スコープ

### 4.1 IN
- **T1**: `inline-option-row.tsx` から `useCardOptions(cardId, serverOptions)` を抽出(state: options working-set / autoEditOptionId、refs: serverCommittedRef / debounceTimerRef / optionsRef、merge useEffect、commit + scheduleDrain、handlers: handleCellSave / handleCheckboxToggle / handleAddOption / handleDeleteOption、canDelete / correctIds)。`InlineOptionList` を hook consumer 化(card-view 挙動不変)。`InlineOptionCell` を export(T2 再利用のため)。
- **T2**: 新規 **compact editable options cell**(table cell 用)。1 セル内に選択肢行を**縦積み**、各行 = `is_correct` checkbox + text(click-to-edit)+ explanation(**常時表示・下に編集可**)+ 削除 + 末尾「+ 選択肢を追加」。`useCardOptions`(T1)+ `InlineOptionCell`(primitive 再利用)で構成。`InlineOptionRow` の 4/5列 grid は使わない(table cell 非適合)。working-set は **cell ローカル(card 単位)state**。
- **T3**: `exam-card-table-columns.tsx` で options 列の `OptionsReadonlyCell` → T2 の editable cell に差し替え。問題文列を editable 化(`<div line-clamp-2>` → `<InlineTextField multiline field="question_text" initialValue={card.question_text} ariaLabel="問題文 編集" />`)。問題文の `sortingFn: sortLikeServer`(header 連番ソート)は維持(header onClick=sort / cell=編集、非干渉)。
- **T4**: TanStack `columnVisibility` 導入(`useReactTable` state + UI トグル)+ 列表示/非表示 UI(表示プロパティ的)+ `examViewPrefs` schema 拡張(列表示集合の保存)。

### 4.2 OUT
- side peek(Edit-4)/ T6 sticky header(別 sprint defer 済)/ 画像系。
- filter-bar の option-create no-op(Fix-1 carry-forward = 別 sprint の selectOnly 抑制)。
- カードビューの選択肢編集器の機能変更(挙動不変、抽出のみ)。
- 行高(row height)設定機能(将来。本 sprint は clamp 消失を列表示/非表示で吸収)。

---

## 5. アーキテクチャ / データフロー

```
useCardOptions(cardId, serverOptions)  ← T1 抽出 (state/refs/merge/commit/handlers)
   └─ commit: runOptimisticUpdate(cards, cardId, {options, correct_answer_ids}, enqueue update_field/options, skipInternalFlush + scheduleDrain)
   ├─ [card view]  InlineOptionList → InlineOptionRow(4/5列 grid)        ← 既存・挙動不変
   └─ [table cell] CompactOptionsCell → 縦積み row + InlineOptionCell    ← T2 新規 (同 hook 共有)

table columns (T3): options 列 = CompactOptionsCell(card.id, card.options) / question 列 = InlineTextField multiline
table (T4): useReactTable({ state: { columnVisibility, ... }, onColumnVisibilityChange }) + 列トグル UI + examViewPrefs 永続化
```

- 選択肢 write path = `runOptimisticUpdate`(single cards 行・whole options 配列)。**`runOptimisticMutation`(multi-store, card-tags 用)ではない**。atomicity は helper 内蔵(mirror update + enqueue 1 tx、throw で auto-rollback)。
- working-set(編集中の複数選択肢 + ghost + autoEdit)は **UI state**。card view と table cell は **同じ hook を別レイアウトで** 使う(state は各 cell ローカル = card 単位)。

---

## 6. テスト方針

- **T1 `useCardOptions`**: hook unit(state/handlers/commit の最小)+ **card-view 回帰 hard gate = 既存 951 行**(`inline-option-row.test.tsx` + `inline-option-row.debounce.test.tsx`)+ `inline-card-list.test.tsx` 全 green(ghost / 連続追加 race / serverOptions merge / 500ms drain / autoEdit が抽出前後不変)。+ **中間 stg smoke**(カードビューの選択肢編集: text/explanation/id 編集・checkbox toggle・追加・削除・正解サマリ・debounce 反映)。
- **T2 CompactOptionsCell**: component(縦積み描画 / is_correct toggle / text・explanation click-to-edit / 追加・削除 / 空 options / 240px 幅内レイアウト)。`InlineOptionCell` 再利用の回帰。
- **T3**: columns test(options 列が CompactOptionsCell / question 列が InlineTextField multiline・clamp 撤去・sortingFn 維持)。`exam-card-table.test.tsx` で問題文 cell の編集化 + 既存 green。
- **T4 columnVisibility**: 列トグルで `getIsVisible()` 反映・hidden 列が描画されない / examViewPrefs 永続化(schema v2 read/write、不正値 fallback)/ リロード復元。
- 共有部品変更の consumer 網羅(T1）: 上記 951 行 + inline-card-list を per-task gate で実行。

---

## 7. 設計判断点(spec で推奨、実装着手前に OT 確定)

1. **columnVisibility 保存 schema**: `examViewPrefs`(現 `{version:1, view}` strict)を **version 2 に上げる**か field 追加か。列表示集合の持ち方(表示する列 id 集合 / 非表示集合 / 列ごと boolean map)。**新列追加時の default 表示/非表示**の扱い(保存済 prefs に無い列 id は default 表示、を推奨)。**推奨**: version 2 で `hiddenColumns: string[]`(非表示集合を持つ=保存に無い新列は既定表示で前方互換)。
2. **表示/非表示の対象列**: **title(pin)を非表示可能にするか**(pin 列を消すと横スクロール時の左固定がなくなる)。**select 列は対象外**で良いか。default の初期表示セット(全列表示 or 一部既定非表示)。**推奨**: select は常時表示(対象外)、title は非表示**可**(消すと pin が無くなる旨は許容)、初期は全列表示。
3. **compact cell の選択肢多数(20択等)時の行高**: 常時表示 explanation で 1 セルが極端に縦長化。**仮想化は本 sprint 不要**か(carry-forward: 数百件で仮想化不要を実証済だが、行が重くなるため再観測候補と記録あり)。**推奨**: 仮想化は入れず、本 sprint の stg smoke(desktop/mobile)で重い card(多択 + explanation)の体感を実測し記録。重ければ別 sprint で row height/仮想化。

---

## 8. 完了条件

- 選択肢が table 上で inline 編集できる(text / explanation / is_correct toggle / 追加 / 削除)= カードビューと編集パリティ。commit は `runOptimisticUpdate`(mirror + outbox、Fix-1 と同 atomic 規律)。
- 問題文が table 上で editable(InlineTextField multiline、clamp 撤去・全文表示、header 連番ソート維持)。
- 列の表示/非表示が切替でき、`examViewPrefs`(schema v2)に永続化・リロード復元。
- **カードビュー(InlineOptionList / InlineCardList)挙動不変**(951 行 + 統合 test green + 中間 smoke pass)。
- 該当 unit/component test green。canonical review Critical 0、commit に `[reviewed]`。
- whole-repo `pnpm lint --max-warnings=0` exit 0。

---

## 9. 検証スコープ

- canonical code review(`superpowers:requesting-code-review` 経路、観点に whole-repo lint 実行確認)。
- **T1 中間 stg smoke**(例外): T1 push 後、カードビュー選択肢編集の挙動不変を DevTools MCP で実走(編集パリティの土台確定)。
- **sprint 末 stg smoke**(T2–T4 まとめ): table での選択肢 inline 編集(text/explanation/toggle/追加/削除 → mirror 反映)/ 問題文編集 / 列表示非表示トグル + リロード永続化 / 多択 card の compact cell 体感(行高観測)/ カードビュー無改変再確認。
- DB 変更なし(options は cards.options jsonb、card_tags 等の新 migration なし)= migration 不要。examViewPrefs は sync_meta の client-only JSON(server schema 非該当)。
- whole-repo lint exit 0 を完了報告に 1 行明記。
