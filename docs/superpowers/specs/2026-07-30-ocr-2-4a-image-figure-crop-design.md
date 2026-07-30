# ②-4a 画像入稿の図版切り出し 設計 spec

- 日付: 2026-07-30
- 位置付け: ②-4 の本体を **画像入稿のみ**にスコープした ②-4a の設計正本。PDF rasterize / Files API / page 固有メタは ②-4b。
- 前提資料: fact-finding(`docs/audit/2026-07-29-ocr-2-4-factfinding.md`)/ 実測 exp1-6(`scripts/ai/_ocr-*.ts`・出力は gitignored out/)/ 持越統合(`docs/audit/2026-07-29-ocr-2-4-carryover-and-design-notes.md`)。
- モデル: Opus。実装・実 API・commit は spec 承認(凍結)後。
- **状態: 凍結(2026-07-30 OT レビュー反映済)**。決定 = sharp direct 化 / padding 6% / 回転入力の明示除外(§12 に反映)。

---

## 0. スコープと非スコープ

**やること(②-4a)**: 画像入稿(jpg/png/webp)に対し、1 回の generateContent でテキスト抽出 + 図版検出(box_2d)を同時実行し、検出図版を server 側で切り出して card に asset として紐付ける。upload→OCR→crop→全保存→完了提示を**同期一発**で行う。

**やらないこと(②-4b 以降へ)**: PDF 入稿の選択的 rasterize / Google Files API / page 固有メタ(page box・rotation・rasterizer 名+version)。account quota は ②-5。図の per-option 分割・警告バッジ/除外一覧 UI/再試行導線は実害観測後。

**境界の確保(②-4a で構造だけ用意)**: source 種別(image/pdf)・page 概念・rasterizer メタを ②-4b が足せる schema 境界を残す(§4 / §6)。

---

## 1. アーキテクチャ決定 — server 側 crop 【sharp 承認済】

**決定: crop は server 側で行う。** client が source 画像を R2 に presigned PUT で保存 → server が processUpload 内で R2 から source を取得し、Gemini 送信と crop の**両方に同一 R2 バイト**を使う。

**理由**:
- ブリーフ要件「同期一発完了・途中状態を見せない」= 単一 server オペレーション(現 `processUpload` の延長)で upload→OCR→crop→保存→完了を閉じる。client 側 crop だと「card 作成後に crop pending」という中間状態が出る。
- 「deterministic asset key + 冪等 ledger」= server が atomic に claim/保存を保証する形が自然。
- fact-finding のギャップ「client は crop 時点で source 画像を保持しない(navigation で破棄)」を、R2 保存 + server crop が構造的に解消。
- **§3 の座標契約**「crop 元 = Gemini に送ったバイトと同一」が、R2 の同一オブジェクトを両用途に使うことで自明に満たされる。

**これは持越 §7「client-side crop で server decoder を回避」の反転。** server crop には画像 decode/crop ライブラリが要る。

> **OT 承認済(2026-07-30)**: server 側 crop に `sharp` を採用。`pnpm why sharp` で **sharp@0.35.3 が next@16.2.11 の transitive として既にツリーに存在**することを確認 → これは新規ライブラリ追加ではなく **transitive → direct 化**(自コードが直接 import するものを package.json に宣言し、上流 bump による drift 事故を防ぐ。deps matrix の eslint-plugin-react-hooks と同型)。`package.json` dependencies に `"sharp": "0.35.3"` を **exact pin**(caret 不使用)。next 側が将来 sharp を bump した場合の lockstep は deps sprint で扱う。**client-side crop 再設計は不要**。package.json/lockfile への追加 + dep gates(`pnpm install` → 以降 `--frozen-lockfile`/typecheck/build)は **plan の先頭 task**(§実装は凍結後)。

---

## 2. 冪等性(結果キャッシュでは不十分)

**upload operation ledger** 表を新設し、原子的な冪等 claim を行う。

