# ②-4b PDF 対応(R2 一時保存 + server WASM rasterize)— 設計 spec

**日付**: 2026-08-07 / **status**: OT レビュー待ち(確定前)
**位置付け**: ②-4a(画像入稿・単一 invocation)の上に PDF 入稿を足す。②-4a の pipeline 本体(Gemini 契約 / normalize / crop / publish)は**不変**が本 spec の中心的主張。
**根拠調査**: `docs/audit/2026-08-07-ocr-2-4b-pdf-factfinding.md` / `…-r2-source-retention-factfinding.md` / `…-rasterize-feasibility-measurement.md`(以下「調査①②③」)。
**やらないこと(非スコープ)**: Files API / resume(prepared からの再開)復活 — 発動条件は ②-4a spec:160 のまま(②-4b 実測後に再評価)/ 選択的 rasterize(§4 D2 で棄却)/ account quota 強制(②-5)/ CSV・markdown 入稿。

---

## 1. 方針転換の宣言(architecture.md §6 の改訂)

**source(PDF 原本)を R2 に一時保存する。** ②-4a で確立した「source を R2 に置かない」(architecture.md:76・決定 2026-08-04 OT)を、②-4b で以下の理由により改訂する:

1. **Server Action の body cap を PDF 原本が越える** — app 4MB(`TOTAL_UPLOAD_LIMIT_BYTES`)/ framework 4.5mb(`bodySizeLimit`)/ Vercel platform 4.5MB。スキャン PDF は数十 MB になり、FormData 経路では原理的に受けられない。
2. **server rasterize が in-memory だけでは成立しない規模になりうる** — 原本をブラウザから server へ運ぶ経路が 1 で塞がる以上、R2 直 PUT が唯一の搬入路。
3. **保持は処理中のみ** — 完了・失敗の両方で pipeline が即 DELETE(本線)。lifecycle rule(§6)が保険。旧方針の動機(著作物の疑い = 残さない)は「恒久保持しない」として維持され、「一瞬も置かない」から「処理中のみ・秒〜分オーダーの保持 + 二重の削除機構」へ緩和される。

**②-4a の判断経緯は消さない**: 「最小時間のみ保持 + purge」→「そもそも置かない」(2026-08-04)→「処理中のみ置く(②-4b・本 spec)」という到達順を architecture.md の行内に**置換で**記録する(stale 注記の追記ではなく行ごと書き換え)。置換文言は §10。

## 2. 経路全体

```
[client]
  PDF 選択 → pdfPageCount(advisory・§4 D5)→ batch 確定
  → reservePdfUploadUrls(新 action・DB 無し)= presigned PUT URL × N
  → R2 へ直 PUT × N(Content-Length/Type 署名固定・既存 presignPutUrl)
  → submitUpload(既存 action 拡張。body = メタのみ・PDF バイトは載らない)
[server: submitUpload]
  HEAD × N(tx 外・存在 + サイズ検証)→ sync tx(既存: gate / replay / exam /
  source_doc(fileType='pdf')/ op(expected_source_count=0)/ lease)→ 応答
  → after(): R2 GET(1 冊ずつ)→ WASM rasterize(1 ページずつ)→ webp 化(sharp)
  → ページ画像列 = 既存 pipeline の files 相当に合流
    (以降 decode 検証 → Gemini → normalize → prepared commit → crop → publish は不変)
  → pipeline 出口(成功 / terminal / raced すべて)で source を明示 DELETE
[client] poll(既存 /api/exams/status・変更なし)
```

**presigned 経路は既存カード画像添付と同型**(`asset-actions.ts` reserve → `lib/media/upload.ts` 直 PUT → finalize HEAD + サイズ検証)。対照:

