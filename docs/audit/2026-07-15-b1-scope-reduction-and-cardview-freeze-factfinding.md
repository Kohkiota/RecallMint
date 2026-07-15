# B1 縮小スコープ再定義 + カードビュー freeze bug fact-finding

- **日付**: 2026-07-15
- **調査 HEAD**: `develop` `5f8698d`
- **性質**: **read-only 調査のみ**。実装 / 修正 / commit(本 doc の記録 commit を除く)は一切なし。
- **背景**: 前回 fact-finding(`docs/audit/2026-07-14-b1-richtext-tiptap-factfinding.md`)の「Tiptap リッチテキスト + 本文 JSON + 変換層」前提は業界調査 + GPT cross-check を経て **破棄**。新方向 = ①本文途中への画像挿入は諦め、画像は **欄(field)単位添付**(問題文/選択肢/解説/メモ)②表は **MD 記号のまま保存・表示時だけ read-only できれいに描画**(表エディタは作らない・保存形式不変)。加えて実害バグ 1 件(カードビュー freeze)を triage。
- **規律遵守**: 全て現 HEAD 実コードで裏取り(file:line 明示)。記憶・過去 doc・前回 fact-finding の記述は事実扱いせず再スキャン。carry item も現物再検証。不明は「不明」明記。
- **前回 doc との関係**: 前回 doc は supersede せず「前提破棄」注記を追記済(冒頭)。生きている事実 = 編集面 A / seam C / 保存 format B の**現物事実部分**(本 doc で現 HEAD 再検証して引用)。破棄 = Tiptap/変換層/技術スパイク/案 X-Y 論点/clobber gap(本文 JSON を入れない以上発生しない)。
- **調査方法**: item 1(freeze)は CC 本体が systematic-debugging Phase 1(root-cause・全書込経路の data-flow trace)を実施。item 2/3 は並列 read-only subagent 2 体。

---

## 1. カードビュー freeze bug(最優先・実害)

### 1-0. 結論(先出し)

**原因 = 枚数/レイアウト(未仮想化 O(N) 再レンダー)であり、無限ループではない。** カードビューの全書込経路を静的 trace し、**render / effect が Dexie へ書き戻す経路は存在しない**ことを確認(= brief が問うた「commit→liveQuery→再 commit ループ」は現コードに不在)。編集離脱(blur→commit)1 回で単一 `useLiveQuery` が再発火し、**全 card の重い subtree を同期再レンダー + reconcile + layout** する。N=300 + 多択の高い行で main thread が数秒ブロック → 応答不能/落ちる。

### 1-1. カードビューは未仮想化・全 card が重い subtree

- `inline-card-list.tsx:268-319`:`<ul>` が `cards.map((card) => <li key={card.id}><Card><CardEditorFields .../></Card></li>)`。**仮想化なし**(全 card を一括 mount)。
- `CardEditorFields`(`card-editor-fields.tsx:44-121`)= **純表示**(独自 useLiveQuery なし・Dexie 書込なし・effect なし)、かつ **React.memo 非適用**(素の関数 component)。1 card あたり:問題文 `InlineTextField`(:74-82)+ 画像 gallery(:85)+ 選択肢 `InlineOptionList`(:91)+ 解説 `InlineTextField`(:96-104)+ メモ `InlineTextField`(:109-117)+ タグ `CardTagsSection`(:63-69)。
- 行高肥大(carry item 再検証・確定):`inline-option-row.tsx` は各 option 行に id(:169)+ text(:179)+ **explanation を常時 instance 化**(:194 `value={option.explanation ?? ''}`)。20 択 card は縦に非常に高い(explanation 常時表示 + 選択肢数分)。**未仮想化 × 高い行 = 巨大 document + 高コスト layout/reflow**。

### 1-2. 単一 useLiveQuery が全 card を新 identity で返す

