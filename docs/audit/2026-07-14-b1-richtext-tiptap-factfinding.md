# B1(リッチテキスト・Tiptap)fact-finding

> **⚠️ 前提破棄(2026-07-15 追記・supersede ではない)**
> 本 doc の中核前提「Tiptap によるリッチテキスト化 + 本文途中への画像挿入 + 本文 version 付き JSON + 変換層」は、業界調査(Anki/Mochi/RemNote/Quizlet/Markji)+ GPT cross-check + OT 討議を経て **破棄**された。B1 は「**画像は欄(field)単位添付** + **表は MD のまま保存・read-only 描画**」へ縮小。
> - **破棄(もう追わない)**: Tiptap/Lexical 選定・技術スパイク 5 点・本文 JSON・変換層・**案 X/案 Y(assetId 保有面)論点**・**card_asset_refs clobber gap**(本文 JSON を入れない以上発生しない)・`@tiptap/react` peer 調査。
> - **生きている事実(現 HEAD 再検証の上で流用可)**: **A. 編集面の棚卸し**(2 プリミティブ / 3 面 / commit 経路)・**C. seam / 仮想化・React19 の現物事実**・**B. 保存 format の事実**(全 text field は plain string・options jsonb・`content_version` は DEAD・wire は `value:z.unknown()` shape 非依存・`card_asset_refs` は handleImages 単一 writer で field_key=target verbatim)。
> - 後継 doc = `docs/audit/2026-07-15-b1-scope-reduction-and-cardview-freeze-factfinding.md`(縮小スコープ + カードビュー freeze bug triage)。

- **日付**: 2026-07-14
- **調査 HEAD**: `develop` `0f94458`
- **性質**: **read-only 調査のみ**。実装 / スパイク prototype / migration / spec 起草は一切なし(fact-finding と実装は分離)。
- **背景**: 画像シリーズ(フェーズ A + GC v2)完了・prod 反映済。次タスク B1 = 画像を文中に差し込めるリッチテキスト化。エディタ第一候補 = Tiptap(1 インスタンスを Portal 表示・通常は軽量 read-only レンダラー・各セルに mount しない)。B1 頭で技術スパイク(IME / Portal+仮想化 / 画像 / リサイズ / Undo)→ 合格で Tiptap 確定・不合格なら Lexical。本 doc はその前段。
- **規律遵守**: 全て現 HEAD の実コードで裏取り(file:line 明示)。過去 session/引き継ぎ記述は confirmed 扱いせず現物確認。不明は「不明」と明記。
- **調査方法**: CC 本体 + 並列 read-only subagent 3 体(編集面 / 保存・sync 経路 / 画像・deps・変換層)。Tiptap peer 版のみ npm registry 直叩き(WebFetch・install なし)。

---

## A. 現行のテキスト編集面の棚卸し

### A-1. 編集プリミティブは 2 種・全て plain text

カードの編集可能フィールドは全て以下 2 プリミティブのどちらかが描画する。**現状リッチテキストは皆無**(`contentEditable` なし・`dangerouslySetInnerHTML` はリポジトリ全体で 0 件)。表示は click で実入力要素(`Input`/`Textarea`)に swap する `<div role="button">` 方式。

- **`InlineTextField`**(scalar text 列)— props: `cardId` / `field`(`'sort_key'|'title'|'question_text'|'explanation_text'|'memo'`)/ `initialValue: string | null` / `ariaLabel` / `multiline?` / `placeholder?` / `displayClassName?` / `autoEditOnMount?`(`inline-text-field.tsx:49-61`)。単一行は `Input`、`multiline` は `Textarea`(分岐 `inline-text-field.tsx:270-288`)。
- **`InlineOptionCell`**(option 部分フィールド)— props: `kind`(`'id'|'text'|'explanation'`)/ `value: string` / `onSave: (value)=>void` ほか(`inline-option-row.tsx:233-243`)。