| 要素 | カード添付(既存) | PDF(本 spec) |
|---|---|---|
| 台帳行 | `assets` 行を reserve で INSERT | **無し**(§4 D3。key 規約 + op 行で代替) |
| presign | `presignPutUrl(key, mime, byteSize)`(Content-Length/Type 署名焼込・既定 600s) | **同じ関数をそのまま使う**。mime = `application/pdf` |
| 完了検証 | finalizeAsset が HEAD + contentLength 一致 | submitUpload が HEAD + サイズ上限検証(tx 外・`finalizeAsset:166-168` と同型) |
| `reserveAsset` の再利用 | — | **しない**: 入力 zod が画像 mime enum + 寸法必須(`asset-actions.ts:60-61`)で、assets 行 INSERT が本質的に画像台帳。PDF は台帳を持たないため写すのは presign 呼出と HEAD 検証の形のみ |

## 3. key 設計 — kickoff 案の不成立指摘と代案

**kickoff 案 `src/{operationId}/{seq}.pdf` は成立しない**: operationId は submitUpload の sync tx で初めて生まれる(`submit-upload.ts:331`)が、presign → PUT は submit の**前**。op 行を presign 時に前倒し作成するには新 status(uploading)+ `exam_id` NOT NULL の解除(mode 'new' で exam 未確定のため)= migration + 状態機械改変が要り、代案より重い。

**代案(採用)**: **`src/{userId}/{idempotencyKey}/{fileId}.pdf`**

- **top-level `src/` 専用 prefix は維持** — lifecycle rule 1 本で全 source をカバー(kickoff の狙いそのまま。現行 key は全て `users/` 始まりで user_id が第 2 セグメントゆえ user ごとに rule が要る・調査②§2.4)。
- 3 セグメントすべて server 導出: userId = 認証済み内部 uuid / idempotencyKey・fileId = client 発行だが **uuid v4 形状を server が検証してから key に埋める**(path injection 不能)。client は key 文字列を一切送らない(server が毎回導出)。
- **所有者確認**: pipeline は自 op 行の (userId, idempotencyKey)(既存 UNIQUE index)+ after() closure の fileId 列から key を**自分で導出**して GET する。他人の key を掴む経路が構造的に無い。kickoff の「op 行で足りる」は (userId, idempotencyKey) 経由で成立。
- **台帳は作らない**(kickoff どおり): `source_assets` を復活させない。放棄物の回収は lifecycle(§6)。migration **不要**(schema 変更ゼロ・§8)。
- fileId は client が file 追加時に発行する uuid(ordinal でなく uuid にする理由: 選択の削除・並べ替えで seq が振り直しになる問題を消す。順序は submit のメタ list の並びが正)。

## 4. 設計決定

**D1. rasterizer = `@hyzyla/pdfium`(WASM)。mupdf は不採用。**
① **license**: mupdf は AGPL-3.0-or-later — 商用 closed-source SaaS の server 側リンクは §13 ネットワーク条項に抵触(商用ライセンス購入なしでは使えない)。pdfium は MIT(本体 PDFium は BSD 系)。これが決定打。② wasm 4.0MB vs 10.4MB(bundle 加算が小さい)。③ 性能同等(render 22 vs 15ms/page・支配項は共通の sharp webp encode ≈170ms/page・調査③)。④ pdfium は encoder 非内蔵だが**既存 sharp をそのまま使う**ため新規 encoder 依存なし。⑤ native(@napi-rs/canvas)は Turbopack build が通らず不採用(調査③実測)。
リスク(受容): wrapper は小規模コミュニティ。緩和 = exact pin + 使用 API 面を 5 つに限定(`init` / `loadDocument` / `getPageCount` / `getPage` / `render`)し薄い自前 module に閉じ込める(§8)。

**D2. モデル入力 = レンダリング済みページ画像列(PDF native 入力は不採用)。全ページ前置 rasterize。**
旧 ②-4a spec §17 の素描(PDF native 入力 + 座標返却後に図のあるページだけ選択的 rasterize)は採らない。理由: ① crop 元 = ページレンダリング(②-4a spec:170 の凍結規則)は両案共通で、native 入力でも rasterize は結局要る ② PDF 入力時の box_2d 座標系がページ画像と一致するかは**未検証**(probe 未実行・調査①§4.3) ③ 全ページ rasterize の実測コストが無視できる(40p ≈ 7.5s・調査③) ④ 入力を画像列に統一すると **prompt / OCR schema / normalize / crop / publish がすべて不変** = 検証済み経路への完全合流。品質確認は stg smoke の実 PDF 投入で行う(比較対象となる旧挙動は存在しない)。