- `inline-card-list.tsx:93-119`:`useLiveQuery` が `db.cards.where('exam_id').equals(examId)` + tag 3 store を購読。**cards への任意の Dexie 書込で再発火**。
- 返り値は毎 tick 新 object:`cards = filteredCards.map(toExamDetailCard)`(:103)は **全 card の新 object を生成**(`toExamDetailCard` :52-63)。`options` = `c.options`(IDB deserialize 毎回新 array)、`images` = `c.images`(同)、`tagsByCardId`(:139)は **useMemo 非適用の新 Map 毎 render**。
- ∴ `CardEditorFields` に渡る prop ref は毎 tick 全て新規 → **React.memo を仮に足しても全 card で無効化**(props 参照が変わる)。categories/options のみ useMemo 安定化(:128-135)だが card 本体・cardTags は不安定。

### 1-3. 編集離脱経路とそれぞれが撃つ commit

| 離脱 | 実配線 | 撃つ commit |
|---|---|---|
| blur(他所 click / Tab)| `InlineTextField.handleBlur`(`inline-text-field.tsx:242-254`)| dirty なら `commit`(:253)→ Dexie 書込。option は `InlineOptionCell` blur → `onSave` → `useCardOptions.commit`(`use-card-options.ts:160-`)|
| outside click | 同上(input から focus 外れ = onBlur)| 同上 |
| Escape | `onKeyDown`(`inline-text-field.tsx:234-240`)は **Enter/Space で編集開始のみ**。Escape ハンドラ無し | **編集を抜けない**(textarea default も Escape で blur しない)= **不明/未対応**(離脱経路として機能しない)|
| scroll による unmount | 未仮想化ゆえ `<li key={card.id}>` は **unmount しない**(reorder は move のみ)| **今日は発火しない**(仮想化後に発火する = 1-5)|

→ freeze は主に **blur/outside-click の commit** が起点。commit(`inline-text-field.tsx:183-211`)= `runOptimisticUpdate` で mirror 書込 + outbox enqueue(Dexie 書込)→ useLiveQuery 再発火 → 全 N card 再レンダー。

### 1-4. ループ不在の確証(全書込経路 trace)

**カードビュー subtree 内で Dexie へ書く経路はすべて user 操作 gated。render/effect からの書き戻しはゼロ**:

- `InlineTextField.commit`:blur(:253)/ commit-on-unmount(:152-160、`editing && v!==is` かつ card 存在時のみ)。**dirty-guard(:129-135)は値比較**(`initialString !== lastSyncedInitialValue`)→ 同一内容の再降下では setState しない = **tick ループを起こさない**。
- `use-card-options.ts` の merge effect(:114-126、deps `[serverOptions]`):`serverOptions`(= options prop)が毎 tick 新 ref のため**毎 tick 再走**するが、中身は `setOptions(merged)` = **local working-set state のみ更新・Dexie 書込なし**。→ liveQuery を再発火させない = **無限ループにならない**(per-tick の local 再レンダーコストには寄与)。`runOptimisticUpdate`(:195)は `commit`(user 操作)内のみ。
- `CardImageGallery`:Dexie 書込は `handleFileChange`→attach(`card-image-gallery.tsx:170-185`)/ `handleDelete`→remove(:187-199)= **user 操作のみ**。`CardImageThumbnail` の 2 effect(:67-75 URL 解決 / :77-90 dims 読取)は **read-only** かつ deps が `image.key`(**string・毎 tick 安定**)ゆえ per-tick 再走しない。retry の setState は **effect 本体でなく click handler**(:108-109 明示コメント「effect 本体からの同期 setState は cascading render を招く」)。
- `CardEditorFields` / `CardTagsSection`:前者は純表示。タグ側も user 操作で書込。

→ **render も effect も Dexie を書かない** ⇒ 自己持続ループの成立条件が欠如。**ループ仮説は棄却**(静的に確定)。

### 1-5. 判定・予測・repro 可否

