# ②-4b(PDF 対応)fact-finding — 現物確定

**日付**: 2026-08-07 / **範囲**: 調査のみ(実装・ライブラリ選定・方式決定はしない)
**基準 commit**: `9c02b05`(develop / clean)
**問い**: PDF の拒否位置 / rasterize をどこでやるかの材料 / source 非保持の軸との関係 / page 概念の現状

---

## 0. 先に訂正すべき前提

kickoff の「現行の枚数上限 10 枚」は**現物と一致しない**。10 は別軸の定数:

| 定数 | 値 | 意味 | 位置 |
|---|---|---|---|
| `OCR_MAX_PAGES` | **40** | 1 upload の合計ページ(= 画像枚数)上限。client / server 両方が enforce | `lib/ai/ocr-limits.ts:4` |
| `MAX_PDF_PAGES` | **40** | PDF **1 file** の page 数上限(per-file 軸)。現在 UI にのみ存在 | `_lib/constants.ts:22` |
| `imagesSchema.max(10)` | **10** | **1 card に添付できる画像数**。PDF/ページとは無関係(figure 添付の cap) | `lib/validation/card.ts:134` |
| `MAX_IMAGES_PER_CARD` | 10 | 同上の手動編集経路側 | `lib/media/upload.ts:66` |

以降 §2「枚数上限が PDF page 数にどう効くか」は **40** を前提に書く。

---

## 1. 現在の拒否位置

### 1.1 hard-reject は 2 層(実効の防衛線は server)

| 層 | 位置 | 判定 | 文言 |
|---|---|---|---|
| **client pre-flight** | `_components/upload-form.tsx:466-472` | `entries.some(e => e.kind === 'pdf')` で submit 前に中断 | 「PDF は現在このアップロードでは対応していません(画像のみ対応)。PDF を削除するか、画像のみで投入してください。」 |
| **server(実効)** | `_actions/submit-upload.ts:158-163` | 各 file の先頭バイトを `sniffMagicBytes` にかけ、`null` なら全体 reject | 「対応していない画像形式です (PNG / JPEG / WebP のみ)」 |
| (advisory) | `upload-form.tsx:665` | `accept="image/*"` — file dialog の filter のみ。D&D / 一部 OS は素通り | — |

- `sniffMagicBytes`(`_lib/source-image-verify.ts:37-68`)の allowlist は **`image/png` / `image/jpeg` / `image/webp` の 3 つのみ**。`%PDF` は entry が無いので `null` → reject。
- client 申告 mime は server で一切信用していない(`submit-upload.ts:155` コメント)。ゆえに **client を改造しても PDF は到達しない**。
- 1 件でも PDF が混ざると **upload 全体**が弾かれる(部分受理はしない)。

### 1.2 upload UI に PDF 対応を示唆する copy は残っていない(現物確認済)

I-1 fix(`551f514` [reviewed])で `accept` と copy 3 箇所が是正済み。今の全文:

| 位置 | 現在の文言 | 判定 |
|---|---|---|
| `upload-form.tsx:657` | 「画像 (JPG / PNG / HEIC 等) は自動で圧縮されます。 **PDF は現在未対応です。**」 | 対応を示唆しない(明示的に未対応) |
| `page.tsx:68` | 「**試験問題の画像**を選択すると、 AI が問題を抽出します。」 | 画像のみ。PDF に言及なし |
| `upload-form.tsx:659` | 「合計 40 枚・サイズ上限 4 MB まで。」 | 「ページ」でなく「枚」。PDF 前提の per-file ページ上限の記述は削除済 |

repo 全体 grep(`*.tsx`/`*.ts`、test 除く)でユーザーに見える PDF 文字列は上記 + 以下の 2 つだけ。**どちらも到達不能な dead copy**(client の PDF entry が作られる経路が `accept` で塞がれても D&D で作られうる点は残るため、正確には「到達しにくい」):

