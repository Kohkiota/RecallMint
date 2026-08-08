# ②-4b PDF 対応 実装 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)。

**Goal:** PDF を R2 一時保存 + server WASM rasterize で既存 OCR pipeline(不変)に合流させる。
**Spec(凍結)**: `docs/superpowers/specs/2026-08-07-ocr-2-4b-pdf-rasterize-design.md`(r3 確定)。仕様変更が要る場合は停止して OT。
**調査正本**: `docs/audit/2026-08-07-ocr-2-4b-*.md` 3 本。

## Global Constraints(全 task 共通・task からは参照のみ)

- **凍結境界**: prompt / OCR schema / normalize-prepared / crop-and-store / publish 契約に触らない(spec の中心的主張)。
- key = `src/{userId}/{uploadSessionId}/{fileId}.pdf`(3 セグメント uuid v4 検証・client は key を送らない)。**spec r5: `uploadSessionId`(R2 namespace)と `idempotencyKey`(submit 試行)は別値**。生存範囲 = spec §3.2 の server outcome 表(accepted / throw で無効化・terminal 後は新 session)。強制力の限界 = §3.3(client 規約であり server の機械保証ではない)。
- 暫定値(実測後見直しコメント必須): `MAX_PDF_BYTES = 50MB` / `MAX_PDF_TOTAL_BYTES = 200MB`(batch 合計・spec r4)/ `MAX_RENDERED_WEBP_TOTAL_BYTES = 30MB`(render 累計・超過 = terminal `webp_limit_exceeded`・spec r4)/ source GET timeout 60s / webp quality 80・長辺 2048(`MAX_IMAGE_WIDTH_OR_HEIGHT` 共用)/ lifecycle maxAge 86400s(OT 設定)。
- 上限 = 合計ページ 40(`OCR_MAX_PAGES`)1 本。冊数上限なし。echo pageCount ≥1 要求。
- 層 2(pre-tx echo)= UX の早期棄却・防御ではない。正本 = 層 3 count phase(spec D6 の誤読禁止条項)。
- review: feat は canonical(requesting-code-review 既定経路)+ Codex(codex-review.sh)→ 未解決 Critical/Important 0。red 実証は **gate を個別に変異**([[feedback_mutate_gates_individually_in_red_verification]])。
- sprint 完了 gate: whole-repo lint 0 / full test / test:iso / `pnpm run audit` 0 / **deps を触るため** `pnpm install --frozen-lockfile` + typecheck + build 全 exit 0。
- 簡潔性規律・DDD 方針・env 追加なし(R2 既存 env のみ)。

---

### Task 1: WASM stg deploy 実証(gating・chore)

- 目的: 最大の未確定「wasm が実 function に同梱されるか」を先に潰す(spec §9)。
- 制約: dep `@hyzyla/pdfium` **exact pin** 追加。probe route `app/api/pdfprobe-pdfium/route.ts` 新規(`runtime='nodejs'`・**`auth()` 必須 = 認証ユーザーのみ**(Codex I14: 無認証で WASM init を反復可能な公開 endpoint にしない)・入力なし・埋込み最小 1p PDF bytes を `loadDocument`→`getPageCount` して `{pages: 1}` を返す)。route 名は `_` 始まり禁止(private folder 規則で routing から落ちる — 調査③の実測罠)。local 検証 = `pnpm build` + `.next/server/app/api/pdfprobe-pdfium/route.js.nft.json` に `pdfium.*.wasm` が列挙されることを grep。
- 完了条件: build green + nft grep 一致 + `chore(ocr)` [no-review](一時 probe・Task 8 で削除)。**commit 後 OT push → CC が stg で GET 実証(200 + pages:1)。NG = 停止(spec D1 の rasterizer 再選定に巻き戻し)。実証待ちの間 Task 2-3 は先行可(pdfium 非依存)。Task 4 以降は実証 green を前提。**

### Task 2: legacy `process.ts` 削除(独立 commit)