- **判定**:1 commit あたり O(N) の同期再レンダー + reconcile + layout。N=300 + 多択の高い行 = 定数係数が大きく main thread 数秒ブロック → 応答不能/OOM 落ち。**ループ(N 非依存で必ず固まる)ではなく枚数(大 N のみ)**。
- **予測**:20〜30 件では同操作でも 20〜30 subtree の再レンダーのみ → 高速・**固まらない**はず。**freeze は大 N 限定 ⇒ 枚数/レイアウト**で整合。
- **repro 可否判断(CC)**:`seed-perf-exam.ts` は **server Postgres へ seed**(`getDb`/drizzle、user-id 指定で 300 card INSERT。`scripts/seed-perf-exam.ts:84-92,326`)。カードビューは **Dexie mirror 読み**ゆえ、live repro は「seed → app 起動 → Clerk auth → pull で Dexie へ → カードビュー → DevTools 計測」の full smoke が必要、かつ **freeze 自体が browser automation を hang** させる。静的 trace が **書き戻しループの不在を確定**している(brief が問うた機構がコードに無い)ため、**read-only fact-finding では live browser repro のコスト/リスクに見合わない**と判断。経験的確認が要るなら **小(20-30)vs 大(300)の比較**が決定実験(CC 予測 = 小は固まらない)。

### 1-6. carry item 現 HEAD 再検証

- **InlineOptionCell の commit-on-unmount 欠如**:**確定**(true)。commit-on-unmount を持つのは `InlineTextField`(:142-164)のみ。option 側 `use-card-options.ts:134-141` の unmount cleanup は **timer clear のみ・commit しない**。→ 未仮想化の今は cell が unmount しないので freeze の原因ではないが、**仮想化の前提条件**(scroll-out 中の option 編集中値が失われる)。
- **E2E#3(scroll 起因 unmount commit)**:`InlineTextField` は commit-on-unmount を**持つ**(設計通り)。未仮想化の今は scroll-unmount が起きないので N/A。**仮想化で発火開始**(1-5 の理由で designed だが 1-7 #1 と相互作用)。
- **多択行高肥大(20 択 ≈ 4531px・explanation 常時表示)**:**確定**(explanation 常時 instance 化 `inline-option-row.tsx:194`)。枚数仮説の **layout コスト増幅要因**。

### 1-7. T2 仮想化資産のカードビュー移植難度

- **scroll モデル差(要注意)**:テーブルは **element-based `useVirtualizer` + 内部 scroll container**(`exam-card-table.tsx:54,132-134` `getScrollElement:()=>scrollElementRef.current`、container=`tableContainerRef`)。カードビューは **page flow の `<ul>`(window スクロール・内部 container なし)**。→ 移植は **`useWindowVirtualizer`(window ベース)** が要る(brief が名指しした通り)か、リストを内部 scroll container で包む。
- **移植可能な資産**:`getItemKey=card.id`(カードビューは既に安定 `<li key={card.id}>`)/ `measureElement` 動的行高(高く可変な行に必須)/ spacer offset。
- **カードビュー固有の阻害要因(具体 2 件)**:
  1. **`newCardIds`(autoEditOnMount Set)に consume 経路が無く、正しさが「cell が unmount/remount しない」ことに明示依存**(`inline-card-list.tsx:162-179` コメント:仮想化で remount → `autoEditOnMount=true` 再突入 → **誤 auto-edit**)。仮想化には **consume 経路の追加が必須**。
  2. **InlineOptionCell の commit-on-unmount 欠如**(1-6):仮想化 scroll-out 中の option 編集値が失われる → 仮想化前に付与が要る。
  - `InlineTextField` の commit-on-unmount(既存)は scroll-out で発火開始(designed/OK)だが #1 と相互作用。
- **難度 = 中**(自明ではない:2 前提 + window-virtualizer)。ただし **ループ不在**ゆえ仮想化は正当な fix(ループを隠蔽しない)。