**D3. action 構成 = 新設 `reservePdfUploadUrls`(DB 無し)+ `submitUpload` 拡張(入口 1 点維持)。**
- `reservePdfUploadUrls`: 認証 → 入力検証(idempotencyKey/fileId の uuid 形状・件数 ≤ 上限・declaredBytes ≤ per-file 上限)→ 各 key へ `presignPutUrl(key, 'application/pdf', declaredBytes)` → `[{fileId, url}]`。**DB を触らない**(reserve 行なし)。サイズ詐称は署名の Content-Length 固定が拒否(既存機構)。悪用残余 = presign+PUT して submit しない storage 消費 → lifecycle が上限 ~48h で回収(bounded residual・§6)。
- `submitUpload`: FormData に `files` が無く `pdfFiles` メタ(`[{fileId, filename, declaredBytes}]` の JSON)がある場合 = PDF 経路。**gate / 冪等 replay / lease / after() は既存のまま共用**(入口 1 点・二重実装しない)。sync tx 前(tx 外)に HEAD × N で存在 + contentLength ≤ 上限を検証し、欠落は即 `invalid_input` 系エラー(pipeline まで行かせない)。sync tx 内は既存と同じ形で `source_documents.fileType='pdf'` / `filename`(単一なら原名・複数なら「A.pdf ほか N 件」= 既存合成規則)/ `pagesTotal=NULL` / op `expected_source_count=0` を書く。
- **混在不可**: 1 回の upload は画像のみ or PDF のみ。混在 FormData は `invalid_input`。client も送信前に block(現行の「PDF 混在 block」を「画像/PDF 混在 block」へ差し替え)。理由: 経路(FormData vs presigned)と順序合成の複雑化に対し需要が薄い。
- **idempotencyKey の発行時点が変わる**: 現行は submit 時発行 → PDF 経路は **batch 開始時(最初の presign 要求時)に発行**し、PUT〜submit まで同一 key を通す。transport retry = 同一 key = 既存 replay 契約どおり。**PDF 選択を変更(追加/削除)したら batch を作り直す**(新 idempotencyKey + 再 presign + 再 PUT)。旧 batch の残骸は lifecycle が回収。

**D4. 冪等・競合(kickoff 必須 3)**: 「完了通知」を独立 endpoint にせず submitUpload に統合したため、新しい冪等面は生まれない。二重通知 = 同一 idempotencyKey の replay(既存契約: 状態不問で 3 ID 返却・after() 再スケジュールなし)。takeover は ②-4a で廃止済みで競合クラス自体が存在しない。並行 submit = advisory lock + live-op gate(既存)。lease 機構は**意味も値も不変**(PUT 中は op が存在せず lease 無関係。lease は after() 実行中の生存表明のまま)。

**D5. page count の正本 = rasterizer(kickoff 必須 1)。**
- server: `getPageCount()`(pdfium)が唯一の正。rasterize 前に評価し、**合計(全 PDF)> `OCR_MAX_PAGES`(40)なら terminal reject**(`last_error_code='page_limit_exceeded'`・ユーザー文言は上限と分割案内)。silent 截断はしない(loud failure over silent zero・②-4a spec §13 と同じ原理)。Gemini 呼出前に落ちるため課金なし。
- client の `pdf-page-count.ts` は **UX 目安に降格**(削除しない): 選択直後の概算表示・明白な超過の早期 block 用。**PDF 1.5(ObjStm)で 0 を返す欠陥(調査③§2.5)は直さない** — 0 は「ページ数不明」として表示し submit を block しない(fail-open を明示的に受容。防衛線は server 正本)。`MAX_PDF_PAGES`(per-file 40)も advisory のまま残す。月次 quota の残量表示(advisory)も同様に不明分は概算(enforcement は ②-5 のまま)。