- 目的: PDF 受理実装を持つ死んだ Server Action の撤去(spec §5・②-4b と独立)。
- 制約: 型 2 つ(`ProcessUploadErrorCode` / `ProcessUploadErrorDetails`)を `_lib/upload-error-types.ts`(新規・directive 無し)へ移設し `upload-form.tsx:27` の import を差し替え。`_actions/process.ts` / `tests/contract/upload-result.contract.test.ts`(対象消滅)/ `upload-persistence.ts` の**専属** export(移設後に参照ゼロのもののみ)を削除。**2 系統 grep**(`git grep -n "processUpload"` / `git grep -n "_actions/process"`)で参照ゼロを確認し、出力を commit message と session doc に提示。
- 完了条件: 2-grep ゼロ + full test green + `refactor(upload)` [no-review](到達不能コード削除・ロジック変更なし)。

### Task 3: 基盤 pure 層(key builder / 定数 / r2 timeout / catalog)

- 目的: 後続 task が乗る純関数と定数(spec §3 / D7 / D8 / §6)。
- 制約: `lib/media/source-object-key.ts` 新規 — `sourcePdfObjectKey(userId: string, idempotencyKey: string, fileId: string): string`。3 引数とも uuid v4 形状検証、不一致は throw(path injection 遮断)。`_lib/constants.ts` に `MAX_PDF_BYTES` / `MAX_PDF_TOTAL_BYTES` / `MAX_RENDERED_WEBP_TOTAL_BYTES`(3 つとも暫定・実測後見直しコメント)。`lib/storage/r2.ts` の `getObject` に `opts?: { timeoutMs?: number }`(既定 10s 不変・呼出側非破壊)。`lib/integration-failures.ts` catalog に `r2_source_delete`(§6 本線 2 の記帳先・`r2_gc_delete` の書式に倣う)。
- 完了条件: unit(key 形状 + 非 uuid reject。**red = 検証を 1 つずつ外して fail 実証**)+ 既存 r2/catalog test green + `feat(ocr)` [reviewed]。

### Task 4: `pdf-rasterize` module

- 目的: pdfium を薄い module に閉じ込める(spec D1 / D4 / D8)。
- 制約: `lib/media/pdf-rasterize.ts` 新規。API(後続 task の契約): `loadPdf(buf: Buffer): Promise<PdfHandle>` / `PdfHandle = { pageCount: number; renderPageWebp(i: number): Promise<{ webp: Buffer; width: number; height: number }>; destroy(): void }`。render = ページ pt 寸法から scale 導出(長辺 2048)→ BGRA raw → 既存 sharp で webp q80。使用 pdfium API は 5 つ(`init`/`loadDocument`/`getPageCount`/`getPage`/`render`)に限定。解析不能(壊れ・暗号化)は typed error(`PdfParseError`)。wasm init は module 内 lazy singleton。**handle は失敗経路でも必ず destroy(try/finally)**。設計記録として明記: 同期 WASM 実行は途中中断不能 — per-page timeout は設けず、hard cap は invocation の maxDuration(Codex 独立論点 3 への回答)。
- 完了条件: unit = **実 wasm + 実 fixture**(`scripts/ai/ocr-samples/mock-exam-set.pdf` 5p: pageCount=5・render 寸法 / 壊れ bytes → PdfParseError / **暗号化 PDF fixture → PdfParseError**(Codex I8)/ 失敗経路の destroy 呼出)+ **逐次 pin(同時 render 1・計測 mock)red 実証** + `feat(ocr)` [reviewed]。

### Task 5: reserve + finalize actions

- 目的: presign 発行と PUT 完了通知(spec §2 / D4 / §6 本線 1)。
- 制約: `_actions/reserve-pdf-upload.ts` = 認証 → zod strict(idempotencyKey / fileId[] uuid v4・**fileId 重複禁止・件数 ≤ 40**(ページ ≥1/冊ゆえ 40 超は無意味 — 入力検証であって商品上限ではない)・declaredBytes ≤ `MAX_PDF_BYTES`・**Σ declaredBytes ≤ `MAX_PDF_TOTAL_BYTES`**(spec r4))→ `presignPutUrl(sourcePdfObjectKey(...), 'application/pdf', declaredBytes)` × N → `[{fileId, uploadUrl}]`。**DB 無し**。`_actions/finalize-pdf-source.ts` = 認証 → `headObject`(実在 + **contentLength === declaredBytes 一致**(Codex I5・presign 署名値との契約 pin)+ ≤ `MAX_PDF_BYTES`)→ `getObject({timeoutMs: 60_000})` → `loadPdf` → pageCount。**pageCount > `OCR_MAX_PAGES` or `PdfParseError` → `deleteObject` してから typed error 応答**(spec §6 本線 1)。正常 = `{pageCount}`(**DB 書込なし・無状態**)。
- 完了条件: unit(r2 / pdf-rasterize は mock)= 正常応答 / reject 2 種で **deleteObject 呼出 pin(red = DELETE を外して fail)** / **所有権 pin = 両 action の入力 schema に key 文字列が存在せず、key は認証 userId からのみ構築される**(Codex I7: 「他人 key の HEAD 不在」でなく構築経路そのものを pin)+ `feat(ocr)` [reviewed]。