---

## 2. 画像が「どの欄に付いているか」の識別可否

### 2-1. データモデル上は欄を持つ(target)

- `CardImage`(`schema.ts:52-58`)= `{ key, target, alt, source_ref?, url? }`。**`target` が欄指標**(専用 field 列は無く欄情報は target 文字列に符号化)。client mirror 型 `ClientCardImage`(`client-db.ts:62-68`)同形。
- asset 参照 vs legacy OCR 判別:`isAssetKey`(`validation/card.ts:88-90`、UUIDv4 厳密)。UUIDv4=asset 参照、非 UUID=legacy OCR memo(key 命名 `q{sort_key}-img-{連番}` `ocr-extract.ts:131-133`)。
- `imageEntrySchema`(`validation/card.ts:94-117`):target は型上無制約(`:97`)、refine(`:106-117`)で **UUID-key entry のみ** `target === 'question_text' || /^option:.+/` を強制、legacy は passthrough(`:109 return true`)。

### 2-2. card_asset_refs.field_key の実書込値 = target verbatim・実質 'question_text' 固定

- schema:`fieldKey = text('field_key').notNull()`(`schema.ts:867`)、PK `[cardId, fieldKey, ordinal]`(`:871`)。
- 書込は **`handleImages` 単一点**:`fieldKey: entry.target`(`card-field-handlers.ts:220` **verbatim**)、ordinal=同 target 内 0-based(`:210-215`)、legacy は skip(`:213 continue`)。
- UUID-key entry を **生成する経路は attach saga 1 本のみ**(`upload.ts:682-686` `{ key: assetId, target, alt: '' }`、target は gallery prop を stamp)。OCR は非 UUID key(refs に入らない)。
- gallery 全 instance は **target='question_text' のみ**(2-3)。→ **今日の field_key は実質 'question_text' 固定**。コードは `'option:<id>'` も **サポート済**(validation+handler+`backfill-card-asset-refs.ts:168`)だが **生成 UI が無い**。

### 2-3. 添付 UI(「画像を追加」)配線

- `CardImageGallery`(`card-image-gallery.tsx:151-157`)= **target prop 単位** gallery(`targetImages` filter `:168` = UUID かつ target 一致のみ描画)。affordance = 「画像を追加」button(:217-223)+ hidden input(:224-230)。
- **全 instance(2 箇所)**:① `card-editor-fields.tsx:85` **target="question_text"**(編集面。:83-84 に「per-option gallery は deferred・scope 外」)② `session-runner.tsx:436-442` **target="question_text"** + readOnly(学習面)。→ **渡る target は 'question_text' のみ**。
- add:`handleFileChange` → `attachImageToCard({...,target,...})`(`upload.ts:529`)→ `nextImages` append(prop target stamp `:682-686`)→ `commitImages`(`:488-511`)が `update_field field:'images'` enqueue。remove:`removeImageFromCard`(`upload.ts:838-851`)は **key 一致 filter**(`:845`)= **target 非依存**。

### 2-4. 4 欄化の必要変更(規模 = 小)

| 欄 | target 値 | validation 許容済 | 追加要否 |
|---|---|---|---|
| 問題文 | `'question_text'` | ✓(`card.ts:110`)| gallery 既存 |
| 選択肢 | `'option:<id>'` | **✓ 既に許容**(`/^option:.+/`)| **validation 変更不要**・option ごとに gallery 増設 |
| 解説 | `'explanation_text'`(等)| **✗ 未許容** | **imageEntrySchema target widen 必須**(`card.ts:110` に OR 追加)|
| メモ | `'memo'`(等)| **✗ 未許容** | **同上 widen 必須** |