**D6. expected_source_count = 二段確定(kickoff の manifest 論点)。**
sync tx は `expected_source_count=0`(未確定 sentinel)で INSERT し、after() 内 rasterize 完了直後・Gemini 前に **fenced CAS UPDATE**(`WHERE id + lease_version + status='processing'`)で確定ページ数を書く。`source_documents.pages_total` も同 UPDATE で埋める。以降は従来どおり immutable、publish は既存コード(`publish-prepared.ts:92,135,234`)を**無変更**で読む(pages_processed = 実ページ数 = 課金整合)。schema コメントの「operation 作成時に確定」は「画像 = 作成時 / PDF = rasterize 後に一度だけ確定」へ改訂。代替案(publish への引数化)は publish 署名変更が要るため見送り(読者 3 箇所無変更 > 列意味の但し書き 1 行)。

**D7. 上限(暫定・実測後見直し = ②-4a と同じ運用)**: per-file **50MB** / 1 upload の PDF 冊数 **≤ 10** / 合計ページ ≤ 40(既存 `OCR_MAX_PAGES`・server 正本)。50MB の根拠 = 2GB メモリに対し buf + wasm heap で一桁下・R2 GET 現実時間。冊数 10 = presign/HEAD 呼出数の bound(実用は 1〜数冊)。

**D8. rasterize の実行制約**: after() 内・R2 GET(**1 冊ずつ** GET → 全ページ処理 → buf 解放)・rasterize/webp encode は **1 ページずつ逐次**(既存「peak 同時 decode = 1」不変条件の拡張・調査③実測の前提)。出力 = webp(quality 80・長辺 2048px = 既存 `MAX_IMAGE_WIDTH_OR_HEIGHT` と同値)。ページ画像は既存の decode 検証ループ(`verifyImageBytes`)に**そのまま合流**させる(自前出力でも通す: 経路統一 + crop 用寸法の取得点を増やさない)。source_id はページごとに server 採番(既存 `randomUUID()` — page との対応は invocation 内で既知)。

**D9. fileType / filename(kickoff 必須 4)**: **残す** — `source_documents.fileType='pdf'` を書く(現行の `'image'` リテラルを経路で分岐)。**消費者 = 運用 SQL 調査(PDF 経路の障害切り分け)+ 将来の一覧表示の余地。現存する production 読者は無い**(調査②§3.4)ことを承知で、永続行に虚偽('image')を書かないことを優先する。filename は submit メタの原名を既存合成規則で保存 → 「rasterize 後の連番名で原名消失」問題(調査①§2-B2)は発生しない。

**D10. ページ番号は永続化しない(kickoff 必須 5・見送りを明示)。**
- `preparedFigureSchema` / `asset_derivations` に page を**足さない**。理由: ① source_id がページと 1:1 で invocation 内の帰属解決は完結 ② 永続 page の消費者(UI/運用)が現存しない ③ 足すなら preparedPayload **V2 追加**の運用ルール(`prepared-schema.ts:182-189`)対象でコスト大。将来必要になった時に V2 で足す。
- Gemini 応答 schema の `page?: number` 予約(`ocr-image-crop-response.ts:33`)は**凍結のまま残す**(dead reservation と明記)。撤去は本番 schema 変更 = ②-0 の arm 比較を要する別 task。normalize が destructure しない現状(`normalize-prepared.ts:207`)も不変。

**D11. 時間予算(kickoff 必須 7)= 構造変更なし・値は実測後(既存方針)。**
判定: rasterize 40p ≈ 7.5s(local・長辺 2048)+ R2 GET ≤50MB×冊数。予算 660s に対し想定数%で、**予算の構造(単一 deadline + 残余参照)は変えない**。ただし ① Vercel 1 vCPU 実測が無い(支配項の webp encode は CPU バウンド)ため `logPhase` に `fetch_source` / `rasterize` を追加して実測材料を出す(既存 phase log 規律)② rasterize 開始前に残余チェック 1 点を追加(既存 pre-Gemini チェックと同型)③ **`getObject` の timeout 10s は 50MB に不足しうる** → source GET は専用 timeout(暫定 60s・引数化)で呼ぶ。

## 5. 削除設計(kickoff 必須 2)— 明示 DELETE 本線 + lifecycle 保険