- 新表 `upload_operations`: `id (uuid pk)`, `user_id (uuid, fk cascade)`, `idempotency_key (text)`, `input_fingerprint (text)`, `status ('claimed'|'completed'|'failed')`, `source_document_id (uuid, nullable)`, `created_at`, `completed_at`。**UNIQUE(user_id, idempotency_key)**。
- `idempotency_key`: client が **upload 操作単位**(全ファイルで 1 個)で発行(crypto.randomUUID)。
- `input_fingerprint`: 全 source ファイルの content hash を sorted 連結 + 主要 params(exam target・model・pipeline_version)を SHA-256。
- **claim**: `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING` を 1 tx で。行が取れた=自分が claim 成功。取れない=既存 row を SELECT して分岐:
  - 既存 `completed` かつ fingerprint 一致 → 既存結果を返す(二重 Gemini なし)。
  - 既存 `claimed`(処理中)かつ fingerprint 一致 → **二重 Gemini 呼び出しを抑止**し「処理中」を返す(競合再送)。
  - fingerprint **不一致**(同一 key・異入力)→ **拒否**(明示エラー。key 使い回し事故を検出)。
  - 既存 `failed` → **同一 key で再試行可**(fingerprint 一致時のみ claim を再取得可能にする。§2.1)。
- **retry 規則**: `failed` は再試行可(同 key・同 fingerprint)。`claimed` のまま孤立した処理(server crash 等)は TTL 経過(例 15 分)で `failed` 相当に降格して再試行可能にする(orphan claim の回収)。

---

## 3. 座標契約(裏取り済 + 本 spec の不変条件)【本節が今回の修正対象】

### 3.1 軸別正規化(実測裏取り済)

box_2d = `[y_min, x_min, y_max, x_max]`、各軸を 0-1000 に**独立**正規化(Gemini 規約)。復元式:

```
x_px = x_1000 / 1000 × decoded_width
y_px = y_1000 / 1000 × decoded_height
```

- x は幅・y は高さで**軸別**(「アスペクト比一括スケール」ではない)。
- **裏取り**(readonly・新規 API なし):
  - 変換コード `scripts/ai/lib/box-overlay.ts:10-52`(`left=xMin/10, top=yMin/10, width=(xMax-xMin)/10, height=(yMax-yMin)/10` = %)。適用 `scripts/ai/ocr-box2d-viz.ts:97-100` + container `:118-119,:126-127`(`position:relative` / `img{width:100%}`)。CSS 意味論で「left/width % = 幅基準・top/height % = 高さ基準」ゆえ軸別が確定。
  - 代表例(page1 box `[211,298,362,729]`・decoded 1653×2339px)→ x=[492.6→1205.0]px / y=[493.5→846.7]px。overlay で赤枠が図に密着。
  - 反証: y を幅で正規化すると y=[348.8→598.5]px でずれ図に乗らない → 単一スケールは反証・軸別のみ整合。
  - 例外: exp1-5 の全 box が [0,1000] 正面積(異常 box 実データ皆無)。

### 3.2 crop 元の不変条件【修正1】

**crop 元は「Gemini に送ったバイトと同一の画像」である。**

- **画像入稿(②-4a)**: Gemini に送ったバイト**そのもの**(= R2 保存の source バイト)を保持し、それを crop する。**変換・再レンダリングは行わない**。
- **PDF 入稿(②-4b)**: PDF はピクセルを持たないため crop できない。したがって **PDF に限り**、「Gemini が見た表示」と一致する画像を得るためにページレンダリングを行い、それを保持して crop 元とする。**埋め込み画像の直接抽出は、回転・座標変換の適用漏れにより「Gemini が見た表示」と乖離するため禁止**。この「抽出禁止・レンダリング統一」は **PDF 入稿固有の規則**であり、画像入稿には適用しない。
- PDF レンダリングは **Gemini 送信前ではなく、座標が返った後に図が存在するページのみ**行う(選択的 rasterize・②-4b)。

### 3.3 座標基準と EXIF 前提【修正2】

**座標基準は crop 元バイトを decode した寸法(width / height)とする。**

- **前提**: client 側の圧縮処理(browser-image-compression)が EXIF orientation をピクセルデータに焼き込んだバイトを出力しているため、Gemini が見るバイトと crop 元バイトは**同一かつ正立**している。EXIF の解釈差による座標のずれは構造的に発生しない。
- **この前提が破れた場合(圧縮処理の変更等)、座標契約が壊れる。**将来変更で気づけるよう前提を明記する(アプリ側で EXIF 適用状態を判断しないのは、同一バイトを扱う以上不要だから)。
- finalize 時に **decoded 寸法を保存**し、その寸法で crop する(前提が破れても width/height の取り違えだけは起きない構造)。

