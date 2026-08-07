# ②-4b PDF 対応(R2 一時保存 + server WASM rasterize)— 設計 spec

**日付**: 2026-08-07(同日改訂: OT 指示 7 点 — client 判定廃止 / 完了通知新設 / 回収定義 / UI 状態 / 既存誤り修正 / legacy 削除 / 未確定追記)/ **status**: OT レビュー待ち(確定前)
**位置付け**: ②-4a(画像入稿・単一 invocation)の上に PDF 入稿を足す。②-4a の pipeline 本体(Gemini 契約 / normalize / crop / publish)は**不変**が本 spec の中心的主張。
**根拠調査**: `docs/audit/2026-08-07-ocr-2-4b-pdf-factfinding.md` / `…-r2-source-retention-factfinding.md` / `…-rasterize-feasibility-measurement.md`(以下「調査①②③」)。
**やらないこと(非スコープ)**: Files API / resume 復活(②-4a spec:160 の再評価トリガーのまま)/ 選択的 rasterize(D2 で棄却)/ account quota 強制(②-5)/ CSV・markdown 入稿 / UI 文言の確定(状態の種類と遷移のみ定義・文言は design token 後)。

---

## 1. 方針転換の宣言(architecture.md §6 の改訂)

**source(PDF 原本)を R2 に一時保存する。** ②-4a で確立した「source を R2 に置かない」(architecture.md:76・決定 2026-08-04 OT)を、②-4b で以下の理由により改訂する:

1. **Server Action の body cap を PDF 原本が越える** — app 4MB(`TOTAL_UPLOAD_LIMIT_BYTES`)/ framework 4.5mb(`bodySizeLimit`)/ Vercel platform 4.5MB。スキャン PDF は数十 MB になり、FormData 経路では原理的に受けられない。
2. **server rasterize が in-memory だけでは成立しない規模になりうる** — 原本をブラウザから server へ運ぶ経路が 1 で塞がる以上、R2 直 PUT が唯一の搬入路。
3. **保持は処理中のみ** — 完了・失敗の両方で明示 DELETE(本線)。lifecycle rule(§6)が保険。旧方針の動機(著作物の疑い = 残さない)は「恒久保持しない」として維持され、「一瞬も置かない」から「処理中のみ・二重の削除機構」へ緩和される。

**②-4a の判断経緯は消さない**: 「最小時間のみ保持 + purge」→「そもそも置かない」(2026-08-04)→「処理中のみ置く(②-4b・本 spec)」という到達順を architecture.md の行内に**置換で**記録する(stale 注記の追記ではなく行ごと書き換え)。置換文言は §11。

## 2. 経路全体

```
[client]
  PDF 追加 → reservePdfUploadUrls(presign・DB 無し)→ R2 直 PUT     … entry: uploading
  → finalizePdfSource(完了通知・新設)                               … entry: counting
      [server] HEAD(実在+サイズ)→ GET → pdfium loadDocument
               → getPageCount()(レンダリングなし)
               → 単体 40 超過 or 解析不能 → source を即 DELETE + error 応答
               → 正常 → {pageCount} 応答(DB 書込なし)
  → UI: N ページ表示・合計(画像枚数 + Σ PDF ページ)/ 上限 40 を常時表示 … entry: ready(N)
  → submitUpload(既存 action 拡張。画像 = FormData バイト / PDF = メタのみ)
[server: submitUpload]
  pre-tx 検証: 画像(既存)+ PDF HEAD × N + 合計ページ判定(echo・§4 D6)
    → 超過は行ゼロで却下(現行の「検証完了後に tx を開く」順序を維持)
  → sync tx(既存: gate / replay / exam / source_doc / op / lease)→ 応答
  → after():
      count phase: PDF を 1 冊ずつ GET → getPageCount → 解放。
                   合計(authoritative)> 40 → terminal(レンダリング前に停止)
                   → expected_source_count / pages_total を fenced CAS で確定
      render phase: PDF を 1 冊ずつ再 GET → 1 ページずつ rasterize → webp(sharp)
      → 画像 + ページ画像列 = 既存 pipeline の files 相当に manifest 順で合流
        (以降 decode 検証 → Gemini → normalize → prepared commit → crop → publish 不変)
      → pipeline 出口(成功 / terminal / raced すべて)で source を明示 DELETE
[client] poll(既存 /api/exams/status・変更なし)
```