- `upload-form.tsx:266` 「PDF が N ページ (1 ファイル上限 40 ページ)」— per-file 上限超過表示
- `upload-form.tsx:297` 「PDF 解析に失敗しました」/ `:725` 一覧サムネの「PDF」プレースホルダ

### 1.3 PDF 機構は ②-4b 向けに意図的に残置されている

`551f514` の commit message が明記: 「PDF 機構(解析 / per-file 上限 / reject backstop)は ②-4b 向けに不変」。現存する残置物:

- `_lib/pdf-page-count.ts` — pdf-lib 等の dep 追加を避け、`/Type /Page` 出現数を正規表現で数える近似(暗号化 / object stream 圧縮 PDF では不正確、と自己申告)
- `upload-form.tsx` の `FileEntry` に `kind: 'pdf'` 分岐 3 種(`:65-67`)+ `processPdf`(`:252-303`)+ `handleAdd` の PDF 分岐(`:330-338`)
- `MAX_PDF_PAGES`(`constants.ts:22`)
- `upload-form.test.tsx` に PDF 経由の合計ページ上限テストが複数(`:165-190` 他)— **`mockPdfPageCount` で PDF entry を作って 40 ページ境界を pin している**。②-4b で PDF entry の意味が変われば影響する

### 1.4 legacy `_actions/process.ts` は PDF を受ける実装のまま残っている

- `'use server'` 付きで生存(`process.ts:1`)。`processUpload` は **`upload-form.tsx` から呼ばれていない**(import は型 2 つのみ・`:27-30`)が、Server Action としては登録され続ける
- 中身は PDF 対応:`:168-176` で `application/pdf` を `pdfPageCount` にかけ、`:197-198` で `fileType: 'pdf'` を決定、`:288` で `f.type` をそのまま Gemini の mimeType に渡す(= **rasterize せず PDF を丸ごと Gemini に inline 送信**していた)
- `tests/contract/upload-result.contract.test.ts` がまだ `processUpload` を直接呼んで wire contract を pin している
- **旧経路撤去(S-5)は行われたが、この file 自体は削除されていない**

---

## 2. rasterize をどこでやるかの材料

### 2-A. サーバー側の場合

#### A-1. 現行 upload 経路の実際の並び

```
[client] handleAdd → processImage(browser-image-compression, webp 固定)
   ↓ FormData('files', 圧縮済 File × N)
[server action] submitUpload                          ← app/(app)/app/upload/_actions/submit-upload.ts
   1. validateSubmitInput                             :100-168
      - 件数 ≤ OCR_MAX_PAGES(40)                      :135
      - per-file ≤ MAX_ASSET_BYTES(5 MiB)             :144
      - 合計 ≤ TOTAL_UPLOAD_LIMIT_BYTES(4 MB)         :147
      - ★ sniffMagicBytes で PNG/JPEG/WebP 以外 reject :158-163   ← PDF はここで死ぬ
   2. withTenantTx: submitUploadTx(sync tx)          :173-360
      - advisory xact lock / 冪等 replay / live-op gate + supersede
      - source_documents INSERT(fileType: 'image' ハードコード :319、pagesTotal = files.length :323)
      - upload_operations INSERT(expectedSourceCount = files.length :341、lease 発行 :342)
   3. 応答('accepted')を返す
   4. after(() => runUploadPipeline(...))            :465-482
[after()] runUploadPipeline                           ← _lib/upload-pipeline.ts:133
      runOcrPhase                                     :183
        a. 開始 CAS(op がまだ自分のものか)            :203
        b. ★ decode 検証 + source_id 採番(1 枚ずつ逐次) :215-258
             verifyImageBytes(sharp) / randomUUID() / base64 化
        c. 残余予算チェック                            :270
        d. Gemini 1 call(source_id interleaved parts) :276-295
        e. normalize → prepared_payload commit(CAS)   :307-331
        f. runCropPhase(逐次・sharp crop → R2 PUT)     :334
        g. runPublishPhase(1 tx)                      :345
```