- **options が配列要素の件**:target は **index でなく option の id**(`option:<optionId>`)。refs の ordinal は「同 field_key(=同 option)内 0-based」(`card-field-handlers.ts:214`)で配列 index 無関係に自動採番 → **配列特別扱い不要**。
- **cards.images 形状 / handleImages / card_asset_refs / GC / discovery は新 field 情報の追加不要**(target verbatim で流れ、GC・discovery は field 非依存 = 2-5)。
- 主変更 = **①validation の target widen(解説/メモ用・1 行)②editor/study 面で gallery を target 違いに増設**。変更 file = `validation/card.ts:110` / `card-editor-fields.tsx` / `session-runner.tsx`。handler/refs/GC/backfill **不変**。
- **不明**:解説/メモ の target 命名を field 名一致(`'explanation_text'`/`'memo'`)にするか OCR 語彙(`'explanation'`)に寄せるかは未定 = 設計判断(現コードに該当定数なし)。OCR legacy 語彙は `'question'`/`'option_{id}'`/`'explanation'`(`ocr-extract.ts:125-128`)で asset 経路(`'question_text'`/`'option:<id>'`)と**別語彙**(legacy は非 UUID・非描画ゆえ現状破綻せず)。

### 2-5. asset discovery(media transfer / prefetch / deck DL)の読取元

**全経路が `cards.images`(key)を読み、`card_asset_refs` は読まない・全て field 非対応(target 無視)**:
- deck DL:`deck-download.ts:126-131`(images 走査 → isAssetKey key 集約 → `resolveAssetUrls` :167)。
- startup sweep:`sweep.ts:76-78`(c.images を key 線形探索)。
- reclaim(画像外し / card 削除掃除):`reclaim-local-asset-blobs.ts` は assetIds 引数受領のみ、収集側 = `delete-card-button.tsx:49-50` / `use-bulk-card-delete.ts:79-81`(`card.images.filter(isAssetKey).map(i=>i.key)`)/ `card-image-gallery.tsx:198`。
- 単票解決:`get-asset.ts:65`(assetId 単体)。
- `card_asset_refs` の consumer は **GC(`gc-image-assets.ts:97-113` の NOT EXISTS 参照存在のみ・field 非依存)+ backfill(計数)+ user 削除 cascade コメント**のみ。**field_key を意味消費する consumer は現状ゼロ**。

---

## 3. 表(MD テーブル)の実態

### 3-1. OCR プロンプトが MD 表を吐く箇所 + 適用欄

- 指示は `STRUCTURE_PRESERVATION_RULES`(`ocr-extract.ts:37-42`):`表データ → Markdown 表形式:` + 例 `| 項目 | 値 |` / `|---|---|`。要素少なく自然文で読める場合は自然文可(:42)。
- **適用先(例外なし)**(`ocr-extract.ts:23-28`):`question_text`(:24)/ `options[].text`(:25)/ `options[].explanation`(:26)/ `explanation_text`(:27)/ shared_context(:28、別 field でなく `question_text` 冒頭に `> ` quote で prepend `:55-56,85-91`)。field spec も `question_text: Markdown 可`(:223)/ `options[].text: Markdown 可`(:230)。
- OCR schema(`ocr-response.ts`):`ExtractedCard`(:28-37)= title/sort_key/question_text/options[]/correct_answer_ids/explanation_text/images/custom_props。`memo` は **OCR field に不在**。
- → **MD 表が入りうる欄 = `question_text` / `option.text` / `option.explanation` / `explanation_text`**。`memo` は OCR 非対象(user 手入力時のみ)。

### 3-2. 現保存形式 = plain string・書込時変換なし

- 列:`question_text` text(`schema.ts:310`)/ `options` jsonb(`CardOption.text: string` :46-51)/ `explanation_text` text(:313)/ `memo` text(:315)。
- validation(`validation/card.ts:50-63`,14-27)は bare `z.string().max()`/`.refine(非空)`のみ・**`.transform()` なし**。
- 書込 handler(`card-field-handlers.ts`):question は verbatim(:127-131)、explanation/memo は `''→null` 正規化のみ(:133-145)、options は `text: o.text` verbatim(:154)。
- → **書込時変換は nullable 列の '' → null のみ。MD 本文は byte-for-byte 保存・保存形式不変**。repo 全体で `dangerouslySetInnerHTML` **0 件**、描画は直接 `{value}` 補間。