### Task 6: upload-form(UI 状態 + batch flow + client 判定廃止)

- 目的: PDF batch UX・合計の確定/未確定表示(spec D5 / §10)。
- 制約: `FileEntry` の pdf kind に `uploading` / `counting` 追加(遷移 = spec D5 表: uploading→counting→ready(N)/error)。**`_lib/pdf-page-count.ts` + test + `MAX_PDF_PAGES` を削除**(client 判定廃止・client bundle に WASM を入れない)。合計表示 = 3 状態(`uploading`/`counting` が 1 つでもあれば「合計未確定」/ 全確定「合計 N」/ N>40「合計 N・超過」)。reducer は既存構造踏襲(処理中ゼロ加算 + `anyProcessing` 送信停止・`upload-form.tsx:180,197`)— 変えるのは表示のみ。submit payload = 画像 FormData(既存)+ `orderManifest` JSON(`[{kind:'image', fileIndex} | {kind:'pdf', fileId, filename, pageCount, declaredBytes}]`・選択順)。idempotencyKey は **batch 開始時に発行**し presign〜submit 同一。file 追加 = 同 batch へ fileId 追加 / 削除 = manifest から外すのみ。**stale 応答排除**(Codex I11): entry ごとに generation token を持ち、削除済み / retry 済み entry への旧 PUT・finalize 応答は state を書かない。copy: 「PDF は現在未対応です」撤回・`accept="image/*,application/pdf"`・上限案内(実文言は暫定でよい — 確定は design token 後)。
- 完了条件: component test(遷移 / 合計 3 状態 / PUT・通知失敗表示 / manifest 組立 / **削除後の stale finalize 応答が entry を復活させない**)green + `feat(ocr)` [reviewed]。

### Task 7: submitUpload manifest 分岐(層 2)

- 目的: PDF メタ受理と pre-tx ページ基準判定(spec D3 / D6 層 2)。
- 制約: `orderManifest` 分岐 = zod **strict**(uuid 形状・`pageCount ≥ 1`・declaredBytes ≤ `MAX_PDF_BYTES`・**完全性: fileId 重複禁止 / image fileIndex は FormData files と過不足ない全単射(重複・欠番・範囲外拒否)/ 空 manifest 拒否**(Codex I6))→ **Σ declaredBytes ≤ `MAX_PDF_TOTAL_BYTES`**(spec r4)→ `headObject` × N(実在 + **contentLength === declaredBytes** + サイズ・**tx 外**)→ 層 2: 画像枚数 + Σecho > 40 は**行ゼロで却下**(現行「検証完了後に tx」順序維持・`:417`)。`:135` / `:323` をページ数基準へ(画像のみ upload = 従来値のまま = 1 file 1 ページ)。`fileType` = PDF 含み 'pdf' / 画像のみ 'image'。`pagesTotal` = PDF 含み NULL / `expectedSourceCount` = PDF 含み 0 sentinel(画像のみは従来どおり枚数)。sync tx 構造・gate・replay・lease・冪等契約は**不変**。regex pin 置換: r2 import 許可 = `headObject` のみ(`submit-upload.test.ts:448` の後継)。after() closure へ manifest(fileId/filename/pageCount)を渡す。
- 完了条件: unit + iso(層 2 却下 = op/doc/exam 行ゼロ / sentinel 値 / 画像のみ経路の従来値不変)+ **red(層 2 判定変異で fail)** + `feat(ocr)` [reviewed]。