`initialValue: string | null`・`value: string` の通り、**入力の値はすべて素の文字列**。option も `CardOption = {id, text, is_correct, explanation?}`(`lib/db/schema.ts:46-51`)で text/explanation は plain string。

### A-2. 編集面は 3 つ・フィールド所在

**(1) テーブル inline セル**(`exam-card-table-columns.tsx`、列ごとに `InlineTextField`/セル):
- title `:123-128`(単一行)/ sort_key `:162-168` / question `:181-189`(`multiline`)/ options `:201-206` → `CompactOptionsCell`(option text + explanation + is_correct)/ explanation_text `:248-256`(`multiline`)/ memo `:266-273`(`multiline`)/ tags `:216-229`(`TagCell`・非 text)。
- **テーブルビューは全フィールドを grid 内セルで直接編集できる**(question/explanation/memo/options も inline)。

**(2) サイドピーク**(`exam-card-side-peek.tsx`、全レコード編集):
- sort_key `:109-116` / title `:121-127` を自前で持ち、残り(tags / question / options / explanation / memo / images)は `CardEditorFields` に委譲 `:133-144`。Radix `Dialog`(`modal={false}`・Portal・outside-click で閉じない `:52-77`)。

**(3) `CardEditorFields`**(`card-editor-fields.tsx`、list とサイドピーク共通の「後半」):
- tags → `CardTagsSection` `:63-69` / question_text → `InlineTextField multiline` `:74-82` / options → `InlineOptionList` `:91` / explanation_text → `InlineTextField multiline` `:96-104` / memo → `InlineTextField multiline` `:109-117` / **images → `CardImageGallery` `:85`**。
- カードビュー list(`inline-card-list.tsx`)は sort_key `:275-282` + title `:285-291` を自前で持ち、残りを `CardEditorFields` `:302-314` に委譲。

### A-3. commit 経路(seam に効く)

- **`InlineTextField` は自己完結型(onChange/onCommit prop を持たない)**。blur(`handleBlur inline-text-field.tsx:242-254`・未変更なら short-circuit)で `commit`(`:183-211`)を呼び、`runOptimisticUpdate` で Dexie mirror 書込 + outbox enqueue を 1 tx で発行 → `scheduleDrain()`。debounce `DEBOUNCE_MS=500`(`:63`)は server-drain trigger のみ。**編集中 unmount 時も dirty なら commit**(`:142-164`、`latestRef` snapshot で誤コミット防止)。
- **`InlineOptionCell` は callback 型**。`onSave(editValue)` を blur で発火(`:294-298`)→ `useCardOptions.handleCellSave`(`use-card-options.ts:226-236`)→ `commit`(`:160-222`、同 500ms debounce)。**commit-on-unmount 無し**。このため side peek は close 前に `document.activeElement.blur()` を明示発火して option 編集中の値を flush する(`exam-card-side-peek.tsx:57-62`)。

### A-4. 「軽量 read-only レンダラー」が差す現在の表示

非編集時の question_text 等の表示は `whitespace-pre-wrap` の素テキスト span/div(`inline-text-field.tsx:294-322`)。学習ビューも `<p className="whitespace-pre-wrap">{current.questionText}</p>`(`session-runner.tsx:430-431`)。**改行のみを pre-wrap で保持する plain text 描画**であり、B1 の「軽量 read-only レンダラー」は本文 JSON(inline 画像込み)を React ノードへ安価に描く**新規実装**になる(現状に read-only レンダラーの seam は無い)。

---

## B. 現行のカード保存フォーマット

### B-1. 全テキストフィールドは plain `text` / `string`

| フィールド | 型 | file:line |
|---|---|---|
| title | `text` NOT NULL | `schema.ts:308` |
| sort_key | `text` nullable | `schema.ts:309` |
| question_text | `text` NOT NULL | `schema.ts:310` |
| explanation_text | `text` nullable | `schema.ts:313` |
| memo | `text` nullable | `schema.ts:315` |
| options | `jsonb` `CardOption[]` | `schema.ts:311`(型 `:46-51`、text/explanation は plain string)|
| correct_answer_ids | `jsonb` string[] | `schema.ts:312`(server 再生成)|
| images | `jsonb` `CardImage[]` default `'[]'` | `schema.ts:316-319`(型 `:53-59`)|

