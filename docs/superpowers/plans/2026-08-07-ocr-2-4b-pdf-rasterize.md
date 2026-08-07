# ②-4b PDF 対応 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** PDF を R2 一時保存 + server WASM rasterize で既存 OCR pipeline(不変)に合流させる。
**Spec(凍結)**: `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md`(r3 確定)。仕様変更が要る場合は停止して OT。
**調査正本**: `docs/audit/2026-08-07-ocr-2-4b-*.md` 3 本。

## Global Constraints(全 task 共通・task からは参照のみ)

- **凍結境界**: prompt / OCR schema / normalize-prepared / crop-and-store / publish 契約に触らない(spec の中心的主張)。
- key = `src/{userId}/{idempotencyKey}/{fileId}.pdf`(3 セグメント uuid v4 検証・client は key を送らない)。
- 暫定値(実測後見直しコメント必須): `MAX_PDF_BYTES = 50MB` / source GET timeout 60s / webp quality 80・長辺 2048(`MAX_IMAGE_WIDTH_OR_HEIGHT` 共用)/ lifecycle maxAge 86400s(OT 設定)。
- 上限 = 合計ページ 40(`OCR_MAX_PAGES`)1 本。冊数上限なし。echo pageCount ≥1 要求。
- 層 2(pre-tx echo)= UX の早期棄却・防御ではない。正本 = 層 3 count phase(spec D6 の誤読禁止条項)。
- review: feat は canonical(requesting-code-review 既定経路)+ Codex(codex-review.sh)→ 未解決 Critical/Important 0。red 実証は **gate を個別に変異**([[feedback_mutate_gates_individually_in_red_verification]])。
- sprint 完了 gate: whole-repo lint 0 / full test / test:iso / `pnpm run audit` 0 / **deps を触るため** `pnpm install --frozen-lockfile` + typecheck + build 全 exit 0。
- 簡潔性規律・DDD 方針・env 追加なし(R2 既存 env のみ)。

---

### Task 1: WASM stg deploy 実証(gating・chore)

- 目的: 最大の未確定「wasm が実 function に同梱されるか」を先に潰す(spec §9)。
- 制約: dep `@hyzyla/pdfium` **exact pin** 追加。probe route `app/api/pdfprobe-pdfium/route.ts` 新規(`runtime='nodejs'`・入力なし・埋込み最小 1p PDF bytes を `loadDocument`→`getPageCount` して `{pages: 1}` を返す)。route 名は `_` 始まり禁止(private folder 規則で routing から落ちる — 調査③の実測罠)。local 検証 = `pnpm build` + `.next/server/app/api/pdfprobe-pdfium/route.js.nft.json` に `pdfium.*.wasm` が列挙されることを grep。
- 完了条件: build green + nft grep 一致 + `chore(ocr)` [no-review](一時 probe・Task 8 で削除)。**commit 後 OT push → CC が stg で GET 実証(200 + pages:1)。NG = 停止(spec D1 の rasterizer 再選定に巻き戻し)。実証待ちの間 Task 2-3 は先行可(pdfium 非依存)。Task 4 以降は実証 green を前提。**

### Task 2: legacy `process.ts` 削除(独立 commit)

- 目的: PDF 受理実装を持つ死んだ Server Action の撤去(spec §5・②-4b と独立)。
- 制約: 型 2 つ(`ProcessUploadErrorCode` / `ProcessUploadErrorDetails`)を `_lib/upload-error-types.ts`(新規・directive 無し)へ移設し `upload-form.tsx:27` の import を差し替え。`_actions/process.ts` / `tests/contract/upload-result.contract.test.ts`(対象消滅)/ `upload-persistence.ts` の**専属** export(移設後に参照ゼロのもののみ)を削除。**2 系統 grep**(`git grep -n "processUpload"` / `git grep -n "_actions/process"`)で参照ゼロを確認し、出力を commit message と session doc に提示。
- 完了条件: 2-grep ゼロ + full test green + `refactor(upload)` [no-review](到達不能コード削除・ロジック変更なし)。

### Task 3: 基盤 pure 層(key builder / 定数 / r2 timeout / catalog)