**新設が要る要素(既存にあると仮定しない)**: ① OCR source 用 presigned PUT 発行(`reservePdfUploadUrls`)② R2 CORS の `application/pdf` PUT(Cloudflare 実設定 = OT 確認・§12)③ **PUT 完了通知の受け口(`finalizePdfSource`)** ④ 通知後の R2 読み出し(source GET・専用 timeout)⑤ object ↔ user/operation の対応付け(key 規約 §3。台帳なし)。

**カード画像添付経路は「型」としてのみ参照**(OCR source 用の経路は存在しない): 写せる形 = `presignPutUrl`(Content-Length/Type 署名焼込)の呼出形・HEAD + contentLength 検証(`finalizeAsset:166-168` と同型)・client 直 PUT の saga 形(`lib/media/upload.ts:729`)。新設する部分 = 上記 ①③④⑤ の全部と、`reserveAsset` 不再利用(入力 zod が画像 mime enum + 寸法必須で、`assets` 台帳 INSERT が本質。PDF は台帳を持たない)。

## 3. key 設計と「台帳を作らない」の決定

**key = `src/{userId}/{idempotencyKey}/{fileId}.pdf`**(kickoff 第 1 案 `src/{operationId}/…` は presign 時点で op 行が無く不成立 — op 前倒し作成は新 status + `exam_id` NOT NULL 解除 = migration が要る)。top-level `src/` = lifecycle rule 1 本(調査②§2.4)。3 セグメント全て server 導出(idempotencyKey / fileId は client 発行だが **uuid v4 形状を検証してから埋める** — path injection 不能)。client は key 文字列を送らない。idempotencyKey は **batch 開始時(最初の presign 時)に発行**し submit まで同一。file 追加 = 同 batch に fileId 追加 / 削除 = manifest から外すのみ(残骸は lifecycle)。

**分岐の決定: reserve レコードは作らない(台帳なし)。** 理由:
1. **operation より前に生きるレコード = 新しいライフサイクル**(放棄行の sweep・RLS・policy・iso completeness・migration)が丸ごと増える。②-4b の必要(所有解決と回収)に対して過大。
2. 所有解決は key 規約 + op 行の (userId, idempotencyKey)(既存 UNIQUE)で足りる。回収は §6 の「明示 DELETE + lifecycle」で閉じ、op 以前の残骸に台帳を要求しない(`listObjects('src/')` で運用列挙は可能)。
3. 0032 の「表を残すと保持前提と誤読される」判断(②-4a spec §4.1)と整合。
**対価(明示)**: 完了通知が返した pageCount を server が**保持しない**ため、submit の pre-tx 合計判定は client echo に依る(→ D6 の二重ゲートで機械保証は pipeline 側に置く)。台帳ありなら count 1 回 + 厳密な pre-tx 保証が得られるが、上記コストと引き換えにしない。

## 4. 設計決定

**D1. rasterizer = `@hyzyla/pdfium`(WASM)。mupdf は不採用。**
① license: mupdf は AGPL-3.0-or-later — 商用 closed SaaS の server 利用不可(商用ライセンス無しでは)。pdfium は MIT。これが決定打。② wasm 4.0MB vs 10.4MB。③ 性能同等(支配項は共通の sharp webp encode ≈170ms/page・調査③)。④ encoder 非内蔵だが既存 sharp を使うため新規 encoder 依存なし。⑤ native(@napi-rs/canvas)は Turbopack build 不成立(調査③)。リスク(受容): wrapper 小規模 → exact pin + 使用 API 5 つ(`init`/`loadDocument`/`getPageCount`/`getPage`/`render`)を薄い自前 module に閉じ込める。

