# ②-4(図版切り出し)fact-finding — 現物 vs 統合 doc の差分

- 日付: 2026-07-29
- 位置付け: **記録のみ・判断なし**。統合 doc(`docs/audit/2026-07-29-ocr-2-4-carryover-and-design-notes.md`、以下「持越 doc」)の 16 項を現物と突合。spec はこの結果を見て別途設計。
- 方法: 現物コード read + 2 subagent(ingestion→Gemini / OCR→card 作成)。全主張に file:line。推測は明示。

---

## 結論(先出し)

1. **box_2d は本番に一切存在しない**。prompt / schema / pipeline / zod いずれにも座標 field なし。存在するのは `scripts/ai/`(②-0 実験 arm B)と `docs/` のみ。→ ②-4 は検出 field を schema+prompt+pipeline+zod に **net-new で足す**(prompt を撫でる話ではない)。
2. **Gemini が見る画像は client 圧縮後(≤2048px / ≤0.5MB・アスペクト保持)であって原本ではない**。かつその画像は upload 成功で **navigation により破棄**され、どこにも永続化されない。→ 持越 doc §7「client がページ画像から crop」は **crop 時点で画像が手元に無い** 問題を跨いでおり、ここが最大の設計ギャップ。
3. **失敗隔離は現状ゼロ(all-or-nothing)**。持越 doc §5(B/C/D)は未実装の設計意図。
4. **Fable 昇格条件は不成立 → Opus 継続**。「一部 crop の upload 失敗」は既存 attach saga が clean にカバーする(下記)。RESTRICT が中途半端状態を作る経路は OCR 側に無い。
5. 現物確認で **持越 doc に無い追加ギャップ 3 件**(target 語彙の写像 / 複数ページ provenance / bbox 保存先の不在)を検出。

---

## 領域 1: Gemini に送る画像は圧縮後か原本か 【最優先】

**結論: client 圧縮後。原本は送らない。座標系は圧縮画像基準。**

- upload 経路は `app/(app)/app/upload/`(`exams/` ではない)。client `_components/upload-form.tsx` / server action `processUpload`(`_actions/process.ts:97`)。
- **client が画像を圧縮してから送る**: `upload-form.tsx:243` `processImage` が `browser-image-compression` を呼ぶ。設定 = `maxSizeMB: 0.5` / `maxWidthOrHeight: 2048`(`_lib/constants.ts:15-16`)。圧縮 blob が entry を **置換**し(`upload-form.tsx:257` `file: compressed`)、それが submit される。→ Gemini が見るのは **≤2048px の client 圧縮版**。
  - 註: これは **attach saga の圧縮(1600px / 1MB / webp 強制、`lib/media/upload.ts:206`)とは別 config**。crop を attach saga に流すと **二重圧縮**(2048px→1600px webp)になる。
- **PDF は無変換で送る**(rasterize なし)。`_lib/pdf-page-count.ts` はページ数を正規表現で数えるだけ。→ PDF の box_2d crop には **client 側 rasterizer が存在しない**(領域 2/追加ギャップ参照)。
- server は無加工の base64 pass-through: `process.ts:284-289`(`arrayBuffer()→Buffer→base64`)。**server 側の resize/rasterize/再エンコードは無い**。Gemini が受けるバイトは client が submit したバイトと byte-identical。
- **圧縮画像は crop 時点で手元に残らない**: 成功時 `router.push('/app/upload/result/${sourceDocumentId}')`(`upload-form.tsx:493`)で **component ごと破棄**(`upload-form.tsx:480,492` のコメントが明言)。source バイトは **inline base64 で Gemini に渡すのみ・永続化しない**(`schema.ts:375-376`、R2 非経由)。
- **assets.width/height はどちらの画像か**: これは **OCR source とは無関係**。`assets`(server table・`schema.ts:821-847`)の width/height は attach saga が入れる **card 添付画像の圧縮後寸法**(`lib/media/upload.ts:360` の `createImageBitmap`)。**OCR source の寸法はどこにも記録されない**(`source_documents` に width/height 列なし)。
- box_2d の座標規約(実験 arm B): `[y_min, x_min, y_max, x_max]`・**各軸 0-1000 正規化・y 先**(`scripts/ai/lib/figure-detect-schema.ts:21-32` / `box-overlay.ts:1-52`)。各軸独立正規化ゆえ、アスペクト保持された任意解像度の同一画像に正しく写像する(= 原本があれば原本からも crop 可、ただし原本も破棄される)。