- 目的: 後続 task が乗る純関数と定数(spec §3 / D7 / D8 / §6)。
- 制約: `lib/media/source-object-key.ts` 新規 — `sourcePdfObjectKey(userId: string, idempotencyKey: string, fileId: string): string`。3 引数とも uuid v4 形状検証、不一致は throw(path injection 遮断)。`_lib/constants.ts` に `MAX_PDF_BYTES`。`lib/storage/r2.ts` の `getObject` に `opts?: { timeoutMs?: number }`(既定 10s 不変・呼出側非破壊)。`lib/integration-failures.ts` catalog に `r2_source_delete`(§6 本線 2 の記帳先・`r2_gc_delete` の書式に倣う)。
- 完了条件: unit(key 形状 + 非 uuid reject。**red = 検証を 1 つずつ外して fail 実証**)+ 既存 r2/catalog test green + `feat(ocr)` [reviewed]。

### Task 4: `pdf-rasterize` module

- 目的: pdfium を薄い module に閉じ込める(spec D1 / D4 / D8)。
- 制約: `lib/media/pdf-rasterize.ts` 新規。API(後続 task の契約): `loadPdf(buf: Buffer): Promise<PdfHandle>` / `PdfHandle = { pageCount: number; renderPageWebp(i: number): Promise<{ webp: Buffer; width: number; height: number }>; destroy(): void }`。render = ページ pt 寸法から scale 導出(長辺 2048)→ BGRA raw → 既存 sharp で webp q80。使用 pdfium API は 5 つ(`init`/`loadDocument`/`getPageCount`/`getPage`/`render`)に限定。解析不能(壊れ・暗号化)は typed error(`PdfParseError`)。wasm init は module 内 lazy singleton。
- 完了条件: unit = **実 wasm + 実 fixture**(`scripts/ai/ocr-samples/mock-exam-set.pdf` 5p を流用: pageCount=5・render 寸法・壊れ bytes → PdfParseError)+ **逐次 pin(同時 render 1・計測 mock)red 実証** + `feat(ocr)` [reviewed]。

### Task 5: reserve + finalize actions

- 目的: presign 発行と PUT 完了通知(spec §2 / D4 / §6 本線 1)。
- 制約: `_actions/reserve-pdf-upload.ts` = 認証 → zod(idempotencyKey / fileId[] uuid v4・declaredBytes ≤ `MAX_PDF_BYTES`)→ `presignPutUrl(sourcePdfObjectKey(...), 'application/pdf', declaredBytes)` × N → `[{fileId, uploadUrl}]`。**DB 無し**。`_actions/finalize-pdf-source.ts` = 認証 → `headObject`(実在 + contentLength ≤ `MAX_PDF_BYTES`)→ `getObject({timeoutMs: 60_000})` → `loadPdf` → pageCount。**pageCount > `OCR_MAX_PAGES` or `PdfParseError` → `deleteObject` してから typed error 応答**(spec §6 本線 1)。正常 = `{pageCount}`(**DB 書込なし・無状態**)。
- 完了条件: unit(r2 / pdf-rasterize は mock)= 正常応答 / reject 2 種で **deleteObject 呼出 pin(red = DELETE を外して fail)** / 越権 fileId は自 userId prefix ゆえ HEAD 不在で落ちる、を green + `feat(ocr)` [reviewed]。

### Task 6: upload-form(UI 状態 + batch flow + client 判定廃止)

- 目的: PDF batch UX・合計の確定/未確定表示(spec D5 / §10)。
- 制約: `FileEntry` の pdf kind に `uploading` / `counting` 追加(遷移 = spec D5 表: uploading→counting→ready(N)/error)。**`_lib/pdf-page-count.ts` + test + `MAX_PDF_PAGES` を削除**(client 判定廃止・client bundle に WASM を入れない)。合計表示 = 3 状態(`uploading`/`counting` が 1 つでもあれば「合計未確定」/ 全確定「合計 N」/ N>40「合計 N・超過」)。reducer は既存構造踏襲(処理中ゼロ加算 + `anyProcessing` 送信停止・`upload-form.tsx:180,197`)— 変えるのは表示のみ。submit payload = 画像 FormData(既存)+ `orderManifest` JSON(`[{kind:'image', fileIndex} | {kind:'pdf', fileId, filename, pageCount, declaredBytes}]`・選択順)。idempotencyKey は **batch 開始時に発行**し presign〜submit 同一。file 追加 = 同 batch へ fileId 追加 / 削除 = manifest から外すのみ。copy: 「PDF は現在未対応です」撤回・`accept="image/*,application/pdf"`・上限案内(実文言は暫定でよい — 確定は design token 後)。
- 完了条件: component test(遷移 / 合計 3 状態 / PUT・通知失敗表示 / manifest 組立)green + `feat(ocr)` [reviewed]。

### Task 7: submitUpload manifest 分岐(層 2)