### 3.4 裏取り結果の解釈(座標品質 ≠ 切り出し品質)

- exp5 の一部で観測された「粗い座標」(run 間で辺が数十/1000 揺れる・キャプション取り込みの有無)は、**変換式のずれではなく Gemini の検出品質の run 間変動**である(§3.1 の式は正しく座標を引ける)。
- 「**座標は正しく引ける**」と「**切り出しが常に綺麗**」は別問題。後者は §7 の**既定の防御 3 点**(padding / clamp / 原 bbox 保持による再 crop 余地)で受ける。品質完璧化は本 spec の目的ではない。

### 3.5 回転入力の扱い(exp7 は gate にしない・入口で明示除外)

- 実測サンプルは全て縦向き portrait・PNG(EXIF 無)。**横向き/回転スキャン・EXIF orientation≠1 の JPEG は未検証**。
- **②-4a は portrait/PNG 前提で進める。exp7 は実装前 gate にしない。feature flag も使わない。** 代わりに**入口での明示的除外**とする:
  - **EXIF orientation ≠ 1 の source は、その source の図版検出をスキップ**する(カードの**テキスト抽出は通常どおり実行**)。
  - 除外件数に「**向き未対応**」の理由を追加(§8.2)。
- 理由: flag で「動くかもしれない状態」を作るより、未検証入力を明示除外して可視化する方が **loud failure over silent green** に合致する。exp7 が通ったらこの除外を外す、という順序が clean。
- **副次的検出器**: client 圧縮が EXIF を焼き込む前提(§3.3)が正しければ、orientation は常に 1 になるはず。ゆえに**この除外分岐の発火自体が §3.3 前提の破綻検出器**になる(意図的)。
- **exp7(follow-up)**: 回転 JPEG を browser-image-compression に通した出力で「Gemini 送信バイト = crop 元バイト = 正立・decoded 寸法一致」を裏取り → 通れば上記除外を外す。§3.3 前提の実証。

---

## 4. schema / 検出

### 4.1 統合 schema(text + figure_regions)

本番 discover schema(`buildDiscoverResponseJsonSchema`)を**触らず**、各 card に `figure_regions` を optional 注入した探索 schema を ②-4a 用に用意する(exp5 で欠落ゼロを実測)。figure_regions 要素:

- `source_id: string`(必須。client 発行・§4.2)
- `box_2d: [number,number,number,number] | null`(**nullable 必須**。null = 確定不可・**推測生成禁止**。optional にしない=「返し忘れ」と「確定不可」を区別)
- `target: string`(`question` / `option_{id}` / `explanation`。§8 で保存語彙へ変換)
- `label: string`(optional)
- ②-4b 予約: `page`(image では省略/1・PDF で使用)

card 側 `required` に figure_regions を追加しない(図なし card を壊さない)。prompt は本番 `buildDiscoverPrompt()` + 図版検出 suffix(`buildArmBPromptSuffix` 系)を**探索用コピー**で組む(本番 prompt file 不触)。

### 4.2 source_id(client 発行・送信順 index 不採用)

- client が source ファイルごとに `source_id`(短い安定ラベル、例 `src-<uuid4 先頭8>`)を発行。
- Gemini へは parts を **`[text "source_id=<id>", image, text "source_id=<id>", image, …, prompt]`** の順で interleave し、各画像の直前に source_id ラベルを置く。Gemini に figure_regions の `source_id` へ**書き写させる**。
- **送信順 index は採用しない**(Gemini の並べ替え・欠落に脆弱)。source_id ↔ source_asset の対応は server が claim 時に保持。

### 4.3 要素単位 safeParse(隔離)

- 親 schema で `figure_regions: z.array(...)` / `images: z.array(...)` を**一括検証しない**。**入力境界用と正規化後用で schema を分け**、`figure_regions[]` / `images[]` を**要素ごとに safeParse**して壊れた要素だけ落とす(図 1 枚の破損を card に波及させない)。
- 隔離原則(architecture.md §10 / fact-finding §5C)準拠: card 本体の question_text/options 破損 → その card 除外 / figure 1 件破損 → その figure のみ除外 / box_2d null → その figure は crop せず「座標 null」として除外計上(§8)。