#### A-2. rasterize が入りうる位置は 2 つだけ

| 位置 | 何が起きるか | 波及 |
|---|---|---|
| **①`validateSubmitInput` の magic-byte 検証(`:158`)の直前 or 同所** | PDF を許可 → sync tx **前**に rasterize する必要が出る。sync tx は `files.length` を `pagesTotal` / `expectedSourceCount` に確定させる(`:323,341`)ので、**ページ数はここで確定していなければならない** | sync tx が重くなる(action は「sync tx 直後に応答」設計 = `spec §5`)。rasterize 時間が応答待ちに乗る |
| **②`runOcrPhase` の decode ループ(`:220-257`)の中 / 直前** | after() 側 = 応答後。時間予算 `deadlineAt` 内で回せる | `expectedSourceCount` / `pagesTotal` が sync tx で**既に確定済**なので、ページ数が rasterize 後に判明する設計と衝突する。`expectedSourceCount` は「publish 時の記帳の独立 oracle」(`schema.ts:931-933`、`publish-prepared.ts:135,234`)ゆえ勝手に書き換えられない |

→ **どちらを採っても既存の「受領枚数 manifest を sync tx で immutable に確定する」不変条件に触る。** これが server 側 rasterize の構造的な主論点。

#### A-3. 時間予算とメモリの現物

**時間**

| 値 | 位置 | 備考 |
|---|---|---|
| `maxDuration = 720`(秒) | `app/(app)/app/upload/page.tsx:23` | route segment config。pin test あり(`submit-upload.test.ts:459-492`) |
| `UPLOAD_PIPELINE_BUDGET_MS = 660_000` | `constants.ts:57` | 起点 = **action 入口時刻**。maxDuration − 60s |
| `LEASE_TTL_MS = 900_000`(15 分) | `constants.ts:37` | maxDuration + margin 180s ≤ この値 が pin されている |
| `GEMINI_TIMEOUT_MS` | 220s | 1 call の最悪値。retry 3 attempts で最悪 685〜780s(`constants.ts:44-53` の算術) |
| `CROP_MIN_REMAINING_MS` | 5s | crop 1 件を新たに始めるための最低残余 |
| `vercel.json` | — | upload 経路の `functions` 個別指定は**無い**(webhook 2 本 60s のみ) |

- **`constants.ts:56` と `:70` が明記: 時間予算の値は「暫定 — cutover 後の実測で見直す」**(2026-08-02 OT 方針)。phase 別所要時間は `logger.warn({event:'upload.pipeline.phase'})` で出ている(`upload-pipeline.ts:704`)
- 唯一の実測: **画像 5 枚 → 11 cards、~1-2 分**(`sessions/2026-08-02-ocr-2-4a-cutover-smoke.md:161`)。**40 枚スケールの実測は無い**
- → **rasterize に割ける残余時間を現物から算出することは、今はできない**(母数となる実測が 5 枚 1 点しかない)

**メモリ**

- **2 GB は spec に根拠付きで記録済**: `specs/2026-08-04-ocr-2-4a-single-invocation-design.md:132` —「Vercel 既定メモリ 2GB」(公式 doc 引用、Pro/Enterprise default)。**`vercel.json` に `memory` 指定は無い = 既定に乗っている**
- vCPU 数を記録した現物は **repo 内に無い**(kickoff の「1 vCPU」は repo で裏取り不可 = Vercel dashboard 側の情報)
- 現行の peak 見積り(同 `:132`):原本 Buffer 合計 ≤4MB + base64 ≈5.5MB + Gemini 応答数 MB + **decode 1 枚ずつ逐次**(2048px 上限 → 1 枚 ≈16.8MB、guard 上限 40MP ≈160MB)= **peak 数十〜200MB**
- **「decode の逐次実行」は実装制約として明文化され、unit test が「peak 同時 decode = 1」を機械強制している**(`upload-pipeline.ts:221-223`)
- → PDF rasterize を server で行う場合、**この逐次制約を rasterize にも課すかどうか**が同じ性質の判断点になる(ページを一斉に展開すると見積りが崩れる)

