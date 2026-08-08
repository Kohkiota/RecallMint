// ②-4a 単一 invocation Sprint Task S-2 / S-3(spec 2026-08-04 §4): submit で受け
// 取ったバイトを**そのメモリのまま** OCR に掛け、prepared_payload を commit し、
// 同じバイトから図版を crop して publish するまでの post-tx phase。
//
// **phase 順序は不変条件**(spec §7.3 / §9-6): OCR → payload commit → crop →
// publish。crop-derived asset 行・R2 object は payload commit の後にのみ作られ、
// crop が落ちても Gemini を再実行せず committed payload の text card を publish する。
//
// directive 無し共有 module(stage-prepared-retry.ts と同じ「'use server' file から
// 参照される directive 無し module」パターン)。
// ここに置く理由は 2 つ:
//   ① `deadlineAt` / `leaseVersion` といったサーバー側の安全弁を引数に持つ。
//      'use server' file の export は client から action-id 経由で到達可能なため、
//      これらを公開 action の引数にしてはいけない(T14a fix round 1・Codex P2 と
//      同じ判断)。
//   ② S-4 で `after()` に載せ替えた(request 応答後に走る)。request 由来の
//      オブジェクト(File / FormData)を一切受け取らない形に固定してある —
//      呼出側が応答前に Buffer を実体化してから渡す契約(引数は Buffer + 文字列のみ)。
//
// **画像 source は R2 に置かない**: 画像バイトは request body だけで完結する
// (spec §2)。R2 へ書くのは crop-derived asset のみで、それは
// lib/media/crop-and-store.ts の責務(PUT key は `users/{uid}/{assetId}.webp` 形
// のみ・本 file は R2 へ PUT しない — unit/iso で pin)。
//
// ②-4b T8(spec §2/§6): **PDF source は一時的に R2 に置く**(`src/` prefix・
// client presigned PUT のみ)。本 file が R2 へ import してよいのは
// `getObject`(count/render phase の再取得)/ `deleteObject`(pipeline 出口の
// 明示 DELETE・本線 2)の 2 つだけ(regex pin で強制)。
//
// **throw しない契約**: 失敗の分類・terminal 化・台帳記録はすべてこの module の
// 内部責務(spec §4.4 の 5 クラス)で、呼出側(submit-upload.ts の `after()`)は
// 薄い呼出 + 防波堤だけを持つ。予期しない throw も catch-all で吸収する。
// **分類ロジックを after() 境界に二重化しない** — 境界の catch は「この契約が
// 破れた場合」だけを best-effort で記録する防波堤であって、失敗クラスの判定者では
// ない(S-4 controller 指示 A)。
//
// **失敗は全て terminal**(spec §4.5): 新経路に resume は無い(旧経路が持っていた
// retryable-failed 再開と backoff の仕組みは移植しなかった)。op を terminal_failed にし、
// 同一 tx で source_document を failed にする(terminalizeAbandonedOperation)。
import { createHash, randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { incrementAiUsage } from '@/lib/ai-usage-counter'
import { GEMINI_TIMEOUT_MS, type GeminiCallResult } from '@/lib/ai/clients/gemini'
import {
  buildSourceIdInterleavedParts,
  type SourceIdImage,
} from '@/lib/ai/clients/ocr-image-crop-parts'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { buildImageCropExplorationPrompt } from '@/lib/ai/prompts/ocr-figure-suffix'
import { buildImageCropResponseJsonSchema } from '@/lib/ai/schemas/ocr-image-crop-response'
import { sourceDocuments, uploadOperations } from '@/lib/db/schema'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { logger } from '@/lib/logger'
import {
  classifyCropOutcome,
  cropFigureFromBuffer,
  type CropAndStoreOutcome,
} from '@/lib/media/crop-and-store'
import { loadPdf, PdfParseError } from '@/lib/media/pdf-rasterize'
import { sourcePdfObjectKey } from '@/lib/media/source-object-key'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { type PreparedPayload } from '@/lib/ocr/prepared-schema'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { deleteObject, getObject } from '@/lib/storage/r2'
import { publishPreparedUploadTx } from '../_actions/publish-prepared'
import { CROP_MIN_REMAINING_MS, MAX_RENDERED_WEBP_TOTAL_BYTES } from './constants'
import {
  buildResultSummary,
  isCropBudgetExhausted,
  planPublish,
  type FigureDisposition,
} from './publish-prepared-plan'
import {
  isUnsupportedOrientation,
  verifyImageBytes,
  type VerifiedImage,
} from './source-image-verify'
import { assemblePreparedPayload, computePreparedHash } from './stage-prepared-payload'
import { callImageCropWithRetry } from './stage-prepared-retry'
import { terminalizeAbandonedOperation } from './terminalize-abandoned-operation'

export type UploadPipelineRefs = {
  operationId: string
  examId: string
  sourceDocumentId: string
}

// ②-4b T8 fix round 2(canonical Critical): 出口 DELETE を skip してよい唯一の
// 条件 = 「fence に負けたと明示的に判明した」こと(`start_cas_lost` /
// `count_cas_lost` / `commit_raced` / `publish_raced` — いずれも「別 invocation が
// この op を所有している」ことが判明したケース)。単一 finally 出口(Codex C4)は
// 維持したまま、`runUploadPipeline` の finally が読む所有権フラグ 1 つだけを
// 深い phase 関数(`runOcrPhase`/`runPublishPhase`)から立てる(参照渡しの
// mutable object・T8 fix round 1 の `PdfRenderProgress` と同じ間接化パターン)。
// **既定は false(削除する)**: 予期しない throw はこのフラグを一度も立てずに
// `runUploadPipeline` の catch へ抜けるため、既定のまま削除される(所有権を
// 失った証拠が無い = 通常は自分が唯一の実行者)。
type OwnershipState = { lost: boolean }

// 呼出側(submit-upload.ts)が request body から実体化した 1 file 分のバイト。
// filename は crop/表示側(S-3 以降)が扱う受領時メタで、本 phase は使わない
// (Gemini に渡すのは バイトと server 採番の source_id だけ)。
export type UploadPipelineFile = {
  buffer: Buffer
  filename: string
}

// ②-4b T7(spec §3.4/D6/D7・T8 の申し送り §13 r5 表): submit-upload.ts の層 2
// (pre-tx echo 検証)を通過した PDF manifest の 1 冊分。PDF 本体バイトはこの
// invocation に無い(R2 直 PUT 済)— T8 の count/render phase が
// `sourcePdfObjectKey(userId, uploadSessionId, fileId)` で GET し直す。
// **`pageCount`/`declaredBytes` は client echo(層 2 の入力)であり信用しない** —
// T8 の count phase が render 前に数え直す値だけが正本(spec D6)。
export type UploadPipelineSourcePdf = {
  fileId: string
  filename: string
  pageCount: number
  declaredBytes: number
}

// ②-4b T7 fix round 1(canonical review Critical): `files`(画像バイト)と
// `sourcePdfManifest`(PDF echo)は disjoint な 2 配列で、画像/PDF が混在した
// submit の **元の選択順(spec §2「manifest 順で合流」/ D3「Gemini parts 順 =
// 選択順を維持」)を復元する手段を失う**。orderManifest を kind で filter した
// 後にはその順序情報は存在しないため、filter する**前**の manifest 順をそのまま
// 写した配列を境界の向こうへ渡す。T8 はこれで `files`/`sourcePdfManifest` を
// manifest 順に zip し直せる。legacy(画像のみ・orderManifest 不在)経路では
// 空配列でよい(選択順 = FormData `files` の到着順のまま・挙動不変)。
export type UploadPipelineSourceOrderEntry =
  | { kind: 'image'; fileIndex: number }
  | { kind: 'pdf'; fileId: string }

// decode 検証で確定した source ごとのメタ。width/height は crop(S-3)が
// box_2d(0-1000 正規化座標)を実ピクセルへ戻す際の分母になるため、decode の
// 場で確定させてここに保持する(decode 済み pixel 自体は verifyImageBytes の
// 中で解放され、この配列には載らない = メモリ見積りの前提)。`bytes` は受領
// Buffer への参照で、crop が同じバイトを再利用する(R2 GET しない = spec §2)。
type VerifiedSource = VerifiedImage & { sourceId: string; bytes: Buffer }

// 失敗理由(upload_operations.last_error_code に入る値)。旧経路の語彙に倣い、
// 新経路固有のものだけを足している。
type PipelineErrorCode =
  | 'image_decode_failed'
  | 'deadline_exceeded'
  | 'gemini_rate_limited'
  | 'gemini_call_failed'
  | 'json_parse_failed'
  | 'empty_cards'
  | 'publish_failed'
  | 'pipeline_unexpected_error'
  // ②-4b T8(spec D4/D8): count phase の render 前合計上限超過(render 0 呼出)。
  | 'page_limit_exceeded'
  // ②-4b T8(spec §6/Codex C1): count phase の GET と render phase の再 GET の
  // 間で bytes の sha256 が変わっていた(presign 有効窓内の再 PUT による TOCTOU)。
  | 'source_changed'
  // ②-4b T8(spec D7 r4): render phase の webp 累計が MAX_RENDERED_WEBP_TOTAL_BYTES
  // を超過(loud — recordUnexpectedFailure にも積む)。
  | 'webp_limit_exceeded'
  // ②-4b T8: count/render phase の R2 GET が失敗(オブジェクト不在・network 異常)
  // または loadPdf が PdfParseError を投げた(壊れ/暗号化 PDF・Minor 4 fix で
  // render phase にも catch を追加・count phase と同一 reason)。
  | 'pdf_source_unavailable'
  // ②-4b T8 fix round 1(canonical Important 1): render phase の 1 ページ単位の
  // render 失敗(壊れ/非対応ページ等 — pdf-rasterize.ts があらゆる render 失敗を
  // PdfParseError に包む)。ユーザー入力起因の予期される失敗であり、
  // `pdf_source_unavailable`(GET/load 失敗)とは区別する。
  | 'pdf_render_failed'

// terminal 化してよい operation の status = 「その phase でこの実行が自分の op に
// 期待する状態」。prepared_payload commit の前は 'processing'、commit 後(crop /
// publish)は 'prepared'。
//
// **これを 'processing' 固定にしてはいけない**(S-2 fix round 1 M-6 の申し送り):
// commit 後の失敗まで 'processing' で fence すると、自分が起こした genuine failure が
// 「他の書き手に取られた(raced)」と誤分類され、terminal 化されるべき op が
// prepared + live lease のまま静かに残る(握り潰し)。raced の実体は lease_version
// 不一致 or 想定外 status であって、phase 由来の status 差ではない。
type FenceStatus = 'processing' | 'prepared'
const PRE_COMMIT_FENCE: readonly FenceStatus[] = ['processing']
const POST_COMMIT_FENCE: readonly FenceStatus[] = ['prepared']
// 予期しない throw は commit の前後どちらでも起きうる(どの phase かを catch-all は
// 知らない)ため両方を許す。「自分の op か」の判定は lease_version が担う。
const ANY_PHASE_FENCE: readonly FenceStatus[] = ['processing', 'prepared']

// ②-4b T8(spec D8): source(PDF 原本)GET 専用 timeout。finalize-pdf-source.ts の
// SOURCE_GET_TIMEOUT_MS と同じ値(既定 GET_TIMEOUT_MS 10s は 50MB PDF に不足しうる
// ため明示)。
//
// fix round 4(canonical/Codex Critical 修正3): この値を「parse/rasterize に着手
// してよい最低残余時間」の閾値としても流用する(count phase の各 PDF GET 前 /
// render phase の各 PDF GET 前 / render phase の各 renderPageWebp 前 — 3 箇所すべて
// 同じ値)。使い分けの理由: ① GET は AbortSignal.timeout で実際にこの値を上限に
// 縛られるため「次の GET の worst case」として正確 ② renderPageWebp は
// pdf-rasterize.ts の設計上 per-page timeout を持たない(同期 WASM 実行は中断
// 不能・hard cap は invocation の maxDuration)ため「worst case」として正確な値は
// 存在しない — 既存 GET 値を保守的な代理値として流用する(実測では 1 ページ
// ≈170ms・十分な安全マージン)。新しい値を発明せず、既存 pre-Gemini チェックが
// GEMINI_TIMEOUT_MS を「retry ループの timeout」と「着手可否の閾値」の両方に
// 使っているのと同型の再利用に揃えた。**暫定 — 実測後見直し**(spec D11)。
const PDF_SOURCE_GET_TIMEOUT_MS = 60_000

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// fix round 4(canonical/Codex Critical 修正3・契約明示): `reason: 'deadline_exceeded'`
// は count/render 両 phase の共通失敗理由 — **呼出元(`runOcrPhase`)が
// `PRE_COMMIT_FENCE` で terminal 化する契約**(他の reason と同列。ここだけ特別扱い
// しない)。
type PdfCountResult =
  | {
      ok: true
      totalPages: number
      shaByFileId: ReadonlyMap<string, string>
      // fix round 2(canonical Important 2): 実際に GET したバイト長(fileId 単位)。
      // `upload_records.file_size_bytes` の PDF 分をここから合算する(rasterize 済み
      // webp ではなく受領 source バイトを記帳するため)。
      sourceBytesByFileId: ReadonlyMap<string, number>
    }
  | { ok: false; reason: 'page_limit_exceeded' | 'pdf_source_unavailable' | 'deadline_exceeded' }

/**
 * count phase(spec D4/D8): PDF を 1 冊ずつ GET → loadPdf → pageCount + bytes の
 * sha256 を記録 → destroy(全冊を同時に保持しない)。合計(画像 + Σ実ページ)が
 * `OCR_MAX_PAGES` を超えたら **render を 1 回も呼ばず** terminal(spec の
 * 唯一の機械保証・層 3)。
 *
 * fix round 4(canonical/Codex Critical 修正1・修正2):
 * ① 上限超過は **1 冊処理するたびに in-loop で判定**する(旧: loop を最後まで
 *    回してから判定 — 上限超過が確定した後も残り全冊の GET/parse を続けていた)。
 *    超過が判明したら**その場で return** し、後続 PDF を 1 冊も GET しない。
 * ② 各 PDF の GET **前**に残余予算を確認する(`deadlineAt`)。修正①だけでは
 *    「40 冊 × 1 ページ」のように上限に収まったまま多数の GET を続けるケースを
 *    防げない — GET は 1 回最大 `PDF_SOURCE_GET_TIMEOUT_MS`(60s)かかりうるため、
 *    残余がそれを下回ったら着手しない。
 */
async function runPdfCountPhase(
  imageCount: number,
  sourcePdfManifest: readonly UploadPipelineSourcePdf[],
  userId: string,
  uploadSessionId: string,
  deadlineAt: Date,
): Promise<PdfCountResult> {
  const shaByFileId = new Map<string, string>()
  const sourceBytesByFileId = new Map<string, number>()
  let totalPages = imageCount
  for (const pdf of sourcePdfManifest) {
    // 修正2: 次の GET(worst case PDF_SOURCE_GET_TIMEOUT_MS)に着手してよいか。
    if (deadlineAt.getTime() - Date.now() < PDF_SOURCE_GET_TIMEOUT_MS) {
      return { ok: false, reason: 'deadline_exceeded' }
    }
    const objectKey = sourcePdfObjectKey(userId, uploadSessionId, pdf.fileId)
    const got = await getObject(objectKey, { timeoutMs: PDF_SOURCE_GET_TIMEOUT_MS })
    if (!got) {
      return { ok: false, reason: 'pdf_source_unavailable' }
    }
    shaByFileId.set(pdf.fileId, sha256Hex(got.bytes))
    sourceBytesByFileId.set(pdf.fileId, got.bytes.length)
    let handle
    try {
      handle = await loadPdf(got.bytes)
    } catch (err) {
      if (err instanceof PdfParseError) {
        return { ok: false, reason: 'pdf_source_unavailable' }
      }
      throw err
    }
    totalPages += handle.pageCount
    // renderPageWebp は呼ばない(count phase の役目は数えるだけ) — 解放してから
    // 次の冊へ進む(全冊を同時に保持しない・spec D8)。
    handle.destroy()
    // 修正1: 上限超過を in-loop で即判定 — 後続 PDF を 1 冊も GET しない。
    if (totalPages > OCR_MAX_PAGES) {
      return { ok: false, reason: 'page_limit_exceeded' }
    }
  }
  return { ok: true, totalPages, shaByFileId, sourceBytesByFileId }
}

/**
 * count phase の fenced CAS commit(spec D6/D8・Codex I9): `expected_source_count`
 * (upload_operations)/ `pages_total`(source_documents)を同一 tx 内で確定する。
 * 前者は lease_version + status='processing' で fence した UPDATE の 0 行/非0行が
 * 「この実行がまだ own しているか」の唯一の判定 — 0 行なら後者の UPDATE も行わず
 * false を返す(2 表に跨るため文字通り「同一 UPDATE 文」にはできないが、同一 tx で
 * 前者の fence が通った時だけ後者を書くことで、terminalizeAbandonedOperation と
 * 同型の「同一 tx 内 2 UPDATE」による原子性を担保する)。
 */
async function commitPdfCountCas(
  tx: TenantTx,
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  totalPages: number,
): Promise<boolean> {
  const updated = await tx
    .update(uploadOperations)
    .set({ expectedSourceCount: totalPages })
    .where(
      and(
        eq(uploadOperations.id, refs.operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'processing'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  if (updated.length === 0) return false
  await tx
    .update(sourceDocuments)
    .set({ pagesTotal: totalPages })
    .where(
      and(
        eq(sourceDocuments.id, refs.sourceDocumentId),
        eq(sourceDocuments.userId, userId),
      ),
    )
  return true
}

// ②-4b T8 fix round 1(canonical Minor 6): fetch/rasterize の累積時間 + webp 累計
// bytes を呼出側(runOcrPhase)から見える形で保持する(参照渡しの mutable object)。
// `runPdfRenderPhase` が return せず throw した場合(予期しない失敗)でも、
// 呼出側の finally はこのオブジェクトを読むだけで「その時点までの」値を log でき、
// 失敗する呼出そのものの計測値が消えない(この file の規律「測りたいのは遅い/
// 失敗する呼出そのもの」に従う・戻り値の一部にすると throw 時に失われる)。
type PdfRenderProgress = {
  fetchMs: number
  rasterizeMs: number
  // fix round 1(canonical Minor 7): 「peak」は名前どおり webp 出力バイトの累計
  // (このループは全ページ生成後まで手放さないため、累計 = ピーク保持量と一致)。
  // source(PDF 原本)バイトは含まない — 含めるなら別名にすべきという指摘への
  // 対処として、名前を実体(webp のみ)に合わせた。
  peakWebpBytes: number
}

// fix round 4(契約明示): `reason: 'deadline_exceeded'` は count phase 側と同じ契約
// (呼出元が `PRE_COMMIT_FENCE` で terminal 化する)。
type PdfRenderOutcome =
  | { ok: true; renderedFilesByFileId: ReadonlyMap<string, UploadPipelineFile[]> }
  | {
      ok: false
      reason:
        | 'source_changed'
        | 'webp_limit_exceeded'
        | 'pdf_source_unavailable'
        | 'pdf_render_failed'
        | 'deadline_exceeded'
    }

/**
 * render phase(spec D4/D8・Codex C1): PDF を 1 冊ずつ再 GET → sha256 を count 時の
 * 記録と照合(不一致 = presign 有効窓内の再 PUT を疑う TOCTOU・terminal
 * `source_changed`)→ 1 ページずつ webp 化。webp 累計が
 * `MAX_RENDERED_WEBP_TOTAL_BYTES` を超えたら terminal `webp_limit_exceeded`
 * (呼出側で loud 記帳)。
 *
 * fix round 1(canonical Important 1): `renderPageWebp` 自体の失敗(pdf-rasterize.ts
 * が getPage/render/sharp encode のあらゆる失敗を包む `PdfParseError`)は
 * ユーザー入力起因の予期される失敗 — terminal 化するだけで台帳(loud)には積まない
 * (`pdf_render_failed`)。`PdfHandleDestroyedError`(use-after-free 相当のバグ
 * signal)はここで捕まえず伝播させる(catch-all へ・loud のまま)。
 *
 * fix round 4(canonical/Codex Critical 修正2): 残余予算チェックを **各 PDF の GET
 * 前** と **各 `renderPageWebp` 前** の 2 箇所に置く(count phase と同型 — GET は
 * 1 回最大 `PDF_SOURCE_GET_TIMEOUT_MS`。render は per-page timeout を持たないため
 * 同じ値を保守的な代理閾値として使う・定数コメント参照)。
 */
async function runPdfRenderPhase(
  sourcePdfManifest: readonly UploadPipelineSourcePdf[],
  shaByFileId: ReadonlyMap<string, string>,
  userId: string,
  uploadSessionId: string,
  progress: PdfRenderProgress,
  deadlineAt: Date,
): Promise<PdfRenderOutcome> {
  const renderedFilesByFileId = new Map<string, UploadPipelineFile[]>()
  for (const pdf of sourcePdfManifest) {
    // 次の GET に着手してよいか(count phase と同型)。
    if (deadlineAt.getTime() - Date.now() < PDF_SOURCE_GET_TIMEOUT_MS) {
      return { ok: false, reason: 'deadline_exceeded' }
    }
    const objectKey = sourcePdfObjectKey(userId, uploadSessionId, pdf.fileId)
    const fetchStartedAt = Date.now()
    const got = await getObject(objectKey, { timeoutMs: PDF_SOURCE_GET_TIMEOUT_MS })
    progress.fetchMs += Date.now() - fetchStartedAt
    if (!got) {
      return { ok: false, reason: 'pdf_source_unavailable' }
    }
    if (sha256Hex(got.bytes) !== shaByFileId.get(pdf.fileId)) {
      return { ok: false, reason: 'source_changed' }
    }
    // whole-branch review Minor 4 fix: count phase(:264-268 相当)と同じ形で
    // loadPdf の PdfParseError を catch する。sha256 一致は「count phase の
    // loadPdf が成功した bytes と同一」を保証するだけで loadPdf 自体の成功は
    // 保証しないため理論上到達しうる(near-unreachable だが未 catch のままだと
    // catch-all(予期しない throw)に落ち、ユーザー起因の失敗が
    // integration_failures/Discord に飛ぶ — canonical Important 1 と同じクラス)。
    let handle
    try {
      handle = await loadPdf(got.bytes)
    } catch (err) {
      if (err instanceof PdfParseError) {
        return { ok: false, reason: 'pdf_source_unavailable' }
      }
      throw err
    }
    try {
      const pages: UploadPipelineFile[] = []
      for (let i = 0; i < handle.pageCount; i++) {
        // 次の renderPageWebp に着手してよいか(per-page timeout が無いため
        // PDF_SOURCE_GET_TIMEOUT_MS を保守的な代理閾値として使う)。
        if (deadlineAt.getTime() - Date.now() < PDF_SOURCE_GET_TIMEOUT_MS) {
          return { ok: false, reason: 'deadline_exceeded' }
        }
        const rasterizeStartedAt = Date.now()
        let rendered: { webp: Buffer; width: number; height: number }
        try {
          rendered = await handle.renderPageWebp(i)
        } catch (err) {
          progress.rasterizeMs += Date.now() - rasterizeStartedAt
          if (err instanceof PdfParseError) {
            return { ok: false, reason: 'pdf_render_failed' }
          }
          throw err
        }
        progress.rasterizeMs += Date.now() - rasterizeStartedAt
        progress.peakWebpBytes += rendered.webp.length
        if (progress.peakWebpBytes > MAX_RENDERED_WEBP_TOTAL_BYTES) {
          return { ok: false, reason: 'webp_limit_exceeded' }
        }
        pages.push({ buffer: rendered.webp, filename: `${pdf.filename}#p${i + 1}` })
      }
      renderedFilesByFileId.set(pdf.fileId, pages)
    } finally {
      handle.destroy()
    }
  }
  return { ok: true, renderedFilesByFileId }
}

/**
 * 既存 `verifyImageBytes` 逐次ループへ manifest 順(= sourceOrder)で合流させる
 * (spec §2「manifest 順で合流」/ D3「Gemini parts 順 = 選択順を維持」)。
 * sourceOrder が空(legacy 画像のみ経路・orderManifest 不在)なら `files` を
 * そのまま返す — 挙動不変。
 */
function mergeSourceOrder(
  files: readonly UploadPipelineFile[],
  sourceOrder: readonly UploadPipelineSourceOrderEntry[],
  renderedFilesByFileId: ReadonlyMap<string, UploadPipelineFile[]>,
): UploadPipelineFile[] {
  if (sourceOrder.length === 0) return [...files]
  const merged: UploadPipelineFile[] = []
  for (const entry of sourceOrder) {
    if (entry.kind === 'image') {
      merged.push(files[entry.fileIndex])
    } else {
      merged.push(...(renderedFilesByFileId.get(entry.fileId) ?? []))
    }
  }
  return merged
}

/**
 * 受領バイト → decode 検証 → Gemini → 正規化 → prepared_payload commit →
 * crop → publish。
 *
 * 呼出前提: `refs.operationId` は呼出側がこの invocation で作った
 * `status='processing'` の operation で、`leaseVersion` はその行の値。
 * 成功時は `status='completed'`(source_document も completed)で終わる。
 */
export async function runUploadPipeline(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  files: UploadPipelineFile[],
  deadlineAt: Date,
  // ②-4b T7 が渡す PDF manifest + R2 namespace(spec §13 r5 表)。既定 `[]`/
  // `undefined` により既存呼出元(images-only・upload-pipeline.test.ts /
  // tests/integration/pg/upload-pipeline.test.ts)は無改変で通る。
  sourcePdfManifest: UploadPipelineSourcePdf[] = [],
  uploadSessionId?: string,
  // ②-4b T7 fix round 1(canonical Critical): 混在 submit の manifest 順(spec §2/
  // D3)。T8 が files/sourcePdfManifest を manifest 順に zip し直すのに使う。
  sourceOrder: UploadPipelineSourceOrderEntry[] = [],
): Promise<void> {
  const startedAt = Date.now()
  // ②-4b T8(spec §6 本線 2・Codex C4): 出口 DELETE は列挙分岐でなく pipeline
  // 外周の try/finally で構造保証する — 削除対象 key 集合は**この try に入る前
  // (= 実際の OCR 作業が始まる前)に固定**し、成功 / terminal / raced / lost /
  // 予期しない throw のどの経路で抜けても同じ finally が同じ集合を対象に
  // deleteObject を呼ぶ。sourcePdfManifest が非空なら uploadSessionId は T7 の
  // wire 契約(zod v4 uuid 必須・spec §3.4)により必ず存在する。
  // **この保証の適用範囲は「この関数に一度でも入った後」に限る**: 呼出側
  // (submit-upload.ts)の応答前 Buffer 実体化失敗 / after() 登録自体の失敗は
  // この関数を一度も呼ばないため対象外(受け皿は spec §6 の lifecycle rule)。
  //
  // fix round 2(canonical Critical): **無条件 DELETE は所有権を失った invocation が
  // 共有 source を消しうる**(spec の「万一同一 op を 2 invocation が持った場合」
  // という transport 重複の極小窓 — fenced CAS はまさにこのために存在する。負けた
  // 側が finally で共有 object を消すと、count と render の間にいる勝者の再 GET が
  // null になり `pdf_source_unavailable` で誤って terminal 化されうる)。
  // `ownership.lost` は fence 敗北が判明した箇所(start_cas_lost / count_cas_lost /
  // commit_raced / publish_raced)でのみ立つ — skip した object は spec §6 の
  // lifecycle rule(`src/` maxAge 86400s)が受け皿になる。
  const ownership: OwnershipState = { lost: false }
  let sourceKeys: string[] = []
  try {
    sourceKeys =
      sourcePdfManifest.length > 0
        ? sourcePdfManifest.map((pdf) =>
            sourcePdfObjectKey(userId, uploadSessionId as string, pdf.fileId),
          )
        : []
    await runOcrPhase(
      userId,
      refs,
      leaseVersion,
      files,
      deadlineAt,
      sourcePdfManifest,
      uploadSessionId,
      sourceOrder,
      ownership,
    )
  } catch (err) {
    // ここに来るのは「予期しない」失敗だけ(予期される失敗は runOcrPhase 内で
    // terminal 化して return する)。after() 化後は呼出元が居ないため、throw を
    // そのまま外へ出すと失敗が operation 行にも台帳にも残らない。
    // fix round 3(Critical): `absorbUploadPipelineFailure` 内の terminalize が
    // `raced` を返すこともある(この throw が起きた時点で既に別の書き手がこの op を
    // 終端化していた場合)— `ownership` を渡し、raced なら所有権喪失として扱う。
    await absorbUploadPipelineFailure(userId, refs, leaseVersion, err, ownership)
  } finally {
    if (!ownership.lost) {
      await deleteSourceKeys(userId, refs.operationId, sourceKeys)
    }
    logPhase(refs.operationId, 'total', Date.now() - startedAt)
  }
}

// ②-4b T8(spec §6 本線 2): 出口 DELETE の実体。deleteObject 自体は never-throw
// 契約(r2.ts)だが `recordIntegrationFailure` は notifyOps の throw を伝播しうる
// ため、ここで飲む(finally から呼ぶ以上、この関数は throw しない契約)。
// 各 key は独立の HTTP 呼出であり crop のような同時保持メモリ制約が無いため
// 並行に投げる(spec の「全冊を同時に保持しない」は count/render phase の話で、
// 削除は既に手放したバイトを対象にする)。
async function deleteSourceKeys(
  userId: string,
  operationId: string,
  keys: readonly string[],
): Promise<void> {
  await Promise.all(
    keys.map(async (objectKey) => {
      const result = await deleteObject(objectKey)
      if (result.ok) return
      try {
        await recordIntegrationFailure({
          key: 'r2_source_delete',
          userId,
          subject: 'upload pipeline source PDF delete failed',
          context: { objectKey, status: result.status },
        })
      } catch (err) {
        logger.error({
          event: 'upload.pipeline.source_delete_record_failed',
          operationId,
          err,
        })
      }
    }),
  )
}

/**
 * 予期しない失敗を「operation の terminal 化 + 台帳記録」に変換して飲み込む
 * (throw しない契約の実体)。
 *
 * `runUploadPipeline` の catch-all 本体であると同時に、**pipeline 呼出の直前に
 * 呼出側で起きる失敗**(request body の Buffer 実体化など)も同じ envelope に
 * 入れるために export している — そこで throw させると operation が
 * `processing` + live lease・error code 無し・台帳行無しで残る。
 */
// ②-4b T8 fix round 3(canonical/Codex Critical): `ownership` は省略可 — この関数は
// `runUploadPipeline` の catch(ownership あり)からも、`submit-upload.ts` の
// pipeline 呼出**前**の失敗(Buffer 実体化 / after() 登録自体の失敗・ownership 概念が
// 無い経路)からも呼ばれる共有 envelope のため。渡された場合のみ、terminalize が
// `raced`(= 別の書き手が既にこの op を終端化済み)を返したら所有権喪失を伝える。
export async function absorbUploadPipelineFailure(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  err: unknown,
  ownership?: OwnershipState,
): Promise<void> {
  try {
    const outcome = await terminalize(
      userId,
      refs,
      leaseVersion,
      'pipeline_unexpected_error',
      ANY_PHASE_FENCE,
    )
    if (outcome === 'raced' && ownership) {
      ownership.lost = true
    }
  } catch (terminalizeErr) {
    // DB 自体が落ちている等、terminal 化すら失敗する場合。ここで throw させると
    // 「throw しない契約」が破れるため飲む(operation は lease 失効後に
    // reconciler が回収する = spec §4.5 の回収経路)。
    logger.error({
      event: 'upload.pipeline.terminalize_failed',
      operationId: refs.operationId,
      err: terminalizeErr,
    })
  }
  await recordUnexpectedFailure(userId, refs.operationId, err)
}

async function runOcrPhase(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  files: UploadPipelineFile[],
  deadlineAt: Date,
  sourcePdfManifest: UploadPipelineSourcePdf[],
  uploadSessionId: string | undefined,
  sourceOrder: UploadPipelineSourceOrderEntry[],
  ownership: OwnershipState,
): Promise<void> {
  // fix round 3(canonical/Codex Critical): `terminalize` の `raced` outcome を
  // 捨てずに `ownership.lost` へ伝える薄いラッパー(この関数内の 8 呼出点が
  // userId/refs/leaseVersion/ownership を共有するため closure で DRY 化)。
  // `raced` = 別の書き手が既にこの op を終端化済み = この invocation は所有権を
  // 失っている(fix round 2 の 4 経路とは別の、5 つ目の所有権喪失シグナル)。
  async function terminalizeOwned(
    errorCode: PipelineErrorCode,
    expectedStatuses: readonly FenceStatus[],
  ): Promise<void> {
    const outcome = await terminalize(userId, refs, leaseVersion, errorCode, expectedStatuses)
    if (outcome === 'raced') {
      ownership.lost = true
    }
  }

  // ---- 開始 CAS(S-4・spec §4.4 (e)) ----
  // `after()` の callback は応答返却の**後**に走るため、sync tx で作った op が
  // その間に消えている可能性がある(ユーザーが exam ごと削除 / GDPR 退会 →
  // cascade で op 行が消滅)。 Gemini を呼ぶ前に 1 回だけ確認して、消えていれば
  // 静かに終わる — 課金だけ発生して結果の置き場が無い、を避ける。
  //
  // 確認するのは「行が存在し、lease_version が自分のもの」の 2 点だけ(spec の
  // 削除競合クラス (e) が対象)。 status は見ない: この時点の op は必ず valid
  // lease を持つため live-op gate が supersede を構造的に禁じており、status が
  // 動く経路が無い(commit 側の fenced CAS が status='processing' を改めて要求する)。
  // **以降の各 I/O 前に再確認はしない** — 稀な競合で余分な Gemini 呼出 1 回や
  // ref ゼロの crop asset が残るのは bounded residual として受容し、既存 GC lane が
  // 回収する(Codex #15)。
  const stillOurs = await withTenantTx(userId, (tx) =>
    isOperationStillOurs(tx, userId, refs.operationId, leaseVersion),
  )
  if (!stillOurs) {
    logger.warn({ event: 'upload.pipeline.start_cas_lost', operationId: refs.operationId })
    // fix round 2(Critical): 別 invocation がこの op を所有していることが判明した
    // — 共有 source を消さない(lifecycle rule が受け皿)。
    ownership.lost = true
    return
  }

  // 各 phase の所要時間 log は **失敗分岐より前**に出す(log の目的は暫定予算の
  // 較正であり、較正上いちばん危ないのは「遅い / timeout する呼出」= 失敗する
  // 呼出そのもの。成功時しか出ないと測りたい値が落ちる)。

  // ---- ②-4b T8: PDF count phase + render phase(spec D4/D6/D8/§6) ----
  // 画像のみ(sourcePdfManifest 空)は完全に無改変で下の decode へ進む。
  let mergedFiles = files
  // fix round 2(canonical Important 2): `upload_records.file_size_bytes` の PDF 分は
  // count phase が GET した実バイト長(images-only では空 Map のまま = 寄与ゼロ)。
  let pdfSourceBytesByFileId: ReadonlyMap<string, number> = new Map()
  if (sourcePdfManifest.length > 0) {
    // sourcePdfManifest が非空なら T7 の wire 契約(spec §3.4)により uploadSessionId
    // は必ず v4 uuid 文字列(この関数へ来る前に zod 検証済)。
    const sessionId = uploadSessionId as string

    // count phase 開始前の残余予算チェック(既存 pre-Gemini チェックと同型 —
    // これから始める 1 回分の I/O の worst case に満たなければ着手しない)。
    if (deadlineAt.getTime() - Date.now() < PDF_SOURCE_GET_TIMEOUT_MS) {
      await terminalizeOwned('deadline_exceeded', PRE_COMMIT_FENCE)
      return
    }

    // fix round 1(canonical Minor 6): count/render の呼出自体を try/finally で
    // 包み、`runPdfCountPhase`/`runPdfRenderPhase` が(予期しない理由で)throw
    // しても phase log が消えないようにする — この file 自身の規律(「測りたいのは
    // 遅い/失敗する呼出そのもの」)に従う。TS 上、`let` 変数は catch を持たない
    // try/finally の中で代入されるため、try が throw すれば finally 実行後に
    // そのまま呼出元へ伝播し、以降の `countResult` 使用箇所には到達しない
    // (= 到達した時点で必ず代入済み)。
    const countStartedAt = Date.now()
    let countResult: PdfCountResult
    try {
      countResult = await runPdfCountPhase(
        files.length,
        sourcePdfManifest,
        userId,
        sessionId,
        deadlineAt,
      )
    } finally {
      logPhase(refs.operationId, 'count', Date.now() - countStartedAt)
    }
    if (!countResult.ok) {
      // page_limit_exceeded(render 0 呼出)/ pdf_source_unavailable のいずれも
      // 「render 前に確定した予期される失敗」— PRE_COMMIT_FENCE で terminal 化する。
      await terminalizeOwned(countResult.reason, PRE_COMMIT_FENCE)
      return
    }
    pdfSourceBytesByFileId = countResult.sourceBytesByFileId

    // fenced CAS(spec D6/D8・Codex I9): expected_source_count(upload_operations)/
    // pages_total(source_documents)を同一 tx 内で確定する。lease_version 不一致 or
    // status≠'processing' なら 0 行 = 他の書き手に取られた — **render/Gemini へ
    // 進まない**(この関数を return して終える。terminal 化はしない = 既に別の
    // 書き手がこの op の結末を決めている可能性があるため、この実行の理由で
    // 上書きしない。commitPreparedCas の commit_raced と同じ扱い)。
    const casCommitted = await withTenantTx(userId, (tx) =>
      commitPdfCountCas(tx, userId, refs, leaseVersion, countResult.totalPages),
    )
    if (!casCommitted) {
      logger.warn({ event: 'upload.pipeline.count_cas_lost', operationId: refs.operationId })
      // fix round 2(Critical): 同上 — 別 invocation がこの op を所有している。
      ownership.lost = true
      return
    }

    // render phase 開始前の残余予算チェック(同型)。
    if (deadlineAt.getTime() - Date.now() < PDF_SOURCE_GET_TIMEOUT_MS) {
      await terminalizeOwned('deadline_exceeded', PRE_COMMIT_FENCE)
      return
    }

    const renderProgress: PdfRenderProgress = { fetchMs: 0, rasterizeMs: 0, peakWebpBytes: 0 }
    let renderOutcome: PdfRenderOutcome
    try {
      renderOutcome = await runPdfRenderPhase(
        sourcePdfManifest,
        countResult.shaByFileId,
        userId,
        sessionId,
        renderProgress,
        deadlineAt,
      )
    } finally {
      // fix round 1(Minor 6): `renderProgress` は throw 時もその時点までの値を
      // 保持している(参照渡しの mutable object・戻り値の一部だと throw で失われる)。
      logPhase(refs.operationId, 'fetch_source', renderProgress.fetchMs)
      logPhase(refs.operationId, 'rasterize', renderProgress.rasterizeMs)
      // Codex C3: assert でなく実測材料。
      logger.warn({
        event: 'upload.pipeline.rasterize_peak_bytes',
        operationId: refs.operationId,
        peakWebpBytes: renderProgress.peakWebpBytes,
      })
    }
    if (!renderOutcome.ok) {
      await terminalizeOwned(renderOutcome.reason, PRE_COMMIT_FENCE)
      if (renderOutcome.reason === 'webp_limit_exceeded') {
        // loud(spec D7 r4): 高エントロピー PDF が既存メモリ前提を外れる兆候 —
        // ユーザー起因の失敗として静かに terminalize するだけでなく運用へ通知する。
        await recordUnexpectedFailure(
          userId,
          refs.operationId,
          new Error(
            `webp cumulative bytes ${renderProgress.peakWebpBytes} exceeded ${MAX_RENDERED_WEBP_TOTAL_BYTES}`,
          ),
          'webp_limit_exceeded',
        )
      }
      return
    }

    // 既存 verifyImageBytes 逐次ループへ **manifest 順(= sourceOrder)**で合流する
    // (spec §2「manifest 順で合流」/ D3「Gemini parts 順 = 選択順を維持」)。
    // sourceOrder が空(legacy 画像のみ経路)なら files をそのまま使う。
    mergedFiles = mergeSourceOrder(files, sourceOrder, renderOutcome.renderedFilesByFileId)
  }

  // ---- decode 検証 + source_id 採番(逐次) ----
  const decodeStartedAt = Date.now()
  const sources: VerifiedSource[] = []
  const sourceImages: SourceIdImage[] = []
  let decodeFailed = false
  for (const file of mergedFiles) {
    // **逐次**であることがメモリ見積り(spec §4.7)の前提 — Promise.all 化すると
    // 最大 40 枚分の decode 済み pixel が同時にメモリへ載る。unit test が
    // 「peak 同時 decode = 1」を計測 mock で機械強制している。
    const verified = await verifyImageBytes(file.buffer)
    if (verified === null) {
      // 1 枚でも decode に失敗したら upload 全体を terminal にする(旧 finalize の
      // 失敗と同義)。「壊れた 1 枚だけ除外して残りを OCR」へ変えるならここが起点。
      decodeFailed = true
      break
    }
    // source_id は client 発行でなく server が受領順に採番する。値は unguessable な
    // uuid にする — 連番だとモデルが図版の帰属を推測で埋めた場合に「たまたま実在の
    // source_id」になり誤った画像へ silent に紐付く。uuid ならその推測は
    // validSourceIds に弾かれ source_id_invalid として集計に現れる。
    const sourceId = randomUUID()
    if (isUnsupportedOrientation(verified.orientation)) {
      // **本命はこの warn**(ユーザー向けの除外表示は副次)。 EXIF≠1 は
      // 「ユーザーのための除外」ではなく **前提破綻の検知** — client が upload 時に
      // 画像を無条件で canvas 再エンコードする(spec §4.3)ため、現行 UI 経路では
      // ここは**通常 絶対に発火しない**。 発火したら前提が壊れている合図で、
      // `source_assets.rotation` 予約列が migration 0032 で消えた今、それを知る手段は
      // この 1 行しかない(isUnsupportedOrientation の doc を参照)。
      // PII-free: operationId と orientation 値のみ(filename / バイト / payload は載せない)。
      logger.warn({
        event: 'upload.pipeline.source_orientation_unsupported',
        operationId: refs.operationId,
        orientation: verified.orientation,
      })
    }
    // decode 自体は失敗させない — text 抽出は継続する(spec §4.5)。効くのは crop 段。
    sources.push({ sourceId, bytes: file.buffer, ...verified })
    sourceImages.push({
      // mimeType は decode 結果(sharp)由来 — client 申告や拡張子は使わない。
      sourceId,
      file: { mimeType: verified.mime, data: file.buffer.toString('base64') },
    })
  }
  logPhase(refs.operationId, 'decode', Date.now() - decodeStartedAt)
  if (decodeFailed) {
    await terminalizeOwned('image_decode_failed', PRE_COMMIT_FENCE)
    return
  }

  // ---- 残余予算の確認(統合予算・起点 = action 入口) ----
  // ここは「初回 attempt を始めてよいか」の判断。retry 経路を守るのは
  // callImageCropWithRetry(deadlineAt)側の責務だが、初回 attempt はそこを通らない
  // ため同じ基準(1 attempt は最悪 GEMINI_TIMEOUT_MS)をここでも課す — 残余 1ms でも
  // 220s の call を始めてしまうと invocation が platform に打ち切られ、失敗理由が
  // op にも台帳にも残らない(constants.ts の算術参照)。
  if (deadlineAt.getTime() - Date.now() < GEMINI_TIMEOUT_MS) {
    await terminalizeOwned('deadline_exceeded', PRE_COMMIT_FENCE)
    return
  }

  // ---- Gemini(429 即停止・transient のみ backoff retry は既存挙動のまま) ----
  const geminiStartedAt = Date.now()
  const parts = buildSourceIdInterleavedParts(
    sourceImages,
    buildImageCropExplorationPrompt(),
  )
  let geminiResult: GeminiCallResult | null = null
  let geminiError: unknown = null
  try {
    geminiResult = await callImageCropWithRetry(
      parts,
      buildImageCropResponseJsonSchema(),
      // retry ループの内側で残余を見させる(I-1)。
      deadlineAt,
      // 日次 cap の計上は attempt ごと(retry も 1 call として数える)。
      () => incrementAiUsage(userId, 1),
    )
  } catch (err) {
    geminiError = err
  }
  logPhase(refs.operationId, 'gemini', Date.now() - geminiStartedAt)
  if (geminiResult === null) {
    await terminalizeOwned(
      isRateLimitError(geminiError) ? 'gemini_rate_limited' : 'gemini_call_failed',
      PRE_COMMIT_FENCE,
    )
    return
  }

  // ---- 正規化(純粋・normalize-prepared / prepared-schema は無改変で消費) ----
  const normalizeStartedAt = Date.now()
  const prepared = buildPrepared(
    geminiResult.text,
    new Set(sources.map((s) => s.sourceId)),
  )
  logPhase(refs.operationId, 'normalize', Date.now() - normalizeStartedAt)
  if (typeof prepared === 'string') {
    await terminalizeOwned(prepared, PRE_COMMIT_FENCE)
    return
  }
  const { payload, preparedHash } = prepared

  // ---- prepared_payload commit(fenced CAS) ----
  const commitStartedAt = Date.now()
  const committed = await withTenantTx(userId, (tx) =>
    commitPreparedCas(tx, userId, refs.operationId, leaseVersion, payload, preparedHash),
  )
  logPhase(refs.operationId, 'commit', Date.now() - commitStartedAt)
  if (!committed) {
    // supersede / GDPR 削除等でこの operation が既に別の状態へ移っている。この実行の
    // 結果で上書きしない(何も書かずに終わる)。
    logger.warn({ event: 'upload.pipeline.commit_raced', operationId: refs.operationId })
    // fix round 2(Critical): 同上 — 別 invocation がこの op を所有している。
    ownership.lost = true
    return
  }

  // ---- crop(payload commit の**後**にのみ・逐次) ----
  const dispositionByAssetId = await runCropPhase(
    userId,
    refs.operationId,
    payload,
    sources,
    deadlineAt,
  )

  // ---- publish(cards/tags/refs/記帳/finalize を 1 tx) ----
  // upload_records.file_size_bytes は**受領 Buffer の合計**(spec 2026-08-04 §4)。
  // fix round 2(canonical Important 2): rasterize 済み webp(mergedFiles)ではなく
  // 実際に受領した source バイトを合計する — 画像は原 Buffer、PDF は count phase の
  // GET で読んだ実バイト長(`pdfSourceBytesByFileId`。render phase の sha 一致検証を
  // 通過しているため、この時点で publish に到達している PDF のバイト長は render 時の
  // 実 GET と一致する)。images-only では `pdfSourceBytesByFileId` が空 Map のため
  // `files` の合計のみとなり既存挙動と一致する。
  const fileSizeBytes =
    files.reduce((sum, f) => sum + f.buffer.length, 0) +
    Array.from(pdfSourceBytesByFileId.values()).reduce((sum, n) => sum + n, 0)
  await runPublishPhase(
    userId,
    refs,
    leaseVersion,
    payload,
    dispositionByAssetId,
    fileSizeBytes,
    ownership,
  )
}

/**
 * 全 figure を逐次 crop し、figure ごとの disposition を返す(spec §7.3 の順序
 * 不変条件「crop-derived asset 行・R2 object は prepared_payload commit 後にのみ」は
 * この関数を commit の後でしか呼ばないことで担保する)。
 *
 * **crop の失敗で OCR 成果を巻き添えにしない**(spec §9-6)を 3 層で実装する:
 *   層 1: 個別 figure の失敗 — outcome(crop_failed 等)でも **throw でも**、
 *         その figure だけを 'exclude' にして次の figure へ進む(隔離原則:
 *         検証失敗は影響を受ける最小の価値単位まで隔離する)。
 *   層 2: phase 共通の予期しない throw — 既に attach 済みの figure は活かし、
 *         未処理分だけ 'exclude' にして publish へ進む(backstop)。
 *   層 3: publish tx の失敗だけが terminal(runPublishPhase)。
 *
 * ユーザー向けには縮退(text card は publish)だが、**運用向けには黙らない**:
 * 予期しない throw は spec §4.4 (b) どおり `integration_failures` + Discord へ
 * 載せる(1 operation あたり 1 行に丸める — figure ごとに鳴らすと 40 件の同一
 * 通知になる)。これが無いと、deploy 環境固有の crop 全滅(sharp の .so 欠落・
 * migration 0031 未適用など)が「全 upload が静かに text-only で completed」に
 * なり、カードは正常に見えるので誰も気付けない。
 */
async function runCropPhase(
  userId: string,
  operationId: string,
  payload: PreparedPayload,
  sources: readonly VerifiedSource[],
  deadlineAt: Date,
): Promise<Map<string, FigureDisposition>> {
  const cropStartedAt = Date.now()
  const dispositionByAssetId = new Map<string, FigureDisposition>()
  const allFigures = payload.cards.flatMap((card) => card.figures)
  // 台帳は 1 operation につき 1 行(同一原因で 40 件鳴らさない)。
  let ledgerRecorded = false
  const recordCropFailureOnce = async (err: unknown): Promise<void> => {
    if (ledgerRecorded) return
    ledgerRecorded = true
    await recordUnexpectedFailure(userId, operationId, err, 'crop_phase_failed')
  }
  try {
    const sourceById = new Map(sources.map((s) => [s.sourceId, s]))
    let budgetExhausted = false
    for (const figure of allFigures) {
      const source = sourceById.get(figure.sourceId)
      if (source === undefined) {
        // normalizePrepared が validSourceIds で弾く契約ゆえ到達しない(narrowing 用)。
        dispositionByAssetId.set(figure.assetId, 'exclude')
        continue
      }
      // **orientation は予算判定より前**(Codex P2)。 EXIF≠1 は decode 段で既に
      // 判明しており、この figure は**そもそも crop され得なかった** — 予算判定を
      // 先に置くと予算切れ後の回転 figure が deadline_excluded に食われ、画面に
      // 「**上限のため**省略しました」と出る。 束を「取り込めませんでした」に決めた
      // 理由(こちらが上限を決めて打ち切ったのではなく扱えなかった = 「上限のため」は
      // 嘘になる)を corner case で復活させてしまうため、順序で潰す。
      if (isUnsupportedOrientation(source.orientation)) {
        // crop を**呼ばない** — 座標基準(decode 寸法)と Gemini の解釈が一致する
        // 保証が無いため、CPU も R2 PUT も使う意味がない(warn は decode 時に出済み)。
        //
        // **spec §4.5 の文言との差を明記する**: spec は「図版**検出**をスキップ」と
        // 書いているが、prompt は凍結で、text 抽出のために画像は Gemini へ送る。
        // 実際に実現するのは「**検出はされるが attach しない**」。
        dispositionByAssetId.set(figure.assetId, 'orientation_unsupported')
        continue
      }
      // 予算は OCR と共通の統合予算の残余で見る(旧経路の crop 専用予算ではない)。
      // 一度枯渇したら以降は判定を揺り戻さない(旧経路の crop loop と同型)。
      // 上の `continue` で評価を飛ばす figure があっても latch は壊れない —
      // 枯渇判定は時間について単調(Date.now() は増える一方・deadline は固定)ゆえ、
      // 評価を skip しても後続の figure が同じか「より枯渇した」答えを得るだけで、
      // 一度 true になった値を false へ戻す経路はどこにも無い。
      if (
        !budgetExhausted &&
        isCropBudgetExhausted(Date.now(), deadlineAt.getTime(), CROP_MIN_REMAINING_MS)
      ) {
        budgetExhausted = true
      }
      if (budgetExhausted) {
        dispositionByAssetId.set(figure.assetId, 'deadline_excluded')
        continue
      }
      // **逐次**: crop 出力 Buffer を溜めない(1 件ずつ PUT して手放す)。unit test が
      // 計測 mock で「peak 同時 crop = 1」を機械強制している。
      let outcome: CropAndStoreOutcome
      try {
        outcome = await cropFigureFromBuffer({
          userId,
          sourceBytes: source.bytes,
          sourceWidth: source.width,
          sourceHeight: source.height,
          sourceId: figure.sourceId,
          figureAssetId: figure.assetId,
          box2d: figure.box_2d,
          detectTarget: figure.target,
        })
      } catch (err) {
        // 層 1(throw 版)。cropFigureFromBuffer は never-throw 契約だが、その内側の
        // sharp / R2 / DB のどれかが契約を破った場合にここへ来る。1 figure の事故で
        // 残りの figure まで落とさない。
        logger.error({ event: 'upload.pipeline.crop_figure_failed', operationId, err })
        await recordCropFailureOnce(err)
        dispositionByAssetId.set(figure.assetId, 'exclude')
        continue
      }
      // 新経路に retry / takeover は無いため、成功以外はすべて exclude に倒す
      // (retryable 相当を disposition 'retryable' にすると planPublish が publish 自体を
      // 止め、再試行する主体が居ないまま text card まで失われる)。
      dispositionByAssetId.set(
        figure.assetId,
        classifyCropOutcome(outcome.outcome) === 'success' ? 'attach' : 'exclude',
      )
    }
  } catch (err) {
    // 層 2(backstop): loop 骨格側の予期しない失敗。ここで throw を通すと catch-all が
    // operation ごと terminal 化してしまい、commit 済みの OCR 成果を捨てることになる。
    logger.error({ event: 'upload.pipeline.crop_phase_failed', operationId, err })
    await recordCropFailureOnce(err)
  }
  // 例外で中断した場合の未処理分(と、通常完了時は 0 件)を crop 失敗として計上する。
  for (const figure of allFigures) {
    if (!dispositionByAssetId.has(figure.assetId)) {
      dispositionByAssetId.set(figure.assetId, 'exclude')
    }
  }
  logPhase(operationId, 'crop', Date.now() - cropStartedAt)
  return dispositionByAssetId
}

// publish tx(cards/tags/refs/upload_records/finalize)。失敗はこの pipeline で唯一の
// terminal 化対象(spec §9-6)。fence は commit 後ゆえ 'prepared' を期待する。
async function runPublishPhase(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  payload: PreparedPayload,
  dispositionByAssetId: ReadonlyMap<string, FigureDisposition>,
  fileSizeBytes: number,
  ownership: OwnershipState,
): Promise<void> {
  // phase 所要時間は **失敗分岐より前**に確定させる(S-2 M-2 と同じ規律)。契約違反の
  // throw(下記 plan.decision)を catch-all へ通す経路でも log を落とさないよう
  // finally で出す — まさに事後解析したいケースで時系列の最後が欠けるため。
  const publishStartedAt = Date.now()
  try {
    const plan = planPublish(payload.cards, dispositionByAssetId)
    if (plan.decision !== 'publish') {
      // 本経路が作る disposition は attach / exclude / deadline_excluded /
      // orientation_unsupported だけで、
      // planPublish が stale / retryable を返す入力(not_ours / retryable / 欠落)は
      // 生じない。到達したら契約破れ = バグゆえ catch-all(台帳記録)へ送る。
      throw new Error(`upload pipeline: unexpected publish decision '${plan.decision}'`)
    }

    const resultSummary = buildResultSummary(payload, plan, {
      operationId: refs.operationId,
      examId: refs.examId,
      sourceDocumentId: refs.sourceDocumentId,
    })
    let published: { outcome: 'published' } | { outcome: 'stale' } | null = null
    let publishError: unknown = null
    try {
      published = await withTenantTx(userId, (tx) =>
        publishPreparedUploadTx(tx, {
          userId,
          operationId: refs.operationId,
          leaseVersion,
          cards: payload.cards,
          cardImagesByCardId: plan.cardImagesByCardId,
          resultSummary,
          // 受領 Buffer の合計(新経路は source を R2/DB に置かないため、旧経路が
          // 使っていた source 台帳の byte_size 合計という概念が無い)。
          fileSizeBytes,
        }),
      )
    } catch (err) {
      publishError = err
    }
    if (published === null) {
      // 保護 UPDATE 期待未満 / 重複 card id(loud fail)/ DB error。tx は rollback 済み
      // (部分 commit なし)。新経路に retry は無いためそのまま terminal。
      logger.error({
        event: 'upload.pipeline.publish_tx_failed',
        operationId: refs.operationId,
        err: publishError,
      })
      // fix round 3(Critical): terminalize の raced outcome を捨てず所有権喪失へ伝える。
      const outcome = await terminalize(userId, refs, leaseVersion, 'publish_failed', POST_COMMIT_FENCE)
      if (outcome === 'raced') {
        ownership.lost = true
      }
      return
    }
    if (published.outcome === 'stale') {
      // fencing に負けた(supersede / GDPR 削除等)。この実行の結果で上書きしない。
      logger.warn({ event: 'upload.pipeline.publish_raced', operationId: refs.operationId })
      // fix round 2(Critical): 別 invocation がこの op を所有している(published
      // 済かもしれない)— 共有 source を消さない(lifecycle rule が受け皿)。
      ownership.lost = true
    }
  } finally {
    logPhase(refs.operationId, 'publish', Date.now() - publishStartedAt)
  }
}

// Gemini 応答文字列 → 検証済 prepared payload。失敗は error code(文字列)で返す
// — 呼出側が phase の所要時間を測り切ってから terminal 化できるようにするため
// (この関数自体は DB を触らない)。
function buildPrepared(
  geminiText: string,
  validSourceIds: ReadonlySet<string>,
): { payload: PreparedPayload; preparedHash: string } | 'json_parse_failed' | 'empty_cards' {
  let rawResponse: unknown
  try {
    rawResponse = JSON.parse(geminiText)
  } catch {
    return 'json_parse_failed'
  }
  const normalized = normalizePrepared(rawResponse, validSourceIds, randomUUID)
  if (normalized.cards.length === 0) {
    // OCR call 自体は成功したが有効カード 0(raw 0 件・全 card が要素隔離で除外の
    // いずれも同じ扱い)。新経路に再試行は無いためそのまま terminal。
    return 'empty_cards'
  }
  const payload = assemblePreparedPayload(normalized)
  return { payload, preparedHash: computePreparedHash(payload) }
}

// 開始 CAS の読取(S-4): 行が存在し lease_version が自分のものか。
async function isOperationStillOurs(
  tx: TenantTx,
  userId: string,
  operationId: string,
  leaseVersion: number,
): Promise<boolean> {
  const rows = await tx
    .select({ id: uploadOperations.id })
    .from(uploadOperations)
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// prepared_payload の fenced CAS(spec §4.3): 自分が作った processing op で、かつ
// lease_version が自分のものである間だけ書ける。0 行 = 他の書き手に取られた。
async function commitPreparedCas(
  tx: TenantTx,
  userId: string,
  operationId: string,
  leaseVersion: number,
  preparedPayload: PreparedPayload,
  preparedHash: string,
): Promise<boolean> {
  const updated = await tx
    .update(uploadOperations)
    .set({
      status: 'prepared',
      preparedPayload,
      preparedHash,
      preparedSchemaVersion: 1,
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'processing'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  return updated.length > 0
}

// 失敗の確定(op terminal_failed + source_document failed を同一 tx)。
// `expectedStatuses` = この phase で自分の op に期待する status(FenceStatus 参照)。
//
// ②-4b T8 fix round 3(canonical/Codex Critical): 戻り値を `'terminalized' | 'raced'`
// にする(旧: `Promise<void>` で内部 outcome を捨てていた)。`raced` = 「別の書き手が
// 既にこの op を終端化済み」= **この invocation はもう所有権を持たない** — fix
// round 2 の 4 経路(start_cas_lost/count_cas_lost/commit_raced/publish_raced)とは
// 別の、5 つ目の所有権喪失シグナル。呼出側が見て `ownership.lost` を立てる。
async function terminalize(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  errorCode: PipelineErrorCode,
  expectedStatuses: readonly FenceStatus[],
): Promise<'terminalized' | 'raced'> {
  const outcome = await withTenantTx(userId, async (tx) => {
    // terminalizeAbandonedOperation は「呼出元が対象行を owner-scope で FOR UPDATE
    // 済み」を前提とする共有 contract。そのロックを取るついでに commit と同じ fence
    // を確認する — 既に別の書き手(supersede 等)が終端化していれば、この実行の
    // 失敗理由でその結果を上書きしない。
    const rows = await tx
      .select({
        status: uploadOperations.status,
        leaseVersion: uploadOperations.leaseVersion,
      })
      .from(uploadOperations)
      .where(
        and(
          eq(uploadOperations.id, refs.operationId),
          eq(uploadOperations.userId, userId),
        ),
      )
      .for('update')
    const op = rows[0]
    if (
      !op ||
      op.leaseVersion !== leaseVersion ||
      !expectedStatuses.some((s) => s === op.status)
    ) {
      return 'raced'
    }
    await terminalizeAbandonedOperation(
      tx,
      userId,
      { operationId: refs.operationId, sourceDocumentId: refs.sourceDocumentId },
      errorCode,
    )
    return 'terminalized'
  })
  // 予期される失敗は operation 行 + この log に留める(integration_failures には
  // 積まない — 台帳はユーザー起因の失敗で埋めない)。PII-free。
  logger.warn({
    event: 'upload.pipeline.failed',
    operationId: refs.operationId,
    errorCode,
    outcome,
  })
  return outcome
}

// 予期しない throw を台帳(+ Discord)へ載せる(spec §4.4 (b))。`errorCode` は
// 「operation ごと terminal 化したのか(pipeline_unexpected_error)」と「crop だけ
// 縮退して publish は成功したのか(crop_phase_failed)」を通知面で区別するため —
// 後者は op が `completed` で終わるので、この 1 行が唯一の運用シグナルになる。
async function recordUnexpectedFailure(
  userId: string,
  operationId: string,
  err: unknown,
  errorCode:
    | 'pipeline_unexpected_error'
    | 'crop_phase_failed'
    // ②-4b T8(spec D7 r4): webp 累計超過は terminal だけでなく loud(運用へ通知)。
    | 'webp_limit_exceeded' = 'pipeline_unexpected_error',
): Promise<void> {
  try {
    await recordIntegrationFailure({
      key: 'ocr_pipeline',
      userId,
      subject: 'upload OCR pipeline unexpected error',
      // 台帳 DB 列にのみ入る開発者向け情報。context(= Discord にもそのまま出る)側は
      // operationId + errorCode だけに絞る。
      errorMessage: err instanceof Error ? err.message : String(err),
      context: { operationId, errorCode },
    })
  } catch (recordErr) {
    // 台帳書込/通知の失敗で pipeline を throw させない(throw しない契約)。
    logger.error({
      event: 'upload.pipeline.record_failure_failed',
      operationId,
      err: recordErr,
    })
  }
}

// phase 別所要時間(時間予算の暫定値を実測で見直すための材料・spec §11)。
// **warn で出す**: production の既定 log level は warn(lib/logger.ts
// resolveLogLevel)ゆえ info だと本番で不可視になり計測材料にならない。
// PII-free(operationId / phase 名 / ミリ秒のみ — filename やカード本文は入れない。
// 枚数は upload_operations.expected_source_count から operationId で辿れる)。
function logPhase(operationId: string, phase: string, ms: number): void {
  logger.warn({ event: 'upload.pipeline.phase', operationId, phase, ms })
}