- 目的: PDF メタ受理と pre-tx ページ基準判定(spec D3 / D6 層 2)。
- 制約: `orderManifest` 分岐 = zod(uuid 形状・`pageCount ≥ 1`・declaredBytes ≤ `MAX_PDF_BYTES`)→ `headObject` × N(実在 + サイズ・**tx 外**)→ 層 2: 画像枚数 + Σecho > 40 は**行ゼロで却下**(現行「検証完了後に tx」順序維持・`:417`)。`:135` / `:323` をページ数基準へ(画像のみ upload = 従来値のまま = 1 file 1 ページ)。`fileType` = PDF 含み 'pdf' / 画像のみ 'image'。`pagesTotal` = PDF 含み NULL / `expectedSourceCount` = PDF 含み 0 sentinel(画像のみは従来どおり枚数)。sync tx 構造・gate・replay・lease・冪等契約は**不変**。regex pin 置換: r2 import 許可 = `headObject` のみ(`submit-upload.test.ts:448` の後継)。after() closure へ manifest(fileId/filename/pageCount)を渡す。
- 完了条件: unit + iso(層 2 却下 = op/doc/exam 行ゼロ / sentinel 値 / 画像のみ経路の従来値不変)+ **red(層 2 判定変異で fail)** + `feat(ocr)` [reviewed]。

### Task 8: upload-pipeline(count / render phase + CAS + 出口 DELETE)+ probe 撤去

- 目的: 層 3 正本・source 削除本線 2・既存 pipeline への合流(spec D2 / D4 / D6 / D8 / §6)。
- 制約: **count phase** = PDF を 1 冊ずつ `getObject({timeoutMs:60_000})` → `loadPdf` → pageCount → `destroy` + 解放(全冊保持しない)。合計(画像 + Σ実ページ)> 40 → `page_limit_exceeded` terminal(**render 0 呼出**)。合格 → fenced CAS UPDATE(`expected_source_count` = 合計 / `pages_total` 同値・WHERE id + lease_version + status='processing')。**render phase** = 再 GET → `renderPageWebp` を 1 ページずつ → 既存 `verifyImageBytes` 逐次ループへ **manifest 順**で合流(source_id 採番・parts 組立・以降の既存 phase は無改変)。count/render 開始前に残余予算チェック(既存 pre-Gemini と同型)。**出口 DELETE** = 成功 / terminal / start_cas_lost / commit_raced の全経路で全 source key へ `deleteObject`・失敗は `r2_source_delete` 記帳。`logPhase` に `fetch_source` / `count` / `rasterize`。regex pin 置換: r2 import 許可 = `getObject` / `deleteObject` のみ。**Task 1 の probe route を削除**。
- 完了条件: iso(成功経路 DELETE 全 key / terminal 経路 DELETE / CAS fencing(lease 不一致で不書込)/ server putObject key = crop のみ維持)+ unit(超過時 render 0 呼出)+ **red = DELETE・CAS・超過 gate を個別変異** + `feat(ocr)` [reviewed]。

### Task 9: docs 改訂

- 目的: 不変条件台帳の置換(spec §11・方針転換の恒久記録)。
- 制約: `docs/architecture.md:76` の行を spec §11 の文言で**置換**(stale 注記の追記でなく行ごと)。`docs/harness.md` に lifecycle rule(外部設定・OT 管理・`src/` maxAge 86400s・実効 ≈48h)1 行。session doc(T1 実証結果 / T2 の 2-grep 出力 / 経緯)。
- 完了条件: `docs(architecture)` ほか [no-review] 即 commit。

### Task 10: sprint close(whole-branch review + 全 gate + smoke handoff)

- 目的: 統合検証と OT への引き渡し。
- 制約: whole-repo `pnpm lint`(--max-warnings=0)/ full `pnpm test` / `pnpm test:iso` / `pnpm run audit` / `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 全 exit 0。canonical whole-branch review + Codex 独立(両方 Crit0/Imp0 まで・上限 3 周)。OT smoke 手順書を session doc に: ① lifecycle rule 設定確認(§12)② 実 PDF(sample 5p/8p)投入 → uploading→counting→ready→submit→result ③ >40 相当の reject(echo 却下 + 層 3 terminal の両方)④ 完了後 R2 `src/` 残骸ゼロ(`listObjects`)⑤ CORS(`application/pdf` PUT)。
- 完了条件: 全 gate green を報告に明記(「whole-repo lint exit 0」「test:iso green」「pnpm run audit exit 0」)+ whole-branch Ready to merge Crit0/Imp0 + **停止(OT push / smoke 判断)**。

---

**最終行数**: 84 行(規律 150-250 の下限側・全体ルールは Global Constraints に一度だけ)。