zod 側も plain string: `questionTextSchema`/`explanationTextSchema`/`memoSchema` = `z.string().max(10000)`(`lib/validation/card.ts:50-63`)。

### B-2. `content_version` は DEAD(誤解注意)

`cards.contentVersion`(`schema.ts:338`・integer default 0)は「local-first 同期用」とコメントされるが、**increment する経路が存在しない**(全 census: pull-mapper が透過コピー `cards-mapper.ts:43,81` / `build-new-client-card.ts:59` が literal 0 / Dexie index `client-db.ts:278,328,341` のみ・UPDATE で bump する箇所ゼロ)。書込ごとに動くのは `updatedAt`(`updateCardField` の `sql\`now()\`` `card-field-handlers.ts:103`)。→ **content_version はコンテンツ format 版数として流用できない**(概念的に空き番だが現状は optimistic-concurrency にも未接続)。B1 の「version 付き JSON」の版数は別途持つ設計になる。

### B-3. wire は shape 非依存・型 gate は zod に集約

`card.update_field` の wire envelope は `value: z.unknown()`(`mutation-schemas.ts:51`)。**wire 自体は形状非依存**で、型を絞る唯一の gate は各フィールドの bound zod(`lib/validation/card.ts`)。→ リッチテキスト化の型受け皿は「該当 zod を string → version 付き JSON schema に差し替え + DB 列 `text`→`jsonb`」に閉じる(wire protocol の変更は不要)。

### B-4. リッチテキスト受け皿として書込で触る層(question_text 例)

| 層 | 実体 | file:line |
|---|---|---|
| 値検証 zod | `questionTextSchema` 他 | `validation/card.ts:50-63`(option は `:14-27`)|
| envelope patch zod | `cardUpdateFieldPatchSchema`(value=unknown 透過)/ `cardCreatePatchSchema` | `mutation-schemas.ts:49-64` |
| server dispatch | `applyCardUpdateField` → `CARD_FIELD_HANDLERS[field]` | `entity-mutation-registry.ts:137-151` |
| server handler | `handleQuestionText` 他 | `card-field-handlers.ts:127-131` |
| server write core | `updateCardField`(UPDATE + updatedAt)/ create `applyCardCreateWithId` | `card-field-handlers.ts:95-107` / `apply-card-mutation.ts:67-115` |
| DB 列型 | `cards.questionText` `text`→`jsonb` | `schema.ts:310` |
| client 楽観適用 | `InlineTextField.commit` / options `useCardOptions.commit` | `inline-text-field.tsx:183-211` / `use-card-options.ts:160-222` |
| 楽観 tx helper | `runOptimisticUpdate` | `optimistic-mutation.ts:251-293` |
| outbox enqueue/coalesce | `enqueueEntityMutation` / `coalesceKey` | `entity-mutations.ts:70-124,47-55` |
| Dexie mirror 型 | `ClientCard.question_text: string`(option `:55-60`)| `client-db.ts:98-128` |
| pull 復元 | `toClientCard` / `toCard`(透過)| `cards-mapper.ts:16-85` |
| pull server select | `getCardsDelta` | `cards-pull.ts:18-27`, `api/pull/route.ts:17,67` |
| pull client 書込 | `db.cards.bulkPut` | `pull.ts:205` |
| 新規カード shape | `buildNewClientCard` / `buildEmptyCard` / `buildNewCardMutationPatch` | `build-new-client-card.ts:22-65` / `empty-card.ts:11-36` / `card-write.ts:43-64` |
| OCR 生成(writer)| `process.ts` + `ocr.ts` / `ocr-response.ts` / `ocr-extract.ts` | plain string を生成 |

### B-5. images(GC v2 の card_asset_refs 正規化)との関係 — clobber gap