### 3-3. 各表示面の描画経路

編集 page は **2 共有 component の `editing` flag** に集約、display 枝は `whitespace-pre-wrap break-words`:
- **(A)** `InlineTextField` display 枝(`inline-text-field.tsx:311-323`)= question_text/explanation_text/memo(+title/sort_key)。edit 枝 = raw Textarea/Input(:256-291)。
- **(B)** `InlineOptionCell` display 枝(`inline-option-row.tsx:352-364`)= option id/text/explanation。edit 枝 = raw(:302-334)。

| 面 | question | option text/expl | explanation | memo |
|---|---|---|---|---|
| カードビュー | A(`card-editor-fields.tsx:74-82`)| B(`InlineOptionList`→`InlineOptionCell`)| A(:96-104)| A(:109-117)|
| テーブルビュー | A(`exam-card-table-columns.tsx:181-189`)| B(`CompactOptionsCell`→`InlineOptionCell` `exam-card-table-options-edit-cell.tsx:54-57`)| A(:248-256)| A(:266-273)|
| side peek | A(`CardEditorFields`)| B | A | A |

学習面は **A/B を使わず独立 inline site**(read-only):
- `session-runner.tsx`:question `:430-432`(pre-wrap)/ option text `:468-474`(stripPrefix 後 pre-wrap)/ option explanation `:475-479`(pre-wrap)/ explanation_text `:500-507`(pre-wrap)。
- `custom-session-preview.tsx:107`:question を `line-clamp-2`(**pre-wrap なし・truncate**)。他 field 非描画。

### 3-4. read-only 表描画の挿入点 + blast radius

| 挿入点 | 対象 field | 面 |
|---|---|---|
| **(A)** `InlineTextField` display 枝 :311-323 | question/explanation/memo | 編集 3 面一括 |
| **(B)** `InlineOptionCell` display 枝 :352-364 | option text/explanation | 編集 3 面一括 |
| **(C)** `session-runner.tsx:430-432` | question | 学習 |
| **(D)** `session-runner.tsx:468-479` | option text/explanation | 学習 |
| **(E)** `session-runner.tsx:500-507` | explanation | 学習 |
| (F) `custom-session-preview.tsx:107` | question(truncate)| preview(除外候補)|

- **編集 page は集約(A/B の 2 点で 3 面カバー)、学習は重複(C/D/E の 3 独立 site)**。→ **read-only pretty 表 renderer の挿入点 ≈ 5**(A,B,C,D,E)。F は line-clamp truncate ゆえ表描画は無意味 = 除外可。
- **EDIT/DISPLAY 分離**:A/B は同一 component が `editing` flag で分岐。renderer は **display 枝のみ差し替え**、edit 枝は **raw MD string 維持必須**(user が source を編集・保存も verbatim ゆえ、edit で表描画すると編集破壊 + 保存形式と desync)。学習面(C-F)は display 専用。

### 3-5. MD パーサ状況

- **MD パーサ dep 皆無**(package.json に marked/remark/micromark/markdown-it/react-markdown/mdast なし)。
- **既存の markdown/table パースコードも皆無**(`split('|')`/`parseTable`/`renderMarkdown`/`| ---` 等 grep 0 件。pipe 使用は `correctIds.join(', ')` 系のみ)。
- → **表限定の自前パーサ**(`|…|` + `|---|` 区切りを検出し表化、非表文字列は `whitespace-pre-wrap` で素通し)が最小経路。**新 dep 不要**・流用できる既存 helper も無し。

---

## 総括(agree / disagree / 不明)

### (1) freeze bug 切り分け:**ループでなく枚数**(agree・確度高)