**D2. モデル入力 = レンダリング済みページ画像列(PDF native 入力・選択的 rasterize は不採用)。**
理由: ① crop 元 = ページレンダリング(②-4a spec:170 凍結規則)は両案共通 ② PDF 入力時の box_2d 座標系一致が未検証(調査①§4.3)③ 全ページ rasterize の実測コストが小さい(40p ≈ 7.5s local・調査③)④ 入力を画像列に統一すると prompt / OCR schema / normalize / crop / publish が**すべて不変**。品質確認は stg smoke の実 PDF 投入。

**D3. 混在可(画像 + PDF を 1 upload に)。** 合計 = 画像枚数(1 file = 1 ページ)+ 各 PDF のページ数、上限は既存 `OCR_MAX_PAGES = 40` **一本**。`MAX_PDF_PAGES`(PDF 単体 40)は冗長ゆえ**廃止**(単体 >40 は「合計に収まり得ない」として完了通知が弾く)。submit は順序付き manifest(`[{kind:'image', fileIndex} | {kind:'pdf', fileId, filename, pageCount(echo), declaredBytes}]`)で選択順を運び、Gemini parts 順 = 選択順を維持。`source_documents.fileType` = **PDF を 1 つでも含めば 'pdf'**、画像のみは 'image'(用途 = 運用 SQL での経路切り分け。読者現存なしは承知の上で永続行に虚偽を書かない)。filename は既存合成規則(単一 = 原名 / 複数 = 「A.pdf ほか N 件」)。

**D4. page count の正本 = server rasterizer(2 箇所・同一関数)。client 判定は廃止。**
- **`pdf-page-count.ts`(regex)と test を削除**。理由: PDF 1.5+ は ObjStm 圧縮で正規表現に見えず(repo の 8p_textonly.pdf が実際に 0・調査③§2.5)、0 は `pages > 40` を false にする fail-open。直すには ObjStm inflate + PDF パース = 自作対象でない。client と server の 2 実装は無言でズレる。**client に wasm は入れない**(PDF 選択のたびに 4MB を落とす価値がない)。
- **1 箇所目 = 完了通知(`finalizePdfSource`)**: GET → `loadDocument` → `getPageCount()`(**レンダリングなし**)。単体 >40 / 解析不能(壊れ・暗号化)は**そこで止め**、object を即 DELETE して error を返す(§6 マトリクス)。正常は `{pageCount}` を返す(DB 書込なし・§3)。
- **2 箇所目 = pipeline count phase(authoritative)**: render 前に全 PDF を数え直し(render 用 GET とは別の 1 巡・§D8)、合計 >40 は **1 ページも rasterize せず** terminal(`page_limit_exceeded`)。通知後に object が差し替わる窓(presign 有効 600s 内の再 PUT)もここが塞ぐ。
- 通知の応答 pageCount は **UI 表示と pre-tx 判定の echo** に使う(D6)。

**D5. UI 状態遷移(新規状態の定義・文言は決めない)。**
既存 `FileEntry` は `processing / ready / error`。PDF 用に **`uploading` / `counting` を新設**:

| kind | 遷移 |
|---|---|
| pdf | `uploading`(presign→PUT 中)→ `counting`(完了通知往復中)→ `ready`(pageCount 確定・N ページ表示)/ `error`(PUT 失敗・単体 40 超過・解析不能) |
| image | `processing`(圧縮中)→ `ready` / `error`(**従来どおり**・選択時に 1 file = 1 ページ確定) |

合計ページ数(ready の画像枚数 + Σ ready PDF の pageCount)と上限 40 を**常時表示**し、超過時はどの entry を外せば収まるか判別できる表示にする(実文言・見た目は ③ design token 後)。`uploading` / `counting` 中の entry は合計に含めない(不確定)。submit は全 entry が `ready` かつ合計 ≤ 40 で有効化。