**確定事実(現物確認)**:
- `card_asset_refs` を書くのは **`handleImages` の単一点**(`card-field-handlers.ts:170-231`)。他 handler(`handleQuestionText`/`handleExplanationText`/`handleMemo`/`handleOptions`/…)は `updateCardField` の bare な cards UPDATE のみで **refs に触れない**。
- refs 置換は **per-card whole-set**:`DELETE FROM card_asset_refs WHERE card_id=? AND user_id=?`(全 refs 無条件削除 `:202-204`)→ **`images[]` からのみ** 射影 INSERT(`:210-228`、asset id = `images.map(i=>i.key).filter(isAssetKey)` `:176`)。
- `fieldKey` = `entry.target` verbatim。UUID key の target は zod で `'question_text'` または `/^option:.+/` に強制(`validation/card.ts:106-117`)。PK は複合 `[cardId, fieldKey, ordinal]`(`schema.ts:871`)。
- refs は GC 権威(schema コメント `:844-853`)、`assets` FK は `onDelete:'restrict'`(`:861-863`)。
- **重要**:`card.update_field` の各 op は **別々の per-mutation tx**(bulk receiver が 1 op ごとに tx を開く `apply-card-mutation.ts:8-13`。`update_field` は cascadeLike でない)。

**gap(B1 で必ず解く)**: リッチテキスト `question_text` JSON に inline 画像ノード(assetId)が入ると、その assetId は **`question_text` の update_field op で到着** → `handleQuestionText` は refs を書かない → **本文画像が GC から不可視 = 誤って回収対象になりうる**。かつ **naive「refs writer を 2 つ目に足す」修正は誤り**:`handleImages` は「refs 全削除 → images[] からのみ INSERT」なので、`question_text` op が書いた refs は次の `images` op で **wipe** され、`images` op の whole-set は本文由来 id を含まない。両 op は同 tx でも相互 read でもないため、2 つの whole-set replace が **merge でなく clobber** する。

→ 正しい設計は「refs を **カードの全 asset 保有フィールドの union** から確定的に導出」(images[] と本文列の extractAssetIds を合わせて 1 回の whole-set replace)。本文 refs の `fieldKey` は既存 gallery の `'question_text'` と PK 衝突しない別 namespace が要る(`[cardId,'question_text',ordinal]` は gallery が既に使用)。

**補足(現画像モデル)**: 現状の画像は「**フィールドに紐づく gallery 添付**」(`card-image-gallery.tsx:168` で `target==='question_text'` に filter・target ごとに束ねて表示)であり、**本文 inline ノードではない**。B1 は inline 化なので「本文 JSON が新たな assetId 保有面になる」ことがこの gap の根。

---

## C. Tiptap を差す構造(1 インスタンス Portal + 軽量レンダラー)

### C-1. seam = 集中 edit-target state が「無い」

**現状、テーブルに「どのセル/フィールドが編集中か」の集中 state は存在しない**。編集 state は完全分散 — 各 `InlineTextField` が local `editing` bool(`inline-text-field.tsx:85`)、各 `InlineOptionCell` も自前(`inline-option-row.tsx:262`)を持つ。テーブル level の "active" state は `activeCardId`(`exam-card-table.tsx:290`)だけで、これは **セル編集でなくサイドピーク**を駆動する。

→ 1 つの Portal-Tiptap に target ごとの JSON を食わせるには、(a) 新規に共有 edit-target state(`{cardId, field, optionId?} | null`)をテーブル/ページ level に立て、(b) 表示モードの click handler(`inline-text-field.tsx:302` の `onClick={startEdit}` / `inline-option-row.tsx:343`)を「自前 `editing` を立てる」から「共有 target に自分を登録」へ付け替える。各プリミティブの `<div role="button">` が attach point で、単一 Portal editor がその DOM rect を overlay し、target 変更時にそのフィールド JSON を読み込む。

### C-2. 仮想化と React 19 の現状

