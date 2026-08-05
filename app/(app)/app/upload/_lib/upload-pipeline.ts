// ②-4a 単一 invocation Sprint Task S-2(spec 2026-08-04 §4): submit で受け取った
// バイトを**そのメモリのまま** OCR に掛け、prepared_payload を commit する phase。
//
// directive 無し共有 module(publish-prepared-orchestrate.ts / stage-prepared-retry.ts
// と同じ「'use server' file から参照される directive 無し module」パターン)。
// ここに置く理由は 2 つ:
//   ① `deadlineAt` / `leaseVersion` といったサーバー側の安全弁を引数に持つ。
//      'use server' file の export は client から action-id 経由で到達可能なため、
//      これらを公開 action の引数にしてはいけない(T14a fix round 1・Codex P2 と
//      同じ判断)。
//   ② S-4 で `after()` に載せ替える(request 応答後に走らせる)ため、request 由来の
//      オブジェクト(File / FormData)を一切受け取らない形に固定しておく。
//      呼出側が Buffer を実体化してから渡す契約(引数は Buffer + 文字列のみ)。
//
// **R2 を使わない**: 新経路の source は request body のバイトだけで完結し、R2 に
// 置かない(spec §2)。本 file は R2 module を import しない(unit/iso 両方で pin)。
//
// **throw しない契約**: 失敗の分類・terminal 化・台帳記録はすべてこの module の
// 内部責務で、呼出側(S-4 の after())は薄い呼出だけを持つ。予期しない throw も
// catch-all で吸収する。
//
// **失敗は全て terminal**(spec §4.5): 新経路に resume は無い(旧経路の
// retryable_failed / next_retry_at は移植しない)。op を terminal_failed にし、
// 同一 tx で source_document を failed にする(terminalizeAbandonedOperation)。
import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { incrementAiUsage } from '@/lib/ai-usage-counter'
import { GEMINI_TIMEOUT_MS, type GeminiCallResult } from '@/lib/ai/clients/gemini'
import {
  buildSourceIdInterleavedParts,
  type SourceIdImage,
} from '@/lib/ai/clients/ocr-image-crop-parts'
import { buildImageCropExplorationPrompt } from '@/lib/ai/prompts/ocr-figure-suffix'
import { buildImageCropResponseJsonSchema } from '@/lib/ai/schemas/ocr-image-crop-response'
import { uploadOperations } from '@/lib/db/schema'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { logger } from '@/lib/logger'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { type PreparedPayload } from '@/lib/ocr/prepared-schema'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { verifyImageBytes, type VerifiedImage } from './source-image-verify'
import { assemblePreparedPayload, computePreparedHash } from './stage-prepared-payload'
import { callImageCropWithRetry } from './stage-prepared-retry'
import { terminalizeAbandonedOperation } from './terminalize-abandoned-operation'

export type UploadPipelineRefs = {
  operationId: string
  examId: string
  sourceDocumentId: string
}

// 呼出側(submit-upload.ts)が request body から実体化した 1 file 分のバイト。
// filename は crop/表示側(S-3 以降)が扱う受領時メタで、本 phase は使わない
// (Gemini に渡すのは バイトと server 採番の source_id だけ)。
export type UploadPipelineFile = {
  buffer: Buffer
  filename: string
}

// decode 検証で確定した source ごとのメタ。width/height は S-3 の crop が
// box_2d(0-1000 正規化座標)を実ピクセルへ戻す際の分母になるため、decode の
// 場で確定させてここに保持する(decode 済み pixel 自体は verifyImageBytes の
// 中で解放され、この配列には載らない = メモリ見積りの前提)。
type VerifiedSource = VerifiedImage & { sourceId: string }

// 失敗理由(upload_operations.last_error_code に入る値)。旧経路
// (stage-prepared.ts)の語彙に倣い、新経路固有のものだけを足している。
type PipelineErrorCode =
  | 'image_decode_failed'
  | 'deadline_exceeded'
  | 'gemini_rate_limited'
  | 'gemini_call_failed'
  | 'json_parse_failed'
  | 'empty_cards'
  | 'pipeline_unexpected_error'

/**
 * 受領バイト → decode 検証 → Gemini → 正規化 → prepared_payload commit。
 *
 * 呼出前提: `refs.operationId` は呼出側がこの invocation で作った
 * `status='processing'` の operation で、`leaseVersion` はその行の値。
 * 成功時は `status='prepared'` で終わる(crop / publish は S-3)。
 */