**D6. 上限判定の配置(3 層)と既存誤りの修正。**
- 層 1(UI): D5 の常時表示 + submit 無効化。
- 層 2(submit pre-tx): 画像枚数 + PDF manifest の echo pageCount の合計で判定し、超過は **行ゼロで却下**。→ **「入力検証がすべて終わってから tx を開く」現行順序は維持される**。ただし echo は改竄可能なため機械保証ではない — 改竄 echo は層 3 で terminal になり、その場合のみ「行(exam/doc/op)が生まれてから失敗」へ倒れる(**bounded residual・明示**)。
- 層 3(pipeline count phase・**authoritative**): D4 の 2 箇所目。ここが唯一の機械保証。
- **既存誤りの修正**: `submit-upload.ts:135` の `files.length > OCR_MAX_PAGES` と `:323` の `pagesTotal: files.length` は**ファイル数**基準 — 画像のみの現行では 1 file = 1 ページで偶然一致するが、PDF 混在で破綻する。層 2 をページ数基準(画像枚数 + Σecho)に書き換え、`pagesTotal` は: 画像のみ = 枚数(従来値・意味は「ページ数」に確定)/ PDF 含み = **NULL で INSERT → pipeline count phase の fenced CAS で確定値を書く**。`expected_source_count` も同形(画像のみ = 枚数 / PDF 含み = 0 sentinel → CAS で 画像枚数+実ページ数)。schema コメントは「作成時確定(画像)/ count phase 確定(PDF)」へ改訂。publish の読者 3 箇所(`publish-prepared.ts:92,135,234`)は無変更。

**D7. 上限(暫定・実測後見直し)**: per-file **50MB**(presign の Content-Length 署名 + HEAD 再検証)/ 1 upload の PDF 冊数 **≤ 10** / 合計ページ ≤ 40(D3)。

**D8. rasterize の実行制約**: after() 内・**count phase と render phase の 2 巡 GET**(合計判定をレンダリング前に完了させつつ、同時保持を 1 冊分に保つ — 全冊のバイトを掴んだまま数えない)。render は 1 ページずつ逐次(既存「peak 同時 decode = 1」の拡張)。出力 = webp(quality 80・長辺 2048px = 既存 `MAX_IMAGE_WIDTH_OR_HEIGHT` 同値)。ページ画像は既存 `verifyImageBytes` ループへそのまま合流(経路統一・寸法取得点を増やさない)。source_id はページごとに server 採番(既存 `randomUUID()`)。source GET は専用 timeout(暫定 60s — 既定 `GET_TIMEOUT_MS` 10s は 50MB に不足しうる)。

**D9. 冪等・競合**: 完了通知は**無状態**(DB 書込なし・重複呼出 = 重複 GET のみで無害)ゆえ新しい冪等面を作らない。submit は既存契約のまま(同一 idempotencyKey replay = 状態不問 3 ID 返却・after() 再スケジュールなし / 並行 submit = advisory lock + live-op gate / lease は after() 生存表明で意味・値とも不変。PUT〜通知中は op が無く lease 無関係)。

**D10. ページ番号は永続化しない(見送りを明示)。** `preparedFigureSchema` / `asset_derivations` に page を足さない(source_id がページと 1:1・永続消費者なし・preparedPayload **V2 追加**ルールのコスト大)。Gemini 応答 schema の `page?: number` 予約(`ocr-image-crop-response.ts:33`)は凍結のまま(dead reservation と明記。撤去は arm 比較を要する別 task)。normalize が destructure しない現状も不変。

**D11. 時間予算 = 構造変更なし・値は実測後(既存方針)。** rasterize 40p ≈ 7.5s(local)+ GET 2 巡。予算 660s の構造(単一 deadline + 残余参照)は不変。`logPhase` に `fetch_source` / `count` / `rasterize` を追加(実測材料)。count/render 前に残余チェック(既存 pre-Gemini チェックと同型)。**Vercel 1 vCPU 実測が無い**ため値の見直しは cutover 後実測。

## 5. legacy `process.ts` の削除(②-4b と独立・別 commit)