**PDF→画像変換の想定コスト — 現物からは出せない**

repo 内に PDF rasterize の実測・見積りは**一切無い**。分かるのは入力側の境界だけ:

- 現行 body 上限 4MB(client cap)/ 4.5mb(`next.config.ts` `bodySizeLimit`)/ Vercel platform 4.5MB。**PDF 原本もこの 4MB に含める設計だった**(`constants.ts:15` 「合計 (圧縮後画像 + PDF 原本) の上限」)
- 出力側は「40 ページ × 2048px 相当の webp」がおおよその上限像だが、**これは既存 client 圧縮パラメータ(`MAX_IMAGE_WIDTH_OR_HEIGHT=2048` / `MAX_IMAGE_FILE_MB=0.5`)を PDF に流用した場合の話で、rasterize の DPI をいくつに置くかは未決**

#### A-4. Node で使えるライブラリ候補(**存在確認のみ**・選定しない)

**まず現物の否定的事実: `sharp` は PDF を読めない。** devcontainer で実測:

```
$ node -e "console.log(require('sharp').format.pdf.input)"
{ file: false, buffer: false, stream: false }     ← libvips 8.18.3、PDF 入力 無効
input 可能: jpeg, png, webp, tiff, gif, svg, heif, vips, raw
```

→ 既存 dep で PDF を rasterize する手段は**無い**。新規 dep 追加が必須(= CLAUDE.md「新ライブラリ導入は事前相談」に該当)。

npm registry 直叩きで存在・license・最新版のみ確認(2026-08-07 時点):

| package | latest | license | 一言 |
|---|---|---|---|
| `pdfjs-dist` | 6.2.108 | Apache-2.0 | Mozilla PDF.js。Node で描画には canvas backend が別途要る |
| `unpdf` | 1.8.0 | MIT | serverless 志向の PDF.js 再パッケージ |
| `pdf-to-img` | 6.2.0 | MIT | PDF→画像(Node 特化ラッパ) |
| `@napi-rs/canvas` | 1.0.3 | MIT | skia backend の native canvas。**native binary = sharp と同じ NFT トレース問題の候補**([[reference_sharp_nft_tracing_vercel]] 参照) |
| `@hyzyla/pdfium` | 2.1.13 | MIT | PDFium wrapper |
| `mupdf` | 1.28.0 | **AGPL-3.0-or-later** | MuPDF.js。license が他と異なる |
| `pdf-lib` | 1.17.1 | MIT | 生成・編集用(**rasterize はしない** — 用途違い) |

**選定しない**。ただし記録すべき既知の地雷が 1 つ: **native binary を含む dep は Vercel の NFT トレースから脱落して実行時 500 になった前例がある**(sharp の libvips `.so`・fix = `next.config.ts` の `outputFileTracingIncludes`、`next.config.ts:38-62`)。local では再現せず stg smoke で初めて出た。

### 2-B. クライアント側の場合

#### B-1. 現行 client 圧縮の位置と、その手前

```
handleAdd(filesList)                                  upload-form.tsx:305
  └ for (file of unique)
      ├ file.type === 'application/pdf'  → entry{kind:'pdf'} + processPdf(ページ数だけ数える)   :330-338
      ├ file.type.startsWith('image/')   → entry{kind:'image'} + processImage                  :339-347
      └ else                             → 無視                                                :348-350

processImage(file, id)                                :207-250
  └ imageCompression(file, { maxSizeMB:0.5, maxWidthOrHeight:2048, useWebWorker:true, fileType:'image/webp' })
      → entry を {kind:'image', file:compressed, thumbUrl, status:'ready'} へ差し替え
```