- **`@tanstack/react-virtual` 使用**(import `exam-card-table.tsx:54`、`useVirtualizer` `:132-139`:`overscan:5` / element-based / `measureElement` 動的行高 / `useFlushSync:false`)。**in-view 行のみ mount**(`getVirtualItems()` `:150,179-229`、画面外は spacer `<tr>`)。inline 編集は **その場 swap**(セル click で同 DOM slot に入力要素)、サイドピーク経由ではない。
- **React `flushSync` はコード内で未使用**(唯一のヒットは virtual の `useFlushSync:false`)。Portal は Radix `DialogPrimitive.Portal` のみ。
- **React 19 render-phase dirty-guard**(`useEffect` を render 中 guarded setState で置換)が `inline-text-field.tsx:123-135` / `inline-option-row.tsx:271-278` にあり、**編集中に外部 prop(mirror/pull)で入力値を上書きしない invariant** を守る。Tiptap 置換でも保持必須。
- **`exam-card-table.remount.test.tsx` が locking する invariant**: resize 1 drag で `InlineTextField` の mount/unmount = 0(`:216-217`、初期 mount>0 の非空 guard `:191`)/ resize 中 re-render = 0(memo freeze `:259-262`)/ 非 resize 時は Dexie 更新がセルへ伝播(memo comparator が data 反応性を凍らせない `:310-315`)。**セルは仮想化 scroll-out で unmount する前提**ゆえ `InlineTextField` は commit-on-unmount(`:142-164`)を持つ = セルが構造的に重い理由。

### C-3. サイドピークとの役割分担

テーブルセル = compact な列別編集。サイドピーク(`exam-card-side-peek.tsx`)= 全レコード編集(Radix Dialog・既に Portal)。B1 の役割分担(テーブル = 固定小サムネ / カード・サイドピーク = ユーザー指定サイズ)に対し、**サイドピークは Portal-Tiptap の自然な副ホスト**だが grid seam とは別面(full-record surface)。grid seam(C-1)とサイドピーク seam は別々に設計対象。

---

## D. 技術スパイクの scope 確定材料(実環境即応)

環境: Next `16.2.9`(`package.json:41`)/ React・react-dom `19.2.7`(`:44-45`)/ TS `^6.0.3`(`:75`)/ Tailwind `^4.2.4`(`:73`)/ `@tanstack/react-table` `8.21.3`(`:30`)/ `@tanstack/react-virtual` `3.14.5`(`:31`)/ Turbopack / pnpm `10.33.0`(`:9`)/ Node 24(`:6-8`)。**tiptap/prosemirror/lexical/slate は現状ゼロ**(grep 0)。新 dep は CLAUDE.md「新ライブラリ導入は事前相談」対象。

### ① 日本語 IME
- **現コードに composition 処理は皆無**(`onCompositionStart/End` / `isComposing` / `keyCode===229` の source ヒット 0)。`Input`/`Textarea`/`InlineTextField`/`InlineOptionCell` いずれも composition 非対応。commit-on-blur + 500ms debounce も composition 非認識。
- → **IME は「既存の回避策を保つ」でなく新規ハザード**。ProseMirror は内部で composition を扱うが、周辺の commit/blur/debounce 配線は無防備。スパイク合格条件例: Portal-Tiptap を仮想化セル上で日本語入力し、変換確定前に commit が発火しない / 確定で正しく 1 回 commit / 文字化け・二重入力なし。

### ② Portal + 仮想化
- テーブルは仮想化・**セルは scroll-out で unmount**・列 resize で reflow(C-2)。
- → スパイク合格条件例: Portal editor が対象セル rect に追従し、下地セルが scroll/resize で unmount/reflow しても編集消失・誤 card への commit・flushSync 系エラーが起きない(現 commit-on-unmount `:142-164` 相当の保全を Portal 側で再現)。