`processUpload()` は runtime 呼出元ゼロのまま `'use server'` で生存し、PDF 受理実装(Gemini への PDF 丸投げ)と旧ページ合算を持つ(調査①§1.4)。**②-4b の前提整理として独立 commit で削除する**。既知の残参照(削除 closure に含める): `upload-form.tsx:27-30` の **型 import 2 つ**(`ProcessUploadErrorCode` / `ProcessUploadErrorDetails` — 移設先を用意)/ `tests/contract/upload-result.contract.test.ts`(対象消滅)/ `upload-persistence.ts` の専属 export(他所参照の有無を含め **`git grep` で参照ゼロを確認し出力を commit message / session doc に提示**)。

## 6. 削除設計 — 明示 DELETE 本線 + lifecycle 保険(回収経路は本 spec で新規定義)

**既存の回収経路は存在しない**(gc-image-assets の source lane・`r2_gc_delete_source` catalog は 0032 で撤去済・調査②§2.3)。以下を新規に定義:

**本線 1(完了通知)**: 単体 40 超過・解析不能の reject 時、**通知 handler がその場で DELETE**(key を知っている唯一の即時点)。
**本線 2(pipeline 出口)**: 成功 publish 後 / terminal 化後 / start_cas_lost / commit_raced の**全経路**で、closure の manifest から導出した全 source key に `deleteObject`(never-throw・404=ok)。失敗は `integration_failures` **`r2_source_delete`(catalog 新設**・0032 で消えた `r2_gc_delete_source` の後継)+ lifecycle へ委譲。raced/lost でも削除してよい根拠: key は (userId, idempotencyKey) 専有で、op が死んでいれば読む者はいない。
**保険**: lifecycle rule — prefix `src/`・maxAge 86400s(1 日・暫定)。削除実行は「典型 24h 以内」で**保証なし**(調査③§3)→ 実効上限 ≈48h と明記。設定 = OT 手動(§12)。

| 放棄ケース | 残るもの | 回収 |
|---|---|---|
| presign のみ(PUT 来ない) | 無し | 不要 |
| PUT 後 通知が来ない / 通知後 submit しない(選択削除・離脱) | object のみ(op 無し) | **lifecycle のみ**(台帳なしゆえ trigger なし・受容) |
| 完了通知で reject(単体超過・解析不能) | — | **本線 1**(通知 handler が即 DELETE) |
| submit 後 after() 未実行 / pipeline 途中死(platform kill) | object + 非終端 op | op = lease 失効 → reconciler terminal 化(既存)。object = **lifecycle**(reconciler に R2 I/O を足さない) |
| pipeline 完走(成功 / terminal — 層 3 の page_limit_exceeded 含む) | — | **本線 2** |

## 7. 検証・pin の張り直し

| 現行 pin | 扱い |
|---|---|
| `submit-upload.test.ts:448` r2 非 import(regex) | **置換**: 許可 import を `headObject` のみに限定する regex pin |
| `upload-pipeline.test.ts:893` r2 非 import(regex) | **置換**: 許可 import を `getObject` / `deleteObject` のみに限定(putObject 不可 = source を server が書かない) |
| iso `upload-pipeline.test.ts:387` PUT key に `/src/` 無し | **維持(生き残る)**: server putObject は今後も crop key だけ |

**新規 pin**: ① key builder 純関数 unit(`src/{uuid}/{uuid}/{uuid}.pdf` 形状 + 非 uuid reject)② iso: 成功経路で全 source key に deleteObject ③ iso: terminal 経路(page_limit_exceeded / gemini_call_failed)でも同様 ④ unit: 完了通知の reject 分岐が DELETE を呼ぶ ⑤ unit: count phase が合計超過時に **render 関数を一度も呼ばない** ⑥ iso: `expected_source_count` CAS の fencing(lease 不一致で書かない)⑦ unit: rasterize 逐次(peak 同時 1・既存 decode pin と同型)。red 実証は plan で task 化。docs 更新(§11 置換 + harness.md に lifecycle rule 1 行)もハンドオフに含める。

## 8. 変更一覧と migration 判定

**migration = 不要**(新表・新列・status 値追加なし。fileType 'pdf' は既存 union、pages_total/expected_source_count は既存列の値運用)。