---

## 5. source asset 保存

### 5.1 新表 `source_assets`(1 upload : N ファイル)

現 `source_documents` は 1 upload 1 行(複数ファイルでも 1 行)ゆえ、per-file の bytes/dims/crop 座標を持てない。**新表**を設ける:

- `source_assets`: `id (uuid pk)`, `user_id (uuid fk cascade)`, `source_document_id (uuid fk cascade)`, `source_id (text; client 発行ラベル)`, `object_key (text unique)`, `mime (text)`, `content_hash (text)`, `width (int)`, `height (int)`, `status ('reserved'|'ready'|'deleting')`, `original_filename (text)`, `source_kind ('image')`, `created_at`。
- ②-4b 予約列(②-4a では未使用/NULL): `page_count`, `rotation`, `rasterizer`(PDF ページ由来 source を将来ここに足す境界)。
- `source_kind` で image/pdf を将来判別(②-4a は 'image' 固定)。

### 5.2 保存フロー(既存経路流用)

- client: 各画像を **既存の圧縮(browser-image-compression)**で source バイト化 → content_hash + decoded 寸法(createImageBitmap)を算出 → **reserve→presigned PUT→finalize**(§既存 `reserveAsset`/`finalizeAsset` と同型の source 版 action)で R2 保存。finalize は R2 HEAD 検証 + byteSize 一致で 'ready'。
- upload/source 紐付け: source_assets.source_document_id で upload と結び、source_id で Gemini 応答と結ぶ。
- 元ファイル名・MIME・content hash を保持(**②-5 文書ライブラリ昇格の余地**)。

### 5.3 GDPR 削除カスケード

- `source_assets.user_id` cascade + `source_document_id` cascade。既存 GDPR 退会経路(RLS/tenant 表 count0 検証・`docs/ops/rls-p2-stg-runbook.md`)に source_assets の R2 オブジェクト削除を追加(assets の GC/削除経路と同型)。
- crop 由来の asset は既存 `assets` + `card_asset_refs` に載るため既存カスケードで消える。source_assets の R2 実体削除を退会・source 削除時に確実に行う。

### 5.4 orphan GC(未 finalize / 失敗 upload)

- reserve したが finalize されない source_assets('reserved' のまま TTL 経過)、および crop 失敗で参照ゼロになった crop asset を、既存 image-GC(`scripts/gc-image-assets.ts` / asset-state)経路に載せて回収する。**参照ゼロ + 一定期間**で 'deleting'→R2 削除(既存 reconciler 規律・W1 deploy 後実行の運用不変条件を踏襲)。

---

## 6. crop / 保存

### 6.1 padding / clamp(固定規則)

- **padding = 各辺 6%**(0-1000 空間で `y_min-=60, x_min-=60, y_max+=60, x_max+=60`)。
  - **なぜ 6%(揺れ実測 ~3.5% より広く)**: exp6 の run 間揺れ ~3.5% とは**別に**、box2d 可視化の目視で「枠が図に密着しすぎて円グラフの出所表記・軸ラベルが枠外に落ちる」実欠けが観測された。揺れの実測値に張り付けた 4% では不足。**非対称性で判断** — 余白過多の実害はほぼゼロ(やや大きい画像がカードに載るだけ)/ 切れは情報欠落で回復不能。よって余裕を持たせる側に倒す。監査メタに原 bbox を保持するため実データを見て後から狭められる = **広めから始めて狭める順序**が正しい。
- **clamp**: padding 後に各値を **[0,1000] にクランプ**(ページ端超えを抑止)→ decoded 寸法で px 化 → 整数 px に丸め。
- 退化(clamp 後に幅/高さ ≤ 0)は crop せず「crop 失敗」計上。

### 6.2 deterministic asset key + ref 重複防止