- **rasterize の挿入点は明確に 1 箇所**: `handleAdd` の PDF 分岐(`:330-338`)。`processPdf` を「ページ数を数えるだけ」から「N 枚の画像 File を生成して N 個の `kind:'image'` entry に展開する」へ変える形。
- 展開後は既存 `processImage`(webp 圧縮)にそのまま流せる。**`fileType:'image/webp'` 固定なので、rasterize 出力の mime が何であれ最終的に webp に揃う**(`:217` のコメントが「HEIC/GIF 等が magic-byte 検証で弾かれないための固定」と明記)。
- entry が `kind:'image'` になれば、submit 時の PDF ブロック(`:466`)にも `sniffMagicBytes`(server)にも引っかからない。
- 現行の client は既に **canvas 再エンコードで EXIF を焼き込んでいる**(`upload-pipeline.ts:236-249` / `source-image-verify.ts:91-94` が前提として明記)。rasterize 出力も同じ性質になる。

#### B-2. サーバーは「画像が N 枚来た」としか見えないか → **現状の実装ではそのとおり。ただし 1 箇所だけ嘘になる**

server が client から受け取るのは `FormData` の `files` × N だけ(`upload-form.tsx:490` `fd.append('files', e.file, e.file.name)`)。PDF 由来かを知る経路は**存在しない**。各所の扱い:

| 場所 | 現状 | client rasterize 後 |
|---|---|---|
| `sniffMagicBytes` | webp を受理 | 素通り。変更不要 |
| `source_documents.fileType` | **`'image'` ハードコード**(`submit-upload.ts:319`) | **実体と乖離**。列の型は `'pdf'\|'image'\|'csv'\|'markdown'` を持つのに常に `'image'` が入る |
| `source_documents.filename` | 先頭 file 名 + 「ほか N 件」(`:309-312`) | **`page-1.webp ほか 39 件` のような無意味な表示になる**(元の PDF 名が消える)。この filename は `upload_records` の記帳にも転記される(`publish-prepared.ts:144,232`) |
| `pagesTotal` / `expectedSourceCount` | `files.length` | rasterize 後の枚数 = ページ数と一致する(意味は合う) |
| `pages_processed`(月次 quota) | `expectedSourceCount`(`publish-prepared.ts:135,234`) | 1 PDF ページ = 1 ページ課金。意味は合う |
| `prepared_payload` / figure の `sourceId` | server が受領順に `randomUUID()` 採番(`upload-pipeline.ts:235`) | ページ由来の情報は乗らない |
| `asset_derivations` | `orig_bbox`/`padding_pct`/`clamped_bbox`/`crop_w`/`crop_h`/`detect_target`/`pipeline_version`(`schema.ts:964-979`) | **page 番号を持つ列は無い** |

→ **「知る必要がある箇所」は原理上ゼロだが、`fileType` と `filename` の 2 つは「知らないと表示・記帳が実体と食い違う」。** どちらも今は client が何も伝えないので、伝える設計にするか、乖離を受容するかの判断点。

#### B-3. 枚数上限 40 が PDF page 数にどう効くか

client rasterize なら、PDF は展開後に **1 ページ = 1 image entry = 1 枚**として数えられる:

- `totalRequestedPages`(`upload-form.tsx:182-188`)は image entry を 1 ずつ加算 → **PDF N ページ = N 枚**
- `overPageCap`(`:196`)= `totalRequestedPages > 40` で submit 不可
- server 側も `files.length > OCR_MAX_PAGES(40)` で reject(`submit-upload.ts:135`)
- → **41 ページ以上の PDF は現行 40 の壁に当たる。** 既存 `MAX_PDF_PAGES = 40`(per-file)と数値が同じなので、単一 PDF なら実質同じ境界に見えるが、**軸が違う**(per-file vs per-upload 合計)ため PDF 2 本なら合計で先に当たる
- **合計 4MB の壁の方が先に来る可能性が高い**: 40 ページ × webp(`maxSizeMB: 0.5` は per-file 上限であって実出力サイズではない)を 4MB に収める必要がある。**現行 cap を PDF に流用した場合の実測は無い**

