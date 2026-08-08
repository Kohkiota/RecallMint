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
// **source を R2 に置かない**: 新経路の source は request body のバイトだけで完結
// する(spec §2)。本 file は R2 module を import しない(unit/iso 両方で pin)—
// R2 へ出るのは crop-derived asset のみで、それは lib/media/crop-and-store.ts の
// 責務(PUT key は `users/{uid}/{assetId}.webp` 形のみ・`src/` を作らない)。
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
import {
  classifyCropOutcome,
  cropFigureFromBuffer,
  type CropAndStoreOutcome,
} from '@/lib/media/crop-and-store'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { type PreparedPayload } from '@/lib/ocr/prepared-schema'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { publishPreparedUploadTx } from '../_actions/publish-prepared'
import { CROP_MIN_REMAINING_MS } from './constants'
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
// **T7 時点では受け取るだけで未使用**(型を通すためのプレースホルダ)。
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
  // ②-4b T7 が渡す PDF manifest + R2 namespace(spec §13 r5 表)。**T7 時点では
  // 受け取るだけで未使用** — T8(count/render phase の実装)がここを消費する。
  // 既定 `[]`/`undefined` により既存呼出元(images-only・upload-pipeline.test.ts /
  // tests/integration/pg/upload-pipeline.test.ts)は無改変で通る。
  sourcePdfManifest: UploadPipelineSourcePdf[] = [],
  uploadSessionId?: string,
  // ②-4b T7 fix round 1(canonical Critical): 混在 submit の manifest 順(spec §2/
  // D3)。**T7 時点では受け取るだけで未使用**(型を通すためのプレースホルダ・
  // T8 が files/sourcePdfManifest を zip し直すのに使う)。
  sourceOrder: UploadPipelineSourceOrderEntry[] = [],
): Promise<void> {
  // eslint 用の明示的な no-op 参照(T8 実装までの一時措置)。値そのものは使わない —
  // 未使用引数として扱われないよう void で捨てる(brief: 「受け取るだけで未使用」)。
  void sourcePdfManifest
  void uploadSessionId
  void sourceOrder
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
    await terminalize(userId, refs, leaseVersion, 'pipeline_unexpected_error', ANY_PHASE_FENCE)
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
    return
  }

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
    await terminalize(userId, refs, leaseVersion, 'image_decode_failed', PRE_COMMIT_FENCE)
    return
  }

  // ---- 残余予算の確認(統合予算・起点 = action 入口) ----
  // ここは「初回 attempt を始めてよいか」の判断。retry 経路を守るのは
  // callImageCropWithRetry(deadlineAt)側の責務だが、初回 attempt はそこを通らない
  // ため同じ基準(1 attempt は最悪 GEMINI_TIMEOUT_MS)をここでも課す — 残余 1ms でも
  // 220s の call を始めてしまうと invocation が platform に打ち切られ、失敗理由が
  // op にも台帳にも残らない(constants.ts の算術参照)。
  if (deadlineAt.getTime() - Date.now() < GEMINI_TIMEOUT_MS) {
    await terminalize(userId, refs, leaseVersion, 'deadline_exceeded', PRE_COMMIT_FENCE)
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
    await terminalize(
      userId,
      refs,
      leaseVersion,
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
    await terminalize(userId, refs, leaseVersion, prepared, PRE_COMMIT_FENCE)
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
  // upload_records.file_size_bytes は受領 Buffer の合計(spec 2026-08-04 §4)。
  const fileSizeBytes = files.reduce((sum, f) => sum + f.buffer.length, 0)
  await runPublishPhase(userId, refs, leaseVersion, payload, dispositionByAssetId, fileSizeBytes)
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
      await terminalize(userId, refs, leaseVersion, 'publish_failed', POST_COMMIT_FENCE)
      return
    }
    if (published.outcome === 'stale') {
      // fencing に負けた(supersede / GDPR 削除等)。この実行の結果で上書きしない。
      logger.warn({ event: 'upload.pipeline.publish_raced', operationId: refs.operationId })
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
async function terminalize(
  userId: string,
  refs: UploadPipelineRefs,
  leaseVersion: number,
  errorCode: PipelineErrorCode,
  expectedStatuses: readonly FenceStatus[],
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
}

// 予期しない throw を台帳(+ Discord)へ載せる(spec §4.4 (b))。`errorCode` は
// 「operation ごと terminal 化したのか(pipeline_unexpected_error)」と「crop だけ
// 縮退して publish は成功したのか(crop_phase_failed)」を通知面で区別するため —
// 後者は op が `completed` で終わるので、この 1 行が唯一の運用シグナルになる。
async function recordUnexpectedFailure(
  userId: string,
  operationId: string,
  err: unknown,
  errorCode: 'pipeline_unexpected_error' | 'crop_phase_failed' = 'pipeline_unexpected_error',
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