| 種別 | file |
|---|---|
| 新規 | `lib/media/pdf-rasterize.ts`(pdfium ラッパ)/ `lib/media/source-object-key.ts`(key builder)/ `_actions/reserve-pdf-upload.ts` / `_actions/finalize-pdf-source.ts`(完了通知) |
| 変更 | `submit-upload.ts`(manifest 分岐 + HEAD + ページ基準判定 = :135/:323 修正 + fileType)/ `upload-pipeline.ts`(count/render 2 phase + 出口 DELETE + CAS + phase log)/ `lib/storage/r2.ts`(getObject timeout 引数化)/ `lib/integration-failures.ts`(`r2_source_delete`)/ `upload-form.tsx`(uploading/counting 状態 + 合計常時表示 + copy)/ `_lib/constants.ts`(PDF 上限定数追加・`MAX_PDF_PAGES` 削除) |
| 削除 | `_lib/pdf-page-count.ts` + test(D4)/ **legacy `process.ts` 一式(§5・独立 commit)** |
| deps | `@hyzyla/pdfium` exact pin(新規 dep = 本 spec の OT 承認で事前相談成立) |
| docs | architecture.md §6 行置換(§11)/ harness.md 追記 |

## 9. 未確定(埋めない)

- **PUT 完了 → pageCount 確定までの所要時間**(R2 GET + WASM init + loadDocument)。実測が無い。counting 状態の滞留時間 = UX に直結するが、「アップロード時間に対して誤差」とは**書かない**(50MB GET + 初回 wasm init は独立したコスト)。
- WASM が Vercel の**実 function** に同梱されるか(local build の nft.json + chunk 参照まで・調査③)。→ **実装第 1 task = probe route 1 本の stg deploy 実証**(落ちたら D1 に戻る)。
- function bundle size 上限に対する余裕(wasm 単体 4.0MB は測定済・trace 全体は未測定)。
- R2 CORS の実設定(repo 管理外)。論点は `application/pdf` の PUT 許可の有無のみ(既存添付 PUT は稼働中)。
- Gemini inline byte 上限(送信物はレンダリング済み webp 列 ≈3-4MB で既存 40 枚経路と同規模)。
- 単一 40 ページ文書の文書オブジェクトメモリ(実測は 5p/8p の反復・調査③)。
- lifecycle の秒指定 maxAge が実 API で受理されるか(docs の schema 記述のみ)。

## 10. UI 要件(状態は D5・ここは残件のみ)

copy 差し替え(「PDF は現在未対応です」撤回・`accept` 復帰・上限案内)/ PUT・通知失敗の error 表示と entry 単位のやり直し / poll・result page は無変更。文言確定は非スコープ(D5 冒頭)。

## 11. architecture.md §6 行の置換文言(実装時にこの内容で置換)

> | **source(OCR 元 PDF)の R2 保持は「処理中のみ」。置き場は top-level `src/` prefix(`src/{userId}/{idempotencyKey}/{fileId}.pdf`)のみ・server は source を PUT しない(client presigned のみ)・完了通知 reject と pipeline 出口(成功/失敗とも)で明示 DELETE + lifecycle(`src/` maxAge 1 日・実効 ≈48h)が保険。`source_assets` 表は存在しない(台帳なし・key 規約で辿る)** | 著作物の疑い(恒久保持しない)は維持。経緯: 「最小時間のみ保持 + purge」→「そもそも置かない」(2026-08-04 OT・旧 ②-4a)→ **PDF 対応で body cap(4.5MB)を原本が越えるため「処理中のみ置く」へ改訂(2026-08-07 OT・②-4b)**。画像入稿は従来どおり R2 非経由(FormData → メモリ) | 証明: source key builder unit + iso(出口 DELETE 両経路 / server PUT は crop key のみ)| 本 spec |

## 12. OT 作業(repo 外・実装と並行可)

1. R2 lifecycle rule 設定(`recallmint-dev` + prod bucket・prefix `src/`・maxAge 86400s)。
2. R2 CORS に `application/pdf` の PUT が通るか確認。
3. 新 dep `@hyzyla/pdfium` の承認(= 本 spec 承認に含まれる)。