---

## 3. source 非保持の軸との関係

### 3.1 現行の不変条件(②-4a で確立・実証済)

- **source バイトは R2 に一切置かれない。** `app/(app)/app/upload/` 配下 + `lib/media/` で R2 への書込は `lib/media/crop-and-store.ts:307` の `putObject` **1 箇所のみ**で、書くのは **crop 済み webp だけ**(key = `users/{uid}/{assetId}.webp`)
- `getObject`(同 `:314`)は PUT 直後の重複検出(`ifNoneMatch` 衝突時のハッシュ照合)専用で、source を読み戻すためではない
- `source_documents` の schema コメントが明記:「アップロードファイル自体は inline base64 で Gemini に渡すのみで**永続化しない (R2 非経由)**」(`schema.ts:376-377`)
- migration 0032 で `source_assets` 表ごと **drop**(不可逆・stg 適用済)。R2 の `users/*/src/` prefix も一掃済(`scripts/gc-src-prefix.ts`)
- iso test が「payload commit までに R2 GET 0 回」「R2 PUT の key に `src/` を含まない」を pin(`specs/2026-08-04-...:226-227`)

### 3.2 client rasterize なら PDF はサーバーに到達しない → **正しい。経路上 PDF が保存される箇所は無い**

- FormData に載るのは rasterize 後の image のみ(`upload-form.tsx:474-490` が `kind === 'image' && status === 'ready'` の entry だけを filter して append)
- PDF 原本を送る経路も、保存する経路も存在しない
- **ただし**: 現在 legacy `_actions/process.ts` が `'use server'` で生存しており、これは `application/pdf` を受けて Gemini に丸投げする実装のまま(§1.4)。**client 経路の話とは別に、この dead action の存在は「PDF が server に到達しうる面」として残っている**(呼び出す client は無いが Server Action endpoint としては登録される)

### 3.3 server rasterize の場合 → **PDF 本体・中間画像とも R2 に置かずに済む構造になっている**

- crop 済みのみ R2 という現行構造は「同一 invocation でバイトをメモリ保持する」ことで成立しており(`specs/2026-08-04-...:76`)、rasterize 結果も同じくメモリに置けば R2 は不要
- **spec に明示的な設計判断として記録済**(`specs/2026-08-04-ocr-2-4a-single-invocation-design.md:76`):
  > ②-4b(PDF)予約列(`source_kind`/`page_count`/`rotation`/`rasterizer`)は「source を R2 に保持する」前提の設計。新軸では PDF も同様に **server 受領 → メモリ rasterize → crop のみ R2** となるべきで、page 概念は `prepared_payload` / `asset_derivations` 側(figure の page 属性)で表現できる。**表を残すと「保持前提だった」と将来誤読される**ため drop が正。②-4b を阻害しない。
- ただし **`docs/audit/2026-08-04-why-source-goes-through-r2.md:64` は「②-4b(PDF)は射程外 = 未評価」と明記**しており、上の §76 の断定と評価の深さが違う。**§76 は「そうなるべき」という設計方針であって、実測に基づく成立証明ではない**

### 3.4 中断時の再開に関する既存トレードオフ

- ②-4a は **resume を廃止**(バイトが request 限り → publish だけの再試行は client の画像再送が要る)
- **spec が ②-4b を resume 再評価トリガーとして名指ししている**(`specs/2026-07-30-...:160`):「②-4b の大容量 PDF(数十 MB の再送コスト)— 発動条件 = **②-4b 実測後に再評価**」
- → PDF で原本が大きい場合、「再送 = 数十 MB」が現実的かどうかが resume 復活の判断材料になる、と既に予告されている

---

## 4. page 概念の現状

### 4.1 0032 で消えたもの / 残ったもの

**消えた**(`drizzle/migrations/0032_watery_scarlet_spider.sql`・不可逆):