### Task 8: upload-pipeline(count / render phase + CAS + 出口 DELETE)+ probe 撤去

- 目的: 層 3 正本・source 削除本線 2・既存 pipeline への合流(spec D2 / D4 / D6 / D8 / §6)。
- 制約: **count phase** = PDF を 1 冊ずつ `getObject({timeoutMs:60_000})` → `loadPdf` → pageCount + **bytes の sha256 を記録** → `destroy` + 解放(全冊保持しない)。合計(画像 + Σ実ページ)> 40 → `page_limit_exceeded` terminal(**render 0 呼出**)。合格 → fenced CAS UPDATE(`expected_source_count` = 合計 / `pages_total` を**同一 UPDATE 文で原子的に**・WHERE id + lease_version + status='processing')。**CAS 更新件数 0 なら render / Gemini へ進まない**(Codex I9)。**render phase** = 再 GET → **sha256 を count 時の記録と照合し不一致 = terminal `source_changed` (Codex C1: 2 巡 GET 間の差し替え TOCTOU を塞ぐ・presign 600s 窓内の再 PUT 対策)** → `renderPageWebp` を 1 ページずつ・**webp 累計 > `MAX_RENDERED_WEBP_TOTAL_BYTES` で terminal `webp_limit_exceeded`**(spec r4・loud)→ 既存 `verifyImageBytes` 逐次ループへ **manifest 順**で合流(source_id 採番・parts 組立・以降の既存 phase は無改変)。count/render 開始前に残余予算チェック(既存 pre-Gemini と同型)。**出口 DELETE は列挙分岐でなく pipeline 外周の try/finally で構造保証**(Codex C4: 削除対象 key 集合を pipeline 開始前に固定し、成功 / terminal / raced / lost / **unexpected throw** の全経路を外周 1 箇所で覆う)・失敗は `r2_source_delete` 記帳。`logPhase` に `fetch_source` / `count` / `rasterize` + **40p 相当 fixture でのピーク保持量を計測 log に出す**(Codex C3・assert でなく実測材料)。regex pin 置換: r2 import 許可 = `getObject` / `deleteObject` のみ。**Task 1 の probe route を削除**。
- 完了条件: iso(成功経路 DELETE 全 key / terminal 経路 DELETE / **throw 注入(unexpected)でも DELETE** / CAS fencing = lease 不一致・更新 0 件で不進行・**sentinel(0)のまま publish に到達しない** / **同一 idempotencyKey の replay 並行で敗者 DELETE が勝者を壊さない時系列**(Codex I10)/ server putObject key = crop のみ維持 / **terminal 後 doc failed = poll 'failed'**(Codex I18))+ unit(超過時 render 0 呼出 / sha256 不一致 → source_changed / **webp 累計超過 → webp_limit_exceeded**)+ **red = DELETE・CAS・超過 gate・sha 照合・webp 累計 gate を個別変異** + `feat(ocr)` [reviewed]。

### Task 8.5(r5 追補): uploadSessionId 分離の反映

- 目的: spec r5(`794717a`)§13 の申し送りを既 commit / 進行中 task へ反映する。
- 制約: **T3 `sourcePdfObjectKey` / T5 の 2 action は引数の意味と名前のみ変更**(ロジック不変)→ **別 commit**・元の `[reviewed]`(`3c40eda` / `351d556`)は書き換えない・修正 commit も canonical + Codex を通す。T6 は spec D5 の client 状態機械(発行 / 維持 / 無効化 / **terminal 再試行で `ready` → `uploading` 戻し + 新 session で reserve→PUT→finalize**)。T7 は wire 契約(§3.4)受領 + uuid v4 検証 + HEAD 対象 key 導出 + after() closure へ `uploadSessionId` を渡す。T8 は count/render/DELETE の key 導出 + **replay / raced / lost 時の DELETE 安全性の再確認**(§3.2 の session 限定が根拠)。
- 完了条件: 各 task の完了条件に吸収(独立 task として切らず、T6 / T7 / T8 の中で実施)。T3/T5 の rename は T6 の前に 1 commit で済ませる。

### Task 9: docs 改訂