**持越 doc との差分**: §7 は「client がページ画像から crop」だが、(a) 圧縮版しか Gemini は見ておらず、(b) その画像は cards+座標が返る時点で既に破棄され、(c) 現 return payload に画像も座標も無い。**crop を成立させるには「navigation 前・upload flow 内で crop」または「新たな画像保持機構」が要る**(spec の中核判断)。

---

## 領域 2: client-side crop が既存 attach saga に乗るか

**結論: saga 自体は乗る(File→UUID asset)。ただし現状 saga は OCR flow に一切配線されておらず、編集 UI からしか呼べない。**

- 既存 attach 経路(`lib/media/upload.ts`):
  - `compressForAttach(file: File)` → webp 圧縮 → `{ blob, mime, width, height, hash }`。
  - `attachImageToCard({ userId, cardId, target, file, currentImages }, { reserveAsset, finalizeAsset })` = saga 本体。圧縮 → `reserveAsset`(assets 行 'reserved' INSERT + presigned PUT URL、`asset-actions.ts:84`)→ 楽観層(Cache put + Dexie `media_assets` 'uploading' + mirror `cards.images` append)→ 直 PUT → `finalizeAsset`(R2 HEAD 検証→'ready'、`asset-actions.ts:129`)→ 'ready' + flush。
  - 追加される entry は `{ key: assetId, target, alt: '' }`(`upload.ts:682-686`)。**key = 実 UUID**。→ 持越 doc §6E「UUID を入れれば placeholder は自然に消える」は正しい。
- **crop blob を流す際に足りないもの**:
  - `attachImageToCard` は `File` を要求(saga が MIME/拡張子 gate を持つ・`upload.ts:304`)。crop 出力 Blob を `File` 化(名前・type 付与)して渡す必要。
  - `target` は呼出側が渡す。ただし **語彙が card 側 enforce と食い違う**(追加ギャップ①参照)。
  - `userId` / `cardId` / `currentImages` が必要。cardId は OCR 後にしか確定しない。
- **OCR 直後(同一フロー)から呼べるか**:
  - 現状 saga の呼出元は **編集 UI のみ**: `app/(app)/app/exams/[id]/_components/card-image-gallery.tsx:573` と `exam-card-table-columns.tsx:191`。**upload flow(`app/(app)/app/upload/`)には配線ゼロ**。
  - OCR の card 作成は **server action**(`process.ts` → `saveExtractedCards`、下記)で、成功 return は preview subset(`{ id, title, questionTextSnippet, optionCount }`、`process.ts:497-518`)。**card 一覧の id は返るが、座標・source 画像・target は返らない**。
  - 「同一フロー内 crop」を成立させるには: submit → server(OCR + card INSERT + **box_2d/target を return に追加**)→ client(**まだ entries に圧縮画像を保持している間に**)crop → `attachImageToCard`。**現状は成功で即 `router.push` して画像を捨てるため、この window が存在しない**。→ upload flow の再設計 or crop 専用の別導線が要る。

**持越 doc との差分**: §7 の「既存 client 添付経路に載せる」は経路としては実在するが、**upload flow に非配線 + 画像破棄タイミング**の 2 点で「そのまま載る」わけではない。

---

## 領域 3: prompt の画像記述が images[] にどう効いているか(現状整理)

**現状の images[] = 座標無しの「本文テキスト参照メモの構造化」。視覚領域検出ではない。**

- `IMAGE_REFERENCE_RULES`(`lib/ai/prompts/ocr-extract.ts:110-155`): 対象は **本文中の参照表現**(別冊No.N / 図X / 下図 / 写真等)。出力は `{ key(placeholder "q{sort_key}-img-N")・target・alt・source_ref }`。**座標を求めていない**。冒頭「画像本体の中身解釈はしない(AI は別冊画像を切り出せない)」。
- `COMMON_EXTRACTION_RULES`:
  - L233「画像は抽出しない(本文中の図表参照テキストは残す、images[] に構造化する)」
  - L228「図表参照は本文中にテキストで残す」
- 「プレースホルダ埋め込みについて」= L152-155(`![](key)` 埋め込み不要・対応は target で表現)。
- **効き方**: 上記が組み合わさり、Gemini は「図は本体抽出せず・参照は本文にテキストで残し・構造は images[] に placeholder key で記録」する挙動になる。②-3.5 で 3.5-flash-lite に観測された「図を question_text に ASCII で描く」は、「画像は抽出しない」×「参照は本文に残す」の副作用と読める(モデルが図の情報を本文テキストで代替表現しようとする)。
- **prompt の target 語彙**: `question` / `option_{id}` / `explanation`(L124-129)。**arm B と同じ語彙**(`figure-detect-schema.ts:62-63`)。card 側 enforce 語彙(`question_text`/`option:<id>`/`explanation_text`/`memo`)とは **不一致**(追加ギャップ①)。