- `source_assets` 表ごと DROP(`:42`)。その中に ②-4b 予約列 `page_count` / `rotation` / `rasterizer` / `source_kind` があった(pre-0032 の `schema.ts` を `git show 80ef3b4^` で確認)
- `asset_derivations.source_asset_id` 列も先に DROP(`:40`)→ **crop 結果から「どの source 画像由来か」を辿る DB 上の経路は現在存在しない**

**残った / 現存する複数画像の順序・出所の表現**:

| 何 | どこ | 内容 |
|---|---|---|
| **`source_id`** | `upload-pipeline.ts:235` で `randomUUID()` 採番 → `buildSourceIdInterleavedParts` で Gemini に `text "source_id=X"` として画像の直前に挿入(`lib/ai/clients/ocr-image-crop-parts.ts:26-30`) | **これが唯一の「どの画像由来か」の表現**。モデルに書き写させて `figure.sourceId` として回収 |
| **`prepared_payload.cards[].figures[]`** | `lib/ocr/prepared-schema.ts:60-72` | `{ assetId, sourceId, box_2d, target, label }`。**`page` フィールドは無い** |
| **受領順** | `submit-upload.ts` → `upload-pipeline.ts:220` の for ループ | 順序は FormData の append 順 = client の entry 順。**DB には index として保存されない** |
| `pages_total` / `expected_source_count` | `source_documents` / `upload_operations` | **件数だけ**。順序も出所も持たない |
| `asset_derivations` | `schema.ts:964-979` | crop の provenance(bbox / padding / crop 寸法 / detect_target / pipeline_version)。**page も source 参照も無い** |

**重要**: `source_id` は **DB のどの表にも永続化されない**。`prepared_payload`(jsonb)の中にだけ存在し、その `prepared_payload` は **publish 成功で NULL 化される**(`specs/2026-08-04-...:120`)。→ **publish 完了後、「どの図版がどの入力画像の何番目か」を DB から復元する手段は無い**。

### 4.2 PDF の page 番号を乗せるとしたら → 既存構造で**足りない**(3 段のうち 1 段は既に穴が空いている)

| 段 | 現状 | page を乗せるには |
|---|---|---|
| **① Gemini 応答 schema** | **予約済・実装済**。`lib/ai/schemas/ocr-image-crop-response.ts:33-34`(`page?: number` / コメント「②-4b (PDF ページ) 予約。②-4a では未使用」)+ `:82`(JSON schema にも `page: { type: 'number' }` が入っている) | **そのまま使える**。追加不要 |
| **② prepared_payload(figure)** | `preparedFigureSchema`(`prepared-schema.ts:60-72`)に **`page` は無い**。zod は default で unknown key を strip するため、①で返っても②で落ちる | **`preparedFigureSchema` への追加が要る**。ただし `preparedPayloadV1Schema` は「V1 を書き換えず V2 を追加する」運用ルールがある(`prepared-schema.ts:182-189`)ため、**単純な列追加では済まない可能性** |
| **③ 永続化** | `asset_derivations` に page 列なし。`prepared_payload` は publish で NULL 化 | **新規列 or 別表が要る**。spec §76 は「`asset_derivations` 側(figure の page 属性)で表現できる」と述べているが、**現物には列が存在しない**(= 未実装の設計方針であって既存構造ではない) |

**加えて**: client rasterize を採ると、そもそも **モデルは「PDF の 5 ページ目」ではなく「5 枚目の画像」しか見ない**。①の `page` フィールドはモデルが PDF を直接見る前提(§4.3 の probe が実際にそう使っている)で予約されたもので、**client rasterize 方式では①は使わず、page 番号は client が知っている情報として別途運ぶ**ことになる。**方式によって①の予約が生きるか死ぬかが変わる。**

### 4.3 既存の PDF 実測資産(未実行 / 結果は repo に無い)