- **agree**:全書込経路 trace により render/effect の Dexie 書き戻し不在を確定 → **無限ループ棄却**。原因 = 未仮想化 O(N) 再レンダー(1-1〜1-5)。dirty-guard 値比較(`inline-text-field.tsx:129-135`)+ options merge effect の local-only setState(`use-card-options.ts:114-126`)が「tick ループにならない」根拠。
- **不明(経験値)**:live browser repro は未実施(seed が server 側 + freeze が automation を hang させるため read-only では非現実的と CC 判断)。**小 vs 大の比較**が決定実験(予測 = 小は固まらない)。OT が経験的裏取りを望むなら実施。
- **判断論点**:仮想化は正当な fix(ループを隠蔽しない)。ただし **前提 2 件**(newCardIds consume 経路・InlineOptionCell commit-on-unmount)+ **window-virtualizer** が必要(1-7)。→ **CC lean = カードビューに `useWindowVirtualizer` 移植 + 前提 2 件を同 task で解消**。**要 OT 判断**:(a) 原因確定を受けてすぐ仮想化 task を立てるか、(b) その前に小 vs 大 repro で経験的確認するか。**CC lean = (a)**(静的 trace が確定的ゆえ repro は optional)。

### (2) 欄識別の可否 + 4 欄化規模:**識別可・規模小**(agree)

- **agree(識別)**:モデル上 image entry は `target`(=欄)を持ち、refs の field_key にも verbatim 記録(2-1,2-2)。**器は存在**。ただし添付 UI が target='question_text' の 2 gallery のみ → **実データ上の添付欄は事実上すべて question_text**(生成経路が question_text 固定)。
- **agree(規模=小)**:選択肢は validation **既に許容**(widen 不要)、解説/メモは **`imageEntrySchema` target を 1 行 widen** + gallery 増設。handler/refs/GC/discovery は **field 非依存で不変**(2-4,2-5)。options-as-array の特別扱い不要。
- **不明/判断論点**:解説/メモの target 命名(`'explanation_text'`/`'memo'` vs OCR 語彙)は設計判断。**CC lean = field-handler の field 名に一致(`'explanation_text'`/`'memo'`)**(handler/mirror の field 名と揃い drift しにくい)。per-option gallery の UI 増設(選択肢ごとに gallery)は行数増だが validation ノーコスト。**要 OT 判断**:4 欄すべて解禁するか、まず問題文 + 選択肢に絞るか。

### (3) 表描画の挿入点 + 影響:**挿入点 ≈ 5・非表素通し可**(agree)

- **agree(集約)**:編集 page は A/B の 2 共有 component で 3 面カバー、学習は C/D/E の 3 独立 site。**挿入点 ≈ 5**(3-4)。
- **agree(素通し)**:現描画は全て `{value}` 直接補間・書込変換なし(3-2)ゆえ、renderer が「表非検出時は原文をそのまま返す」設計なら **非表文字列は挙動不変**で slot-in 可。
- **agree(自前パーサ)**:MD パーサ dep も既存パースコードも無し(3-5)→ 表限定自前パーサが最小。**新 dep 不要**。
- **判断論点(EDIT は raw 維持)**:renderer は display 枝のみ差し替え、edit 枝は raw MD textarea 維持(3-4)。**要 OT 判断**:renderer を A/B/session-runner に**共有 component 1 個**として作り 5 site が import する形(推奨)か、面ごと個別か。**CC lean = 共有 renderer 1 個**(簡潔性規律・rule of three 充足)。

### 不明(残余)
- 実 DB の card 本文に実際どれだけ MD 表が入っているか(分布)は未クエリ(OCR 指示上は 4 欄に入りうる)。
- freeze の live 再現・OOM か CPU block かの実測は未実施(1-5 の判断)。
- 解説/メモ asset target の命名定数は現コードに存在せず(新設が要る = 設計判断)。