**削除時の副作用**: fact-finding では書き換えない方針どおり未検証。「画像は抽出しない」削除で ASCII 描画が減るか増えるかは **実測(Phase2 arm 比較)でしか判定不能**。現物からは方向を断定できない(= 持越 doc §8.2 の懸念は妥当・要実験)。

---

## 領域 4: 失敗時の隔離範囲(現物)

**結論: 現状は完全に all-or-nothing。OCR 側は asset も card_asset_refs も作らないため RESTRICT の中途半端状態は発生しない。**

- **card 保存の tx 境界 = 全 N 件を 1 transaction**: `process.ts:400` `withTenantTx` 内で `saveExtractedCards`(`upload-persistence.ts:16-43`)が **単一 bulk INSERT**(`tx.insert(cards).values(cardRows)`)+ `applyOcrTags` + `bumpExamCardCount` を同 tx。all-or-nothing。
- **OCR card の images**: `cards.images`(jsonb)に `ExtractedImage[]` を **verbatim 格納**(`process.ts:381`)。**card_asset_refs は OCR 経路で一切作られない**。refs の唯一の本番 writer は `handleImages`(`lib/cards/card-field-handlers.ts:203-229`)で、到達は **client sync の `update_field` op 経由のみ**(= 編集/同期路)。OCR upload 路からは呼ばれない。
- **placeholder key は refs に入り得ない**: `handleImages` は `isAssetKey`(厳密 UUIDv4、`validation/card.ts:96-97`)true の entry だけ refs 化。OCR の非 UUID placeholder は **配列にのみ存在**(意図的二重持ち・`schema.ts:851-853`)。同 key は `resolveAssetUrls`/`finalizeAsset`(`assetIdSchema = z.uuid()`)でも弾かれる = **表示上も死んでいる placeholder**。
- **card_asset_refs FK**(`schema.ts:860-879`): `card_id`→cards **cascade** / `asset_id`→assets **restrict** / `user_id`→users cascade。PK `(cardId, fieldKey, ordinal)`。
- **一部失敗の現物挙動(既存 attach saga)**: PUT/finalize 失敗 → `abandonUpload`(`upload.ts:794-822`)が楽観層を巻き戻す(mirror から entry 除去 + Cache delete + Dexie media_assets delete)。server 'reserved' 行は **無害 orphan** として残す(手動掃除)。**refs は 'ready' 到達後の images mutation flush で初めて作られる**(saga は 'uploading' 中 flush を held)ため、失敗 upload は **refs を一切作らない**。
- **parseOcrResponse は 1 発 safeParse で throw**(`ocr.ts:157-163`)+ `cards.length===0` で throw(`ocr.ts:201`)。**per-card / per-image の隔離は皆無**。throw 時 caller は `markFailed` + `notifyOps` + return(`process.ts:321-364`)。card は 1 件も保存されない。

**RESTRICT が「中途半端で削除不能」を作るか(Fable 条件の核心)**:
- refs は「card 削除(cascade で refs 消滅)」or「cards.images 書換(handleImages が delete-all+insert)」で必ず解ける。**恒久的に削除不能な asset は生じない**。
- RESTRICT が効く唯一の場面 = 「まだ card から参照中の asset を GC が消そうとした」= **設計どおりの拒否**(バグではない)。
- 失敗した crop upload は **refs 作成前に abandon** されるため、RESTRICT は abandon 済 asset に対して発火しない。card は「図が減った」状態で健全に残る。

**持越 doc との差分**: §5(B/C/D)は **現状未実装の設計意図**(現物は all-or-nothing)。§6E の "media_assets lookup" は正確には server table `assets`(media_assets は Dexie client mirror の store 名)。

---

## Fable 昇格判定(②-0 設定の条件)

条件: 「N 件作成後、一部 crop の upload 失敗の扱いに **既存パターンで答えられなかった** 場合」→ Fable。

**判定: 既存パターンで答えられる → Opus 継続。**

理由(現物):
- card 作成(server・1 tx)と画像 attach(client・per-image saga)は **別レイヤー**。card は画像成否に依存せず確定する。
- 各 crop の attach は `attachImageToCard` の per-image saga = **個別に abandon 可能**な独立操作。失敗 → asset abandon(refs 未作成)→ RESTRICT 未発火 → **中途半端状態なし**。card は図が減るだけ。
- これは持越 doc §5C「image 破損 → その image 除外・card 無傷」と §5D「K 件取り込めず提示」の失敗形に **既存機構が構造的に合致**。