`b7ba074` [no-review] で追跡化された throwaway probe が 2 本残っている。**どちらも実 API 実行が前提で、結果を記録した doc は repo 内に見つからない**(`out/` は gitignore):

| script | 何を測る設計か |
|---|---|
| `scripts/ai/_ocr-pdf-box2d-probe.ts` | **PDF を rasterize せず 1 回で Gemini に渡し**、`page` 付き `figure_regions` を検出 → 対照ページ画像に overlay → **PDF 入力の box_2d と単体ページ画像入力の box_2d を各辺差分で比較** → text-only PDF で幻矩形が出ないか確認 |
| `scripts/ai/_ocr-pdf-integrated-probe.ts` | 本番 discover text 抽出 + 探索 figure_regions の統合出力を PDF 入力で走らせ、検出粒度の run 間再現性を見る |

- `scripts/ai/lib/load-images.ts:13` の mime allowlist に **`.pdf` → `application/pdf` が既に入っている**。`GeminiInputFile.mimeType` は `string`(`gemini.ts:38`)で、コメントも「base64-encoded file bytes (**PDF** or image)」(`:39`)
- → **「rasterize せず PDF をそのまま Gemini に送る」は SDK/型の上では今すぐ通る**(legacy `process.ts` が実際にそうしていた・§1.4)。ただし **box_2d の座標系が PDF 入力とページ画像入力で一致するかは未検証** — probe はまさにそれを測るために書かれた
- **spec の PDF 固有規則**(`specs/2026-07-30-...:170`):「PDF(②-4b)のみ**ページレンダリングを crop 元とし**、埋め込み画像の直接抽出は回転 / 座標乖離ゆえ**禁止**(PDF 固有規則・画像入稿に非適用)」→ **crop 元は必ずレンダリング結果でなければならない、という制約は既に凍結済**
- サンプルは**現存する**(`ls` 確認済): `scripts/ai/ocr-samples/mock-exam-set.pdf` / `8p_textonly.pdf` / `mock-exam-set-p-{1..7}.png`。→ probe は実 API 合図さえあればすぐ走る状態

---

## 5. 判断点の所在(材料のみ・決めない)

1. **rasterize 位置**: client(`handleAdd` の PDF 分岐 1 箇所)vs server(sync tx 前 / after() 内のどちらでも `expected_source_count` の immutable manifest に触る)
2. **そもそも rasterize するか**: Gemini は PDF を直接受ける(§4.3)。ただし crop 元はレンダリング結果でなければならない凍結規則があるため、**「検出は PDF 直渡し / crop 用にレンダリング」という分離もありうる**。box_2d 座標系の一致は未検証(probe 未実行)
3. **`fileType` / `filename` の乖離**: client rasterize なら server は PDF と知りえない(§2-B2)
4. **page 番号の永続化先**: ②は schema 変更、③は列が存在しない(§4.2)
5. **40 枚 / 4MB の壁**: PDF ページ数に対して現行 cap が妥当かの実測が無い(§2-B3)
6. **dep 追加**: sharp は PDF を読めない(実測)。native binary 系は NFT トレースの前例あり(§2-A4)
7. **legacy `process.ts`**: PDF 受理実装のまま `'use server'` で生存(§1.4 / §3.2)
8. **resume の再評価**: spec が「②-4b 実測後」と明示的に予約している(§3.4)

---

## 6. 「不明」と明示すべきもの

- **PDF→画像変換の実コスト**(時間 / メモリ / 出力サイズ): repo 内に実測・見積り一切なし
- **40 枚スケールの pipeline 実測**: 5 枚 1 点のみ(②-4a cutover smoke)。時間予算の値も「暫定」と自己申告
- **vCPU 数**: repo に記録なし(2GB は spec に記録あり・`vercel.json` に memory 指定なし = 既定)
- **PDF probe の実行結果**: script は存在するが結果 doc が repo 内に無い
- **PDF 入力時の box_2d 座標系**: 未検証(probe の測定対象そのもの)