**本線**: `runUploadPipeline` の**出口共通処理**(成功 publish 後 / terminalize 後 / start_cas_lost / commit_raced の全経路)で、closure の fileId 列から導出した全 source key に `deleteObject`(never-throw・404 = ok)。失敗は `integration_failures` へ記録(**catalog に `r2_source_delete` を新設** — 0032 で消えた `r2_gc_delete_source` の後継)+ lifecycle に委ねる。raced/lost でも削除してよい根拠: key はこの invocation の (userId, idempotencyKey) 専有で、op が死んでいれば source を読む者はもういない。

**保険**: R2 lifecycle rule — prefix `src/`・`maxAge = 86400s`(1 日・暫定)。**削除実行は「典型 24h 以内」で保証なし**(調査③§3)ため、保険の実効上限 ≈ 48h と明記。設定は Cloudflare dashboard = **OT 手動**(§9)。bucket は dev/stg 共有 `recallmint-dev` と prod の各々に設定。

**放棄マトリクス**:

| ケース | 残るもの | 回収 |
|---|---|---|
| presign のみ(PUT なし) | 無し | 不要 |
| PUT 後 submit なし(選択変更の旧 batch 含む) | object のみ(op 無し) | **lifecycle のみ**(台帳なしゆえ trigger なし・受容) |
| submit 後 after() 未実行 / pipeline 途中死(platform kill) | object + 非終端 op | op = lease 失効 → reconciler terminal 化(既存)。object = **lifecycle**(reconciler に R2 I/O を足さない — status 読出し経路の latency を汚さないため) |
| pipeline 完走(成功 / terminal) | — | **明示 DELETE(本線)**。失敗時 = 台帳記録 + lifecycle |

## 6. 検証・pin の張り直し(kickoff 必須 6)

**落ちる pin と置換**(消すだけにしない):

| 現行 pin | 扱い |
|---|---|
| `submit-upload.test.ts:448` r2 非 import(regex) | **置換**: import してよい r2 関数を `headObject` **のみ**に限定する regex pin(presign は `reserve-pdf-upload.ts` 側・§8) |
| `upload-pipeline.test.ts:893` r2 非 import(regex) | **置換**: `getObject` / `deleteObject` のみ許可の regex pin(putObject は従来どおり不可 = source を server が書かない) |
| iso `upload-pipeline.test.ts:387` PUT key に `/src/` を含まない | **生き残る(強化して維持)**: source PUT は client presigned のみで **server putObject は今後も crop key だけ** — この不変条件は改訂後も真 |

**新規 pin(新しい不変条件)**:
1. key builder 純関数 unit: `src/{uuid}/{uuid}/{uuid}.pdf` 形状 + 非 uuid 入力の reject(red: 形状変異で fail)。
2. iso: **成功経路**で pipeline 終了時に全 source key へ deleteObject が呼ばれる(mock 記録)。
3. iso: **terminal 経路**(例: page_limit_exceeded / gemini_call_failed)でも同様に削除される。= 「処理完了・失敗の両方で source が削除される」の機械強制。
4. iso: server putObject の key 集合は crop のみ(既存 3 の維持)。
5. unit: rasterize 逐次(peak 同時 1)— 既存 decode pin と同型の計測 mock。
6. `expected_source_count` 二段確定の iso: rasterize 後 CAS が lease 不一致で書かないこと(fencing red)。

test は既存規律どおり(feat の canonical + Codex / red 実証は plan で task 化)。**docs 更新もハンドオフに含める**: architecture.md §6 行置換(§10)+ `docs/harness.md` に lifecycle rule(外部設定・OT 管理)の 1 行 + 本 spec への参照。

## 7. UI(要件のみ・詳細は plan)

- copy 差し替え: 「PDF は現在未対応です」→ PDF 対応の案内(per-file 50MB / 合計 40 ページ)。`accept="image/*,application/pdf"` 復帰。
- 混在 block 文言(画像と PDF は同時に投入不可)。
- PDF batch の進行表示(PUT 中 / 送信済み)。PUT 失敗 = エラー表示 + batch 再作成(部分 retry しない)。
- ページ数 0(解析不能)は「ページ数不明」表示で block しない(D5)。
- poll / result page は**無変更**。