### ③ 画像 assetId ノード(既存 resolve/Cache との接続)
- 描画チェーン(既存): `CardImageGallery`/`CardImageThumbnail` → `getAssetObjectURL(userId, key, {resolveAssetUrls})`(`get-asset.ts:48-90`)→ 3 段(in-memory `objectUrlCache` Map `${userId}:${assetId}` / Cache API `matchAssetBlob` / miss で `resolveAssetUrls` presigned GET + fetch `mode:cors,credentials:omit,timeout:30s` → `putAssetBlob`)→ `URL.createObjectURL` → 素の `<img>`(`card-image-gallery.tsx:126-132`)。server `resolveAssetUrls`(`asset-actions.ts:210-262`)は ready + own-user のみ・`url=presignGetUrl(objectKey)` + `mime/width/height`。Cache API = `'recallmint-media'`・key `/__media/${userId}/${assetId}`(`cache.ts:6-12`)。
- → スパイク合格条件例: Tiptap の inline 画像ノード(assetId 保持)が既存 `getAssetObjectURL` 経由で解決・描画でき、read-only レンダラー(テーブルセル)でも同経路で安価に出る。fail = 既存 resolve/Cache に配線できず独自取得が要る。

### ④ アス比保持リサイズ
- **displayWidth は現状どこにも保存されない**。`ClientCardImage = {key,target,alt,source_ref?,url?}`(`client-db.ts:62-68`)/ server `imageEntrySchema`(`validation/card.ts:94-117`)に寸法列なし(`url` 非空は reject `:102-105`)。サムネは固定 `h-16 w-16 object-cover`(`card-image-gallery.tsx:131`)。
- **自然寸法は保存済**:server `assets.width/height`(+`mime/byteSize/hash/status`)`schema.ts:825-828`、client `media_assets` mirror(`client-db.ts:74-84`、upload 時 `createImageBitmap` decode `upload.ts:360,714-717`)、`resolveAssetUrls` も width/height を返す(`asset-actions.ts:261-262`)。
- → **per-placement displayWidth は本文 JSON の新規フィールド**(自然寸法 = asset メタ由来と分離)。スパイク合格条件例: drag-resize でアス比保持・displayWidth が本文 JSON に永続・自然寸法は asset メタから取得。fail = 歪み or 永続化できず。

### ⑤ Undo(Tiptap 内 Undo と outbox の境界)
- mutation 単位 = **per-field whole-value replace**(`update_field {field,value}`・`images` も配列丸ごと `upload.ts:498-503`、text は runOptimisticUpdate + 500ms debounce)。**アプリ level の undo/redo は皆無**(grep で `delete-card-button.tsx:6` の「undo なし」コメントのみ)。
- 補償: enqueue が同 tx 内で throw した時の Dexie auto-rollback のみ(`optimistic-mutation.ts:99-102,281-287`)。flush 後の訂正は **次回 server pull の reconcile だけ**(`:20-21`)。upload は forward な補償 saga(`abandonUpload upload.ts:794-813`)で undo ではない。
- → Tiptap の Ctrl-Z は in-memory ProseMirror history 上の操作で **outbox の上位**に座る。undo しても outbox には「変更後 field 値の debounced whole-value `update_field`」が流れるだけ(通常の打鍵と同じ)。cancel すべき per-op outbox entry は無い。スパイク合格条件例: session 内の Tiptap undo が動き、結果の whole-value update_field が楽観 mirror + pull と drift なく整合(ghost 再適用なし)。fail = undo が mirror/outbox を desync。

### D-6. 新 dep 候補の版整合(registry 直叩き・install なし)
- **`@tiptap/react@3.27.4`**(npm registry `latest`・2026-07-14 取得)。peer: `react: "^17 || ^18 || ^19"`、`react-dom: "^17 || ^18 || ^19"`、`@tiptap/core: 3.27.4`、`@tiptap/pm: 3.27.4`。deps: `use-sync-external-store` / `fast-equals`。→ **React 19 は公式 peer 対応**(v3 系は ProseMirror バンドル `@tiptap/core`+`@tiptap/pm` を伴う)。
- deps-matrix 規律(`docs/superpowers/sessions/2026-06-10-deps-target-versions-matrix.md`): core deps は **exact-pin(caret 禁止)**、react/react-dom は same-patch pair を `pnpm-workspace.yaml overrides` で lockstep、React Compiler OFF、TanStack Table v8 固定。**matrix は Tiptap/ProseMirror/Lexical を未記載**(editor sprint 前の doc)ゆえ、B1 導入時に matrix へ追記が要る。