- 目的: 不変条件台帳の置換(spec §11・方針転換の恒久記録)。
- 制約: `docs/architecture.md:76` の行を spec §11 の文言で**置換**(stale 注記の追記でなく行ごと)。`docs/harness.md` に lifecycle rule(外部設定・OT 管理・`src/` maxAge 86400s・実効 ≈48h)1 行。session doc(T1 実証結果 / T2 の 2-grep 出力 / 経緯)+ **rollback 節**(Codex I20: 巻き戻し時の `src/` 残骸一掃手順(`gc-src-prefix.ts` の pattern を新 prefix へ改修)・lifecycle rule は残置無害・dep 撤去)+ **`src/` 残骸の手動点検手順 1 行**(`listObjects('src/')`・定期 cron は導入しない = 既存運用方針。Codex I16 は部分採用)。
- 完了条件: `docs(architecture)` ほか [no-review] 即 commit。

### Task 10: sprint close(whole-branch review + 全 gate + smoke handoff)

- 目的: 統合検証と OT への引き渡し。
- 制約: whole-repo `pnpm lint`(--max-warnings=0)/ full `pnpm test` / `pnpm test:iso` / `pnpm run audit` / `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` 全 exit 0。canonical whole-branch review + Codex 独立(両方 Crit0/Imp0 まで・上限 3 周)。**lifecycle rule + CORS は smoke 項目でなく公開前 gate**(Codex I13): OT 設定 → stg smoke で readback 確認が green になるまで prod 反映判断に進まない(順序を session doc に明記)。**公開前 gate にもう 1 行: 新設 2 endpoint(reserve / finalize)の rate limit 要否を launch 前に OT 判断**(認証済みだが外に開く新設面・本 sprint は非導入のまま)。OT smoke 手順書: ① lifecycle rule readback(§12)② 実 PDF(sample 5p/8p)投入 → uploading→counting→ready→submit→result ③ >40 相当の reject(echo 却下 + 層 3 terminal の両方)④ 完了後 R2 `src/` 残骸ゼロ(`listObjects`)⑤ CORS(`application/pdf` PUT)⑥ **実経路の phase log 採取**(fetch_source/count/rasterize — Vercel 実測の初回材料・Codex I15 は本 smoke が実証を兼ねる)。
- 完了条件: 全 gate green を報告に明記(「whole-repo lint exit 0」「test:iso green」「pnpm run audit exit 0」)+ whole-branch Ready to merge Crit0/Imp0 + **停止(OT push / smoke 判断)**。

---

## Codex cross-check の取りまとめ(raw = docs/codex/2026-08-07-plan-ocr-2-4b-pdf.md)

**採用(plan に反映済・出所 = Codex)**: C1 sha256 同一性照合(T8)/ C4 出口 DELETE の try/finally 構造化 + throw 注入 test(T8)/ C3 部分 = ピーク保持量の計測 log(T8)/ I5 declaredBytes 一致検証(T5/T7)/ I6 manifest 完全性(T7)/ I7 所有権 pin の形(T5)/ I8 部分 = 暗号化 fixture + destroy 保証 + 「同期 WASM 中断不能」の設計記録(T4)/ I9 CAS 強化(T8)/ I10 replay 並行 DELETE 時系列 iso(T8)/ I11 UI stale token(T6)/ I12 部分 = reserve 件数 ≤ 40 入力検証(T5)/ I13 公開前 gate 化(T10)/ I14 probe 認証(T1)/ I16 部分 = 手動点検手順(T9)/ I18 terminal→poll 確認(T8)/ I20 rollback 節(T9)。

**OT 裁定済(spec r4 で採用)**: C2 = batch 合計 declaredBytes ≤ 200MB(T5/T7)+ render 後 webp 累計 ≤ 30MB terminal(T8)。いずれも暫定・実測後見直し。

**見送り(理由付き)**: I15 中間 stg 実証(sprint close smoke が実証を兼ねる — 現行 push 運用と整合)/ I17 entry 削除時 best-effort DELETE(spec §6 で lifecycle 受容を決定済)/ I19 依存保守(既存 audit gate + exact pin で担保)。endpoint rate limit は本 sprint 非導入のまま **公開前 gate の判断項目へ昇格**(T10・launch 前 OT 判断)。

**最終行数**: 92 行(規律 150-250 の下限側・全体ルールは Global Constraints に一度だけ)。