**唯一の前提(spec で守るべき不変条件)**: crop は **既存 client per-image saga(`attachImageToCard`)経由**で attach すること。もし spec が「card + asset + refs を server 側 1 tx で atomic に作る」新経路を発明する場合のみ再評価が要る(ただし refs は ready+owned asset にしか張れないため、その場合も未 upload asset の ref は原理的に作れない)。→ **自然な設計(持越 doc §7)を採る限り Fable 不要**。

---

## 現物確認で判明した追加ギャップ(持越 doc に無い)

**① target 語彙の写像が未定義(load-bearing)**
- 検出側語彙: `question` / `option_{id}` / `explanation`(arm B・現 prompt)。
- card attach 側 enforce 語彙(UUID key 時): `question_text` / `explanation_text` / `memo` / `option:<id>`(`validation/card.ts:114-132`)。
- crop が UUID key を持つ瞬間、`imageEntrySchema` が card 語彙を **強制**する。不一致 → `handleImages` が 'failed' → images mutation ごと失敗。→ **検出 target → card target の写像が必須**。②-0 も明示的に「DB 保存側 mapping は ②-4 持越」と記載(`figure-detect-schema.ts:5-7`)。
- 併せて持越 doc §3「ambiguous target 許容」は現 `imageEntrySchema` に該当 slot が無く、**schema 変更が要る**(`memo` へ逃がす等は spec 判断)。

**② 複数ページ/複数ファイルの provenance が未解決**
- upload は複数 image/PDF を **1 回の Gemini call に全部 inline**(`process.ts:284-289` + `gemini.ts:99-104`)。返る cards に **どのページ/ファイル由来かの情報は無い**。
- arm B の `figure_regions`(box_2d/target/label)にも **source 画像/ページ index が無い**(単一画像前提で検証・`ocr-compare` は box_2d を single-image 粒度と明記)。
- → 複数ページ upload で crop するには「その box_2d がどの入力画像上か」を解決する field/機構が追加で要る。

**③ bbox(座標)の保存先が存在しない**
- 持越 doc §2「bbox を捨てず保持(切り直し用)」。現物に座標を置ける列/field は無い: `card_asset_refs`(cardId/assetId/userId/fieldKey/ordinal)・`assets`(width/height はあるが source 座標ではない)・`cards.images` entry(key/target/alt/source_ref)いずれも座標 field なし。→ **net-new 保存先**(images entry に box_2d 追加 / assets に source_box 追加 / refs に座標追加 のいずれか)が要る。

---

## spec に向けた未決点(判断は OT/次フェーズ)

1. crop をどのタイミングで行うか(upload flow 内・navigation 前 / result ページで画像再取得機構 / 別)。**領域1・2 の中核。**
2. PDF の figure crop をどうするか(client rasterizer 不在。画像のみ対象に絞る? PDF は rasterize 導入?)。
3. box_2d を prompt+schema+pipeline+zod にどう net-new で足すか(nullable 契約・per-element safeParse = 持越 doc §2A/§5B)。
4. 検出 target → card target 語彙の写像 + ambiguous の受け皿。
5. 複数ページ provenance の解決。
6. bbox 保存先。
7. prompt 3 箇所書換 → images[]/ASCII 挙動は実測(Phase2 arm 比較)で確認。

---

## 出典サマリ(主要 file:line)

- upload flow: `app/(app)/app/upload/_components/upload-form.tsx:243-257,480-493` / `_actions/process.ts:97,284-289,313,369-407,497-518` / `_lib/constants.ts:15-16`
- persistence: `_actions/upload-persistence.ts:16-43,64-79,116-132`
- pipeline: `lib/ai/ocr.ts:150-165,200-201,225` / `lib/ai/clients/gemini.ts:34,95-104`
- prompt/schema: `lib/ai/prompts/ocr-extract.ts:110-155,205-236` / `lib/ai/schemas/ocr-response.ts:21-26,76-89`
- attach saga: `lib/media/upload.ts:206,302-334,529-778,794-822` / `app/(app)/app/exams/[id]/_actions/asset-actions.ts:84-121,129-210`
- refs/schema: `lib/cards/card-field-handlers.ts:171-232` / `lib/validation/card.ts:96-134` / `lib/db/schema.ts:375-421,821-847,860-879`
- box_2d 実験: `scripts/ai/lib/figure-detect-schema.ts` / `scripts/ai/lib/box-overlay.ts`(本番 lib/app/components に box_2d/bbox なし)
</content>
</invoke>