---

## E. Lexical 退避判断の材料(変換層)

- **変換層は存在しない**。カードテキストは端から端まで plain string。描画は直接文字列補間(`dangerouslySetInnerHTML` 全 0)。学習ビュー `session-runner.tsx:430-431` は `whitespace-pre-wrap`、edit は `Textarea`/`Input`。`content_version` は concurrency counter で format tag ではない(B-2)。card 内容の serialize/deserialize/toJSON/fromJSON は皆無。
- 画像も「plain string key の side-array を target でフィールドに紐付け」(B-5)であり本文 inline ノードでない。
- → エディタ選択を吸収しうる変換層(Tiptap ProseMirror-JSON ↔ Lexical-JSON)は **部分的にも存在せず、完全に新規**。エディタ決定は「まだ無い境界」の **設計問題**(格納表現は何か・serialize/deserialize/render/extractAssetIds/migrate をどこに置くか)であって既存コード裏の isolate ではない。version 付き JSON + pure 変換関数(parse/render/extractAssetIds)として設計すれば Tiptap↔Lexical swap を閉じ込められる — が、その isolation は**これから作る設計特性**であり現状の担保ではない。

---

## 総括

### (1) 技術スパイクの確定 scope

**prototype するもの(最小)** = 「仮想化テーブル + 単一 Portal-Tiptap(react 19.2.7 / Next 16 App Router / Turbopack / Tailwind v4)」の垂直薄片。各セルに Tiptap を mount せず、read-only レンダラー(本文 JSON→React ノード + inline 画像サムネ)+ 編集時のみ Portal 1 インスタンス。5 点の合格/不合格:

| # | 検証 | 合格 | 不合格 |
|---|---|---|---|
| ① IME | 仮想化セル上 Portal-Tiptap で日本語入力 | 変換確定前に commit 不発火・確定で 1 回 commit・文字化け/二重なし | IME 事故(未確定 commit・欠落) |
| ② Portal+仮想化 | scroll/列 resize でセル unmount/reflow | editor が rect 追従・編集消失/誤 card commit/flushSync エラーなし | detach/誤 commit/例外 |
| ③ 画像ノード | assetId inline ノード | 既存 `getAssetObjectURL`/resolve/Cache 経由で解決・描画(read-only も) | 既存経路に配線不能 |
| ④ リサイズ | drag-resize | アス比保持・displayWidth を本文 JSON に永続・自然寸法は asset メタ | 歪み/永続不可 |
| ⑤ Undo | Tiptap Ctrl-Z | 結果の whole-value update_field が mirror+pull と drift なし | mirror/outbox desync |

**stance = agree**(brief の 5 点を現状に即して具体化。追加検証したい 1 点 = 「軽量 read-only レンダラーの描画コスト」(仮想化多数セルで inline 画像込み JSON を安価に描けるか)を ② に内包)。

### (2) 現行編集/保存面の blast radius: **大**

理由: plain string → version 付き JSON は (a) スキーマ列型(`text`→`jsonb`)(b) 値検証 zod(c) server handler(d) client 楽観 apply(e) Dexie mirror 型(f) pull mapper(g) 学習/FSRS 描画(h) テキストフィルタ(`makeTextFilterFn` が文字列前提 `exam-card-table-columns.tsx:194-195,259-260`)(i) OCR ingest writer(plain string 生成)を横断し、さらに (j) **card_asset_refs GC 連携**(B-5 の union 導出)と (k) **新規 read-only レンダラー / 単一 Portal-Tiptap の UI 再設計**が乗る。非 test の read/write 面だけで ~30 file(server/shared ~10・client write/mirror ~6・UI render/edit ~10・OCR ingest ~6)。**stance = disagree(「小/中」評価に対し)= 大**。ただし wire protocol は shape 非依存(`value:z.unknown()` B-3)で無風、pull/sync も透過なので「protocol は不変・touch は表現層と GC 連携に集中」という意味で **管理可能な大**。