export async function runUploadPipeline(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  files: UploadPipelineFile[],
  deadlineAt: Date,
): Promise<void> {
  const startedAt = Date.now()
  try {
    await runOcrPhase(userId, refs, leaseVersion, files, deadlineAt)
  } catch (err) {
    // ここに来るのは「予期しない」失敗だけ(予期される失敗は runOcrPhase 内で
    // terminal 化して return する)。after() 化後は呼出元が居ないため、throw を
    // そのまま外へ出すと失敗が operation 行にも台帳にも残らない。
    await absorbUploadPipelineFailure(userId, refs, leaseVersion, err)
  } finally {
    logPhase(refs.operationId, 'total', Date.now() - startedAt)
  }
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
export async function absorbUploadPipelineFailure(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  err: unknown,
): Promise<void> {
  try {
    await terminalize(userId, refs, leaseVersion, 'pipeline_unexpected_error')
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
): Promise<void> {
  // 各 phase の所要時間 log は **失敗分岐より前**に出す(log の目的は暫定予算の
  // 較正であり、較正上いちばん危ないのは「遅い / timeout する呼出」= 失敗する
  // 呼出そのもの。成功時しか出ないと測りたい値が落ちる)。

  // ---- decode 検証 + source_id 採番(逐次) ----
  const decodeStartedAt = Date.now()
  const sources: VerifiedSource[] = []
  const sourceImages: SourceIdImage[] = []
  let decodeFailed = false
  for (const file of files) {
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
    sources.push({ sourceId, ...verified })
    sourceImages.push({
      // mimeType は decode 結果(sharp)由来 — client 申告や拡張子は使わない。
      sourceId,
      file: { mimeType: verified.mime, data: file.buffer.toString('base64') },
    })
  }
  logPhase(refs.operationId, 'decode', Date.now() - decodeStartedAt)
  if (decodeFailed) {
    await terminalize(userId, refs, leaseVersion, 'image_decode_failed')
    return
  }

  // ---- 残余予算の確認(統合予算・起点 = action 入口) ----
  // ここは「初回 attempt を始めてよいか」の判断。retry 経路を守るのは
  // callImageCropWithRetry(deadlineAt)側の責務だが、初回 attempt はそこを通らない
  // ため同じ基準(1 attempt は最悪 GEMINI_TIMEOUT_MS)をここでも課す — 残余 1ms でも
  // 220s の call を始めてしまうと invocation が platform に打ち切られ、失敗理由が
  // op にも台帳にも残らない(constants.ts の算術参照)。
  if (deadlineAt.getTime() - Date.now() < GEMINI_TIMEOUT_MS) {
    await terminalize(userId, refs, leaseVersion, 'deadline_exceeded')
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
      // 日次 cap の計上は attempt ごと(retry も 1 call として数える)。
      () => incrementAiUsage(userId, 1),
      undefined,
      // retry ループの内側で残余を見させる(I-1)。
      deadlineAt,
    )
  } catch (err) {
    geminiError = err
  }
  logPhase(refs.operationId, 'gemini', Date.now() - geminiStartedAt)
  if (geminiResult === null) {
    await terminalize(
      userId,
      refs,
      leaseVersion,
      isRateLimitError(geminiError) ? 'gemini_rate_limited' : 'gemini_call_failed',
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
    await terminalize(userId, refs, leaseVersion, prepared)
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
async function terminalize(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  errorCode: PipelineErrorCode,
): Promise<void> {
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
    // **S-3 への義務**: crop / publish は prepared commit の**後**(status='prepared')に
    // 走るため、その区間の失敗をここに流すと 'processing' 以外 = 'raced' と誤分類され、
    // op が prepared + live lease のまま残る。S-3 は許容 status をその phase に合わせて
    // 広げること(この fence を「processing 固定」のまま流用しない)。
    if (!op || op.status !== 'processing' || op.leaseVersion !== leaseVersion) {
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
}

async function recordUnexpectedFailure(
  userId: string,
  operationId: string,
  err: unknown,
): Promise<void> {
  try {
    await recordIntegrationFailure({
      key: 'ocr_pipeline',
      userId,
      subject: 'upload OCR pipeline unexpected error',
      // 台帳 DB 列にのみ入る開発者向け情報。context(= Discord にもそのまま出る)側は
      // operationId + errorCode だけに絞る。
      errorMessage: err instanceof Error ? err.message : String(err),
      context: { operationId, errorCode: 'pipeline_unexpected_error' },
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