## 8. 変更一覧(file 粒度)と migration 判定

**migration = 不要**(schema 変更ゼロ: 新表なし・新列なし・status 値追加なし。fileType 'pdf' は既存 union、expected_source_count/pages_total は既存列の値運用のみ)。

| 種別 | file |
|---|---|
| 新規 | `lib/media/pdf-rasterize.ts`(pdfium ラッパ・使用 API 5 つに限定)/ `lib/media/source-object-key.ts`(key builder 純関数)/ `_actions/reserve-pdf-upload.ts` |
| 変更 | `submit-upload.ts`(PDF メタ分岐 + HEAD 検証 + fileType)/ `upload-pipeline.ts`(GET → rasterize 合流 + 出口 DELETE + CAS UPDATE + phase log)/ `lib/storage/r2.ts`(getObject timeout 引数化)/ `lib/integration-failures.ts`(catalog 追加)/ `upload-form.tsx`(batch flow + copy)/ `_lib/constants.ts`(PDF 上限定数) |
| test | §6 の pin 群 + 既存 test の PDF 経路追加 |
| deps | `@hyzyla/pdfium` exact pin(新規 dep = 本 spec の OT 承認をもって事前相談成立)|
| docs | architecture.md §6 置換 / harness.md 追記 |

## 9. 未確定(埋めない)

- WASM が Vercel の**実 function** に同梱されるか(local build の nft.json + chunk 参照まで確認済・`.vercel/output` 展開と deploy 済み probe 実行は未実施)→ **実装第 1 task を「probe route 1 本の stg deploy 実証」にする**(ここで落ちたら本 spec の rasterizer 選定に戻る)。
- function bundle size 上限に対する余裕(wasm 単体 4.0MB は測定済・trace 全体は未測定)。
- R2 CORS の実設定(repo 管理外)。既存カード添付の presigned PUT が同一 bucket・origin で稼働中のため、追加は `application/pdf` の Content-Type 許可の有無のみが論点。Cloudflare 側は OT 確認(§9 作業)。
- Gemini 側の inline byte 上限(repo に検証コードなし)。ただし本 spec の送信物はレンダリング済み webp 列 ≈3-4MB(base64 ≈5.3MB)= **既存 40 枚画像経路と同規模**で、新たな上限に近づく変更ではない。
- 単一 40 ページ文書の文書オブジェクトメモリ(実測は 5p/8p の反復・調査③)。
- lifecycle の秒指定 maxAge が実 API で受理されるか(docs の schema 記述のみ)。

## 10. architecture.md §6 行の置換文言(実装時にこの内容で置換)

> | **source(OCR 元 PDF/画像)の R2 保持は「処理中のみ」。置き場は top-level `src/` prefix(`src/{userId}/{idempotencyKey}/{fileId}.pdf`)のみ・server は source を PUT しない(client presigned のみ)・pipeline 出口(成功/失敗とも)で明示 DELETE + lifecycle(`src/` maxAge 1 日・実効 ≈48h)が保険。`source_assets` 表は存在しない(台帳なし・key 規約で辿る)** | 著作物の疑い(恒久保持しない)は維持。経緯: 「最小時間のみ保持 + purge」→「そもそも置かない」(2026-08-04 OT・旧 ②-4a)→ **PDF 対応で body cap(4.5MB)を原本が越えるため「処理中のみ置く」へ改訂(2026-08-07 OT・②-4b)**。画像入稿は従来どおり R2 非経由(FormData → メモリ) | 証明: source key builder unit + iso(出口 DELETE 両経路 / server PUT は crop key のみ)| 本 spec |

## 11. OT 作業(repo 外・実装と並行可)

1. R2 lifecycle rule 設定(`recallmint-dev` + prod bucket・prefix `src/`・maxAge 86400s)。
2. R2 CORS に `application/pdf` の PUT が通るか確認(既存添付 PUT の設定確認のみで済む可能性)。
3. 新 dep `@hyzyla/pdfium` の承認(= 本 spec 承認に含まれる)。