**軽減材料(agree)**: zero-user ゆえデータ migration 不要 / 型 gate が zod 単一面に集約 / commit 経路は既に集中(text は self-commit、option は useCardOptions)。

### (3) 変換層 + card_asset_refs 連携で spec が決める論点

**A. 本文画像の assetId 保有面(最重要・GC v2 anchor と交差)**
GC v2 の client 同期 anchor は「`images[]` whole-array 全置換」。本文 inline 画像の assetId をどこに持つかで 2 案:
- **案 X(images[] 維持・二重表現)**: 本文 JSON は assetId を参照するが、assetId 台帳は従来どおり `images[]`。→ `handleImages` が単一 refs writer のまま・**clobber 問題は発生しない**。代償 = 本文編集(画像ノード add/remove)が **必ず `images[]` update op も同時発行**する client 協調が要る(2 op の整合を client が保証)。
- **案 Y(本文 JSON を保有面に・extractAssetIds)**: 本文列から assetId 抽出し refs を **union 導出**(images[] + 本文列を 1 回の whole-set replace)。→ handleImages の per-op whole-set を「post-apply の union derive」へ作り替え(B-5)。`fieldKey` に本文 namespace を追加(gallery `'question_text'` と PK 非衝突)。
- **CC lean = 案 X に傾く(暫定・要 spec 決定)**。根拠: ① GC v2 anchor(images[] 全置換)と client 同期プロトコルを崩さない ② refs writer が単一点のまま = drift 防御が構造的 ③ 変換層 `extractAssetIds` は「本文 JSON → assetId 集合」を pure に切り出せ、案 X でも「本文編集時に images[] を同期するための抽出」として同じ関数を再利用できる。**stance = 案間は不明(spec 判断)/ 但し clobber gap の存在と 2 案の trade-off は confirmed**。

**B. 変換層の境界(Tiptap/Lexical isolation)**
version 付き JSON を stored representation とし、pure 関数 `parse/render(read-only)/extractAssetIds/migrate` を lib(例 `lib/cards/richtext/`・domain 寄り)に置けば、エディタ swap を境界内に閉じ込め可能。**stance = agree(閉じ込め可能)/ 但し「現状に seam なし=完全新規」ゆえ isolation は設計で作る property**(E)。DDD 規律(CLAUDE.md「薄い DDD」)上、変換 pure 関数は `lib/cards/` の pure 層に置き client/server 両 import(二重実装禁止)。

**C. content の版数**
`content_version` は DEAD で流用不可(B-2)。本文 JSON の schema version は **JSON 内 `version` フィールド**として持つのが素直(migrate 境界の入口)。**stance = agree**。

**D. displayWidth の格納**
per-placement displayWidth = 本文 JSON の画像ノード属性(自然寸法 = asset メタ)。テーブル = 固定小サムネ(displayWidth 無視)/ カード・サイドピーク = displayWidth 適用、の描画分岐は read-only レンダラーの responsibility。**stance = agree(格納先は本文 JSON で確定的)**。

### 不明(残余・現物確認できず)
- `@tiptap/react` 導入時の **Turbopack / Tailwind v4 実ビルド健全性・実 bundle size**(registry の版制約は確認済だが実環境 build は未検証 = スパイクで判定)。
- **Tiptap↔Lexical の JSON schema 互換の実務コスト**(変換層で吸収する前提だが、両者のノードモデル差の実測はスパイク範囲)。
- 本文 inline 画像を導入した際、**現 gallery(target 添付 UI)を廃止するか併存するか**(B-5 補足の画像モデル転換)は spec 判断で本 doc 範囲外。
- 実 DB の既存 card 本文分布は zero-user 前提のため未クエリ(移行コード不要の前提は妥当)。