- crop asset id = **UUIDv5**(固定 namespace, `source_content_hash + clamp後box + padding率 + pipeline_version + cardId + target + ordinal`)。→ 二重実行でも同一 id。
- 保存: server が crop バイト(webp 再エンコード)を R2 に **server PUT**(§`lib/storage/r2.ts` に server putObject を追加。既存は presigned/HEAD/DELETE のみ)→ `assets` 行を **`INSERT … ON CONFLICT (id) DO NOTHING`**。
- card 紐付け: 既存 `handleImages` 相当の projection で `card_asset_refs`(PK `cardId, fieldKey, ordinal`)。**二重実行でも asset 2 個・refs 2 本にならない**(id 決定性 + refs PK)。
- **crop asset は UUID key** ゆえ既存 `imageEntrySchema`/`isAssetKey`/`resolveAssetUrls` にそのまま乗る(placeholder は消える。fact-finding §6E)。

### 6.3 監査メタ

crop ごとに保持(assets の付随 or 監査列/JSON): **原 bbox(0-1000)・padding 率・clamp 後 bbox・crop 寸法(px)・source_id・detect target・pipeline_version**。→ 後から padding 再調整で切り直せる(§3.4 の防御 3 点目)。

---

## 7. フロー / 制限

### 7.1 同期一発完了

`processUpload`(延長)を単一 server オペレーションとして:
1. client 事前: 圧縮 → source_assets を R2 reserve/PUT/finalize(§5.2)+ idempotency_key 発行。
2. server: 冪等 claim(§2)→ R2 から source 取得 → parts 組み立て(source_id interleave)→ Gemini 1 回(統合 schema)。
3. server: 要素 safeParse → cards bulk INSERT(既存 `saveExtractedCards`・1 tx)→ 各有効 figure を crop→保存→card_asset_refs。
4. server: `upload_operations.status` を completed / completed_with_warnings、`source_documents.status` を completed。**途中状態(card だけ先出し)を見せない**。完了提示で結果 + 除外件数(§8)を返す。

### 7.2 入口制限(運用安全・quota ではない)

- **1 ファイルサイズ上限** / **1 upload 合計サイズ上限**を設ける(storage/転送の運用安全)。**具体値は実測後に設定可能**とし spec 起草を阻害しない。初期値は**既存 upload flow の client cap を出発点**にする(現行 = 合計 `TOTAL_UPLOAD_LIMIT_MB` / 1画像圧縮後 `MAX_IMAGE_FILE_MB` = `app/(app)/app/upload/_lib/constants.ts`)。R2 保存に移行するぶん緩められるかは実測で判断。account quota ではない(quota は ②-5)。

### 7.3 処理後制限と採用順

- 図の数が閾値(例: 1 upload あたり crop 上限 N・実装時確定)を超えたら**部分採用** + `completed_with_warnings`。
- **採用順は固定**: **source 入力順 → 物理 page 順 → y_min → x_min**。「上位 N」等の曖昧表現は使わない。超過ぶんは「制限超過」として除外計上(§8)。

---

## 8. target / 提示

### 8.1 target 語彙変換層

- 検出 `question` → 保存 `question_text` / `explanation` → `explanation_text` / `option_{id}` → `option:<id>`(既存 `imageEntrySchema` 語彙、fact-finding 追加ギャップ①)。
- **ambiguous / 未マッピング target の受け皿** = `question_text` に寄せる(安全な上位集合)。検出 target は監査メタに残す(§6.3)。
- **確定済み**: 選択肢=図の問(問10 型)は検出が 1 枠 question で返る(3 run 一貫)→ そのまま question に付ける。per-option 分割はしない。

### 8.2 除外理由別の件数提示

完了時に**理由を区別して**件数提示(loud failure over silent zero):

- 「カード N 件 / M 件作成できず」
- 図版: 「K 件取り込み / 除外内訳: **座標 null** a 件 / **source_id 不正** b 件 / **crop 失敗** c 件 / **制限超過** d 件 / **向き未対応**(EXIF orientation≠1・§3.5) e 件」

②-4a は**件数提示まで**。警告バッジ/除外一覧 UI/再試行導線は実害観測後(②-4b 以降)。

---

## 9. 確定済み設計判断(理由つき)

- **選択肢=図の問は 1 枠 question で許容**(3 run 一貫の実測・per-option 分割は将来のユーザー操作に委ねる)。
- **冗長な表の枠取りは対応しない**(選択肢表は options[] に完全分解済・prompt 抑制文言も追加しない。exp5 で確認)。
- **deskew 前処理なし**。**crop 元統一の不変条件(§3.2)は PDF 入稿固有の規則**であり、画像入稿では「Gemini 送信バイト=crop 元」を変換なしで満たす【修正1】。
- **全ファイルを 1 回の generateContent に同一コンテキストで渡す**(exp5 で欠落ゼロ・text/figure 相互作用でデータ表が MD テキストへ回る好挙動も確認)。
- **account quota は ②-5**。
- **server 側 crop 採用 + sharp direct 化**(§1・OT 承認済。transitive→direct・exact pin 0.35.3)。
- **padding 6%(広めから始めて狭める)**(§6.1・非対称性: 切れは回復不能)。
- **回転入力(EXIF≠1)は入口で明示除外**(§3.5・図版検出のみスキップ / テキスト抽出は実行 / §3.3 前提の破綻検出器を兼ねる)。

---

## 10. テスト方針(概要・詳細は plan)

- **AI は mock 必須**(CLAUDE.md)。統合 schema の parse/隔離/変換は Gemini mock 応答(欠落・box_2d null・source_id 不正・target 各種・要素破損)で厚く。
- 座標変換(box_2d 0-1000 → padding → clamp → px)は pure 関数で単体 test(境界・退化・端クランプ)。
- deterministic key(UUIDv5)と ON CONFLICT の**二重実行冪等**を test(asset 1 個・refs 1 本)。
- 冪等 ledger(claim/同 key 異 fingerprint 拒否/処理中抑止/failed 再試行)を実 PG(iso)で。
- 除外件数提示の理由別集計を test。
- **実 API 比較(exp7 = 回転 JPEG 座標裏取り)は OT 合図時のみ**(§3.5)。crop 結果の目視は既存 overlay 手法を流用。

---

## 11. ②-4b 境界(本 spec で確保する拡張点)

- schema: figure_regions の `page`(image で省略)。
- source_assets: `source_kind`('pdf' 追加)・予約列 `page_count`/`rotation`/`rasterizer`。
- crop 元不変条件(§3.2)は PDF レンダリング(選択的 rasterize・座標返却後・図のあるページのみ)を PDF 節として追記できる形。
- Files API / page 固有メタは ②-4b で別 spec。

---

## 12. OT レビュー結果(2026-07-30・凍結)

1. **sharp** = 承認(§1)。transitive→direct 化・exact pin `0.35.3`・client-side crop 再設計は不要。
2. **既定案** = source_assets 新表 / 冪等 ledger 新表 / ambiguous→question_text / 入口制限は既存 cap 起点 を承認。**padding は 4%→6% に変更**(§6.1・広めから始めて狭める)。
3. **exp7** = 実装前 gate に**しない**・feature flag も**使わない**。回転入力(EXIF≠1)は**入口で明示除外**(§3.5・§8.2 に「向き未対応」追加)。exp7 通過で除外を外す。
4. **fact-finding doc** = commit(記録として残す)。

→ 本 spec は凍結。次は writing-plans(task 分割: source 保存基盤 / 冪等 ledger / crop 本体 / 提示 + commit 分離方針)。

---

## 付録: 裏取りに使った file:line

- 座標変換: `scripts/ai/lib/box-overlay.ts:10-52` / 適用 `scripts/ai/ocr-box2d-viz.ts:97-100,118-119,126-127` / 同型可視化 `scripts/ai/_ocr-exp5-viz.ts`。
- 統合 schema 実測: `scripts/ai/_ocr-pdf-integrated-probe.ts`(exp5)/ 生データ `out/exp5-cards.json`・`out/exp5-reconcile.md`。
- 既存経路: source/asset = `app/(app)/app/exams/[id]/_actions/asset-actions.ts:84-210` / handleImages = `lib/cards/card-field-handlers.ts:171-232` / imageEntrySchema = `lib/validation/card.ts:96-134` / schema = `lib/db/schema.ts:378-421(source_documents),821-847(assets),860-879(card_asset_refs)` / OCR orchestration = `app/(app)/app/upload/_actions/process.ts`。
</content>
