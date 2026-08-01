'use server'

import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import {
  assets,
  cardAssetRefs,
  exams,
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  uploadRecords,
  type CardImage,
  type User,
} from '@/lib/db/schema'
import { isAssetKey } from '@/lib/validation/card'
import { saveExtractedCards } from './upload-persistence'
import { projectCardAssetRefs } from '@/lib/cards/domain/card-asset-refs'
import {
  cropFigureAndStore,
  classifyCropOutcome,
  type CropAndStoreOutcome,
} from '@/lib/media/crop-and-store'
import {
  preparedPayloadSchema,
  type PreparedCard,
  type PreparedPayloadV1,
} from '@/lib/ocr/prepared-schema'
import { logger } from '@/lib/logger'
import { RETRYABLE_BACKOFF_MS } from '../_lib/constants'
import {
  planPublish,
  buildCardRows,
  buildResultSummary,
  type FigureDisposition,
} from '../_lib/publish-prepared-plan'

// ②-4a Phase E Task 12: publishPreparedUploadTx orchestrator。 spec:
// docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md §8(publish・
// ロック順・保護 UPDATE)/ §2(fencing = 最終防衛)/ §5.4(publisher は保存済み
// payload を parse するだけで再正規化しない)。
//
// ★ 本 task の最重要不変条件 = **最終防衛 fencing**。 crop は idempotent かつ tx の
// 外(R2 I/O を DB tx に持ち込まない・spec §7.3)。 lease を横取りされた(takeover・
// T12b)stale worker は crop まで到達しうる(crop は status='prepared' だけを見て
// lease_version を見ない)が、 この publish tx 冒頭の `SELECT … FOR UPDATE` +
// `status='prepared' AND lease_version=:mine` 不一致拒否で必ず弾かれる。 これが
// カード二重作成を防ぐ唯一の権威 gate であり、 T6 の claim-time CAS の代替ではない。
//
// prepared takeover(claimPrepared / publish-resume・spec §2.2)は T12b の責務で
// 本 file には無い。 だが本 file の fencing が「stale worker を必ず拒否する」ことが
// T12b を安全にする前提になっている。
//
// flow(brief 準拠):
//   [orchestrator] payload 読取(fenced fast-fail)→ 全 figure crop(tx 外・R2 I/O)
//     → publish 条件判定(planPublish・純粋)→ publishPreparedUploadTx(短い DB tx)
//   [tx] fence → exam → source_document → 保護 asset UPDATE → cards/tags(saveExtractedCards)
//     → refs → counter(bump)→ finalize(payload NULL + result_summary + completed)

export type PublishPreparedInput = {
  operationId: string
  leaseVersion: number
}

export type PublishPreparedResult =
  // publish 成功(全滅/一部/全成功いずれも status='completed'・warnings は
  // result_summary に集約・enum 追加なし・spec §8.3)。
  | { outcome: 'published'; cardsPublished: number; figuresAttached: number }
  // fencing 不一致(takeover 済み / 既に completed 等)。 何も publish しない。
  | { outcome: 'stale' }
  // figure が 1 件でも retryable、 または DB 失敗。 publish せず再試行に回す。
  | { outcome: 'retryable'; reason: string }
  // 有効カード 0(spec §8.3。 通常 stage が cards≥1 を保証するため防御的)、
  // または保存済み payload の破損(loud internal error)。
  | { outcome: 'failed'; reason: string }
  | { outcome: 'not_found' }
  | { outcome: 'unauthenticated' }

const publishInputSchema = z.object({
  operationId: z.uuid(),
  leaseVersion: z.number().int().nonnegative(),
})

// crop-and-store の never-throw outcome を publish 決定用 disposition へ翻訳する
// (planPublish に crop-and-store の重い依存を持ち込まないための境界・spec §8.3)。
//   - not_prepared: operation がもう 'prepared' でない = この worker は stale。
//   - source_not_ready: source が race で消えた/deleting 化 = この figure は
//     取り込めない(exclude)。 source 消失は回復しないため text card は publish
//     する(§8.3「crop 全滅でも text publish」と同じ扱い)。
//   - success('stored'/'reused') → attach / terminal → exclude / retryable → retryable。
function dispositionOf(outcome: CropAndStoreOutcome['outcome']): FigureDisposition {
  if (outcome === 'not_prepared') return 'not_ours'
  if (outcome === 'source_not_ready') return 'exclude'
  const cls = classifyCropOutcome(outcome)
  if (cls === 'success') return 'attach'
  if (cls === 'retryable') return 'retryable'
  return 'exclude' // terminal(crop_failed / forbidden / hash_mismatch)
}

// ---------------------------------------------------------------------------
// publishPreparedUploadTx — cards/tags/refs/counter/status を確定する短い DB tx。
// spec §8.1 のロック順を厳守: operation → exam → source_document → assets(ID順)
// → cards → tags → refs → counters/status/operation。
//
// 返り値は 'published' / 'stale'(fencing 不一致)のみ。 保護 UPDATE 期待未満 /
// 重複 card id(ON CONFLICT なし)/ その他 DB error は **throw** して tx 全体を
// rollback する(部分 commit させない・重複は silent に握らず loud fail・spec
// Global Constraint「cards に ON CONFLICT 不使用」)。 orchestrator が throw を
// catch して retryable に写像する。
//
// iso test が Clerk 無しで直接 exercise できるよう Tx-suffix で export する
// (claimOperationTx と同流儀)。
// ---------------------------------------------------------------------------
export async function publishPreparedUploadTx(
  tx: TenantTx,
  args: {
    userId: string
    operationId: string
    leaseVersion: number
    cards: readonly PreparedCard[]
    cardImagesByCardId: Record<string, CardImage[]>
    resultSummary: Record<string, unknown>
  },
): Promise<{ outcome: 'published' } | { outcome: 'stale' }> {
  const { userId, operationId, leaseVersion, cards, cardImagesByCardId, resultSummary } = args

  // 1. FINAL-DEFENSE FENCING(本 task の top invariant・spec §2/§8.1)。 operation を
  //    SELECT … FOR UPDATE(ロック順の起点)し、 status='prepared' AND
  //    lease_version=:mine を要求する。 不一致(takeover された stale worker 含む)は
  //    何も書かず 'stale' を返す — これがカード二重作成を防ぐ唯一の権威 gate。
  const opRows = await tx
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      examId: uploadOperations.examId,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      // fix round 3: source_documents/upload_records の pages_processed(= source
      // 画像数)は T6 が確定させた immutable oracle を使う(source_assets の COUNT
      // から導出しない・spec §8.2/§2.1)。
      expectedSourceCount: uploadOperations.expectedSourceCount,
    })
    .from(uploadOperations)
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))
    .for('update')

  const op = opRows[0]
  if (!op || op.status !== 'prepared' || op.leaseVersion !== leaseVersion) {
    return { outcome: 'stale' }
  }
  const { examId, sourceDocumentId, expectedSourceCount } = op

  // 2. exam を FOR UPDATE(ロック順 #2)。 存在・所有権をここで検証する — これが
  //    後段 bumpExamCardCount の「affected row 検証」相当を、 書込前・ロック取得と
  //    同時に、 より強く担保する(exam 不在/非所有なら以降を一切書かず throw)。
  const examRows = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .for('update')
  if (examRows.length === 0) {
    throw new Error('publishPreparedUploadTx: exam not found or not owned')
  }

  // 3. source_document を finalize(ロック順 #3)。 prepared operation は
  //    source_document_id を確定済み(T4)。 Fix #1 defense-in-depth(Codex P1):
  //    null は orchestrator が terminal_failed で弾く(source_document 削除 =
  //    FK onDelete:set null)。 それでも null が tx へ到達したら **skip-and-publish
  //    せず throw(rollback)** — detached content を絶対に作らない。
  //
  //    fix round 3(spec §8.2「completeUploadTx 相当」②): この UPDATE が source_document
  //    の行ロックを取得(ロック順 #3 を満たす)しつつ status='completed' へ確定する
  //    (spec §9 の open item「後から publisher が completed へ戻す」の実体・exam status
  //    API / source-doc-status.ts が読む)。 legacy completeUploadTx は再利用しない
  //    (id+userId のみ・開始 status 非検証)。 filename は upload_records 記帳(step 8)で
  //    使うため同 UPDATE の RETURNING で取得する。
  if (sourceDocumentId === null) {
    throw new Error('publishPreparedUploadTx: source_document_id is null (deleted?)')
  }
  const sdRows = await tx
    .update(sourceDocuments)
    .set({
      status: 'completed',
      pagesProcessed: expectedSourceCount,
      cardsExtracted: cards.length,
      completedAt: sql`now()`,
    })
    .where(and(eq(sourceDocuments.id, sourceDocumentId), eq(sourceDocuments.userId, userId)))
    .returning({ id: sourceDocuments.id, filename: sourceDocuments.filename })
  if (sdRows.length === 0) {
    throw new Error('publishPreparedUploadTx: source_document not found or not owned')
  }
  const sourceFilename = sdRows[0].filename

  // 4. 保護 asset UPDATE(spec §8.1・ロック順 #4「assets(ID 順)」)。 refs を張る
  //    対象 asset が今も 'ready' か確認してから refs を張る — FK は行存在のみ検証し
  //    status を制約しない(schema.ts card_asset_refs)ため、 prepared〜publish の
  //    間に GC/GDPR で deleting 化した asset を参照してしまう race を閉じる。
  //    まず ready 行を **ID 順に FOR UPDATE ロック**(単一 UPDATE は行ロック順を
  //    保証できず GC 等と逆順ロックでデッドロックしうるため)し、 期待件数を検証
  //    してから unreferenced_at をクリアする。
  const expectedReadyAssetIds = Array.from(
    new Set(
      Object.values(cardImagesByCardId)
        .flat()
        .map((img) => img.key)
        .filter((key) => isAssetKey(key)),
    ),
  ).sort()

  if (expectedReadyAssetIds.length > 0) {
    const readyRows = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.userId, userId),
          inArray(assets.id, expectedReadyAssetIds),
          eq(assets.status, 'ready'),
        ),
      )
      .orderBy(assets.id)
      .for('update')

    if (readyRows.length < expectedReadyAssetIds.length) {
      // 期待未満 = crop 済み asset の一部が prepared〜publish 間に GC/GDPR で
      // ready を外れた。 非 ready asset への ref を作らない(spec §8.1)— tx 全体を
      // rollback して retryable にする(次の試行で当該 figure は再 crop され、
      // deleting なら terminal 除外となり text card は publish される)。
      throw new PublishProtectiveMismatchError(readyRows.length, expectedReadyAssetIds.length)
    }
    await tx
      .update(assets)
      .set({ unreferencedAt: null })
      .where(
        and(
          eq(assets.userId, userId),
          inArray(
            assets.id,
            readyRows.map((r) => r.id),
          ),
        ),
      )
  }

  // 5. cards(ロック順 #5)+ tags(#6)を saveExtractedCards で確定する。 cards は
  //    ON CONFLICT を使わない(重複 card id は設計破綻 = loud fail・spec Global
  //    Constraint)。 custom_props は card ID で対応付ける(§改修)。 applyOcrTags は
  //    §T13 の determinism 版。 exam は手順2で FOR UPDATE 済ゆえ、 saveExtractedCards
  //    内の bumpExamCardCount(exam UPDATE)は既取得ロックへの書込で、 ロック取得
  //    順(exam #2 を assets #4 より前に取得済)を崩さない。
  const cardRows = buildCardRows(cards, cardImagesByCardId, {
    userId,
    examId,
    sourceDocumentId,
  })
  const customPropsById: Record<string, PreparedCard['customProps']> = {}
  for (const card of cards) customPropsById[card.cardId] = card.customProps

  await saveExtractedCards(tx, { userId, examId, cardRows, customPropsById })

  // 6. refs(ロック順 #7)。 各 card の採用 image を card_asset_refs へ射影する
  //    (T11 の pure projection を共有)。 保護 UPDATE を通過した ready asset のみ
  //    (= 採用 image の key)を対象にする。
  const refRows = cards.flatMap((card) =>
    projectCardAssetRefs(card.cardId, userId, cardImagesByCardId[card.cardId] ?? []),
  )
  if (refRows.length > 0) {
    await tx.insert(cardAssetRefs).values(refRows)
  }

  // 7. upload_records 記帳(spec §8.2「completeUploadTx 相当」③・legacy と同じ
  //    「一蓮托生」= 同一 publish tx。 protective mismatch / 重複 card 等で publish が
  //    rollback すれば source_documents/cards/operation と共にこの行も消える)。
  //    append-only 台帳・月次 quota SUM の対象(getCurrentMonthOcrPages が
  //    status='completed' の pages_processed を SUM)ゆえ pages_processed は 0 でなく
  //    実 source 画像数(= expectedSourceCount)を書く。 file_size_bytes は
  //    source_assets.byte_size 合計(finalize 後 immutable ゆえ plain SELECT・lock 不要)。
  //    ocr_cost_yen は新 flow が publish 時に cost を持たないため NULL(quota SUM は
  //    pages_processed で成立し cost に非依存・spec §8.2)。 enforcement は ②-5(記帳 ≠ 強制)。
  const sizeRows = await tx
    .select({ total: sql<number>`COALESCE(SUM(${sourceAssets.byteSize}), 0)::int` })
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.sourceDocumentId, sourceDocumentId),
        eq(sourceAssets.userId, userId),
      ),
    )
  const fileSizeBytes = Number(sizeRows[0]?.total ?? 0)
  await tx.insert(uploadRecords).values({
    userId,
    filename: sourceFilename,
    fileSizeBytes,
    pagesProcessed: expectedSourceCount,
    ocrCostYen: null,
    status: 'completed',
  })

  // 8. finalize(ロック順 #8「counters/status/operation」)。 payload を NULL 化 +
  //    result_summary 保存 + status='completed'。 WHERE に開始 status(prepared)+
  //    lease_version guard を付け「開始 status 検証込みの新規 finalize」とする
  //    (legacy completeUploadTx を流用しない・plan)。 手順1で FOR UPDATE 済ゆえ
  //    0 行は起きない想定 — 起きたら内部不整合として throw(rollback)。
  const finalized = await tx
    .update(uploadOperations)
    .set({
      preparedPayload: null,
      resultSummary,
      status: 'completed',
      completedAt: sql`now()`,
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'prepared'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  if (finalized.length === 0) {
    throw new Error('publishPreparedUploadTx: finalize guard failed (operation state changed)')
  }

  return { outcome: 'published' }
}

// 保護 UPDATE の期待件数未満(GC/GDPR race で ready asset が消えた)を表す sentinel。
// orchestrator が retryable に写像する(DB error と同じ扱い)。 'use server' file は
// 非 async の value export を許さない(SWC 71011)ため export しない — orchestrator は
// throw を error 種別で区別せず一律 retryable にするので export 不要。
class PublishProtectiveMismatchError extends Error {
  constructor(
    readonly ready: number,
    readonly expected: number,
  ) {
    super(`publish protective UPDATE returned ${ready} < expected ${expected} ready assets`)
    this.name = 'PublishProtectiveMismatchError'
  }
}

// retryable(figure retryable / DB 失敗)を fenced CAS で永続化する。 status は
// 'prepared' のまま維持し lease を解放 + next_retry_at/last_error_code/attempt++ を
// 記録する(stage-prepared の非 terminal failure と同型・status のみ 'prepared')。
// takeover 済み(0 行)なら false を返し orchestrator は stale とする。
async function persistPublishRetryCas(
  tx: TenantTx,
  userId: string,
  operationId: string,
  leaseVersion: number,
  errorCode: string,
): Promise<boolean> {
  const updated = await tx
    .update(uploadOperations)
    .set({
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
      nextRetryAt: sql`now() + make_interval(secs => ${RETRYABLE_BACKOFF_MS / 1000})`,
      attemptCount: sql`${uploadOperations.attemptCount} + 1`,
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'prepared'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  return updated.length > 0
}

async function persistPublishRetry(
  userId: string,
  operationId: string,
  leaseVersion: number,
  reason: string,
): Promise<PublishPreparedResult> {
  const persisted = await withTenantTx(userId, (tx) =>
    persistPublishRetryCas(tx, userId, operationId, leaseVersion, reason),
  )
  if (!persisted) {
    // fencing に負けた = 別実行(takeover)が横取りした。 この実行の失敗情報で
    // 他実行の状態を上書きしない(stale として返す)。
    logger.warn({ event: 'ocr.publish.retry_persist_raced', operationId, reason })
    return { outcome: 'stale' }
  }
  logger.error({ event: 'ocr.publish.retryable', operationId, reason })
  return { outcome: 'retryable', reason }
}

// 恒久失敗(source_document 削除 / payload 破損 / 有効カード 0)を fenced CAS で
// terminal_failed として永続化する(fix round 1・Codex P1/P2)。 status='prepared'
// のまま返すと takeover/retry が同じ恒久失敗を無限に踏み直す(or detached content を
// publish する)ため、 status='terminal_failed' + prepared_payload=NULL に確定させ、
// 再送 replay が終端結果を観測できるようにする。 stage-prepared.ts の
// persistManifestIncompleteTerminal と同型だが、 こちらは別 tx なので fencing
// (status='prepared' AND lease_version=:mine)を CAS に含める — 0 行 = lease を
// 横取りされた ⇒ 呼出元は stale を返し、 taken-over op を絶対に上書きしない。
async function persistTerminalFailedCas(
  tx: TenantTx,
  userId: string,
  operationId: string,
  leaseVersion: number,
  reason: string,
): Promise<boolean> {
  const updated = await tx
    .update(uploadOperations)
    .set({
      status: 'terminal_failed',
      preparedPayload: null,
      lastErrorCode: reason,
      resultSummary: { reason },
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'prepared'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  return updated.length > 0
}

// fenced terminal 永続化 + outcome 写像。 persisted → { failed, reason } /
// taken-over(0 行)→ stale。
async function persistTerminalFailed(
  userId: string,
  operationId: string,
  leaseVersion: number,
  reason: string,
): Promise<PublishPreparedResult> {
  const persisted = await withTenantTx(userId, (tx) =>
    persistTerminalFailedCas(tx, userId, operationId, leaseVersion, reason),
  )
  if (!persisted) {
    logger.warn({ event: 'ocr.publish.terminal_persist_raced', operationId, reason })
    return { outcome: 'stale' }
  }
  logger.error({ event: 'ocr.publish.terminal_failed', operationId, reason })
  return { outcome: 'failed', reason }
}

async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// publishPreparedUpload — orchestrator(auth + payload 読取 + crop + 条件判定 + tx)。
// ---------------------------------------------------------------------------
export async function publishPreparedUpload(
  input: PublishPreparedInput,
): Promise<PublishPreparedResult> {
  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }
  const userId = user.id

  const parsed = publishInputSchema.safeParse(input)
  if (!parsed.success) return { outcome: 'not_found' }
  const { operationId, leaseVersion } = parsed.data

  // Step A: payload 読取(fenced fast-fail・非 FOR UPDATE。 権威 fence は tx 冒頭)。
  const opRows = await withTenantTx(userId, (tx) =>
    tx
      .select({
        status: uploadOperations.status,
        leaseVersion: uploadOperations.leaseVersion,
        examId: uploadOperations.examId,
        sourceDocumentId: uploadOperations.sourceDocumentId,
        preparedPayload: uploadOperations.preparedPayload,
      })
      .from(uploadOperations)
      .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId))),
  )
  const op = opRows[0]
  if (!op) return { outcome: 'not_found' }
  if (op.status !== 'prepared' || op.leaseVersion !== leaseVersion) {
    return { outcome: 'stale' }
  }
  // Fix #1(Codex P1): source_document が削除された prepared op は publish しない。
  // upload_operations.source_document_id FK は onDelete:'set null'(schema.ts)ゆえ、
  // T14 GC / T15 GDPR が source_document を消すと sourceDocumentId===null になる。
  // これを publish すると「削除ワークフロー中にユーザーコンテンツを再作成」= privacy
  // boundary 侵害。 crop より前(無駄 crop 回避)に fenced terminal_failed で確定する。
  if (op.sourceDocumentId === null) {
    return persistTerminalFailed(userId, operationId, leaseVersion, 'source_document_deleted')
  }

  if (op.preparedPayload === null) {
    // status='prepared' なのに payload 無し = 内部不整合(現状コード上は到達不能 —
    // stage は payload と status='prepared' を atomic に書く)。 Fix round 2(Codex
    // fix1 P2 + canonical 収束): これも sibling の corrupt/empty と同じ「恒久破損の
    // prepared op」であり、 stale 返しだと reclaim 機構(T12b prepared takeover・次
    // task)導入後に無限 reclaim に化ける forward-looking hazard。 4 分岐(null-source /
    // corrupt / empty / null-payload)を一貫して fenced terminal に揃える。 warn は
    // observability のため維持。
    logger.warn({ event: 'ocr.publish.prepared_without_payload', operationId })
    return persistTerminalFailed(userId, operationId, leaseVersion, 'prepared_without_payload')
  }

  // 保存済み payload を **同じ schema で parse するだけ**(publisher は再正規化 /
  // ID 再発行しない・spec §5.4)。 parse 失敗は loud internal error(stage が保証
  // した契約が破れている = バグ)。 Fix #2(Codex P2): 恒久失敗ゆえ status='prepared'
  // のまま返すと takeover/retry が同じ parse 失敗を無限に踏むため fenced terminal 化。
  let payload: PreparedPayloadV1
  try {
    payload = preparedPayloadSchema.parse(op.preparedPayload)
  } catch (err) {
    logger.error({ event: 'ocr.publish.payload_parse_failed', operationId, err })
    return persistTerminalFailed(userId, operationId, leaseVersion, 'payload_corrupt')
  }

  if (payload.cards.length === 0) {
    // 有効カード 0 → 恒久失敗(spec §8.3。 stage が cards≥1 を保証するため防御的)。
    // Fix #2: 同上 — fenced terminal 化(prepared のままだと再試行で無限ループ)。
    return persistTerminalFailed(userId, operationId, leaseVersion, 'empty_payload')
  }

  // Step B: 全 figure を crop(tx の外・R2 I/O。 spec §7.3「crop-derived asset は
  //   prepared commit 後のみ」は cropFigureAndStore 自身が status='prepared' 確認で
  //   担保。 crop は idempotent = retry/横取りで同 asset へ収束)。
  const dispositionByAssetId = new Map<string, FigureDisposition>()
  for (const card of payload.cards) {
    for (const figure of card.figures) {
      const outcome = await cropFigureAndStore({
        userId,
        operationId,
        sourceId: figure.sourceId,
        figureAssetId: figure.assetId,
        box2d: figure.box_2d,
        detectTarget: figure.target,
      })
      dispositionByAssetId.set(figure.assetId, dispositionOf(outcome.outcome))
    }
  }

  // Step C: publish 条件判定(純粋)。
  const plan = planPublish(payload.cards, dispositionByAssetId)
  if (plan.decision === 'stale') return { outcome: 'stale' }
  if (plan.decision === 'retryable') {
    // figure が retryable = 再試行に回す(fenced CAS で retry marker を記録)。
    return persistPublishRetry(userId, operationId, leaseVersion, 'figure_retryable')
  }

  // Step D: publish tx(短い DB tx・fencing + 保護 UPDATE + cards/tags/refs/finalize)。
  const resultSummary = buildResultSummary(payload, plan, {
    operationId,
    examId: op.examId,
    sourceDocumentId: op.sourceDocumentId,
  })

  let txResult: { outcome: 'published' } | { outcome: 'stale' }
  try {
    txResult = await withTenantTx(userId, (tx) =>
      publishPreparedUploadTx(tx, {
        userId,
        operationId,
        leaseVersion,
        cards: payload.cards,
        cardImagesByCardId: plan.cardImagesByCardId,
        resultSummary,
      }),
    )
  } catch (err) {
    // 保護 UPDATE 期待未満 / 重複 card id(loud fail)/ その他 DB error は tx 全体が
    // rollback 済み(部分 commit なし)。 retryable に写像し loud に記録する
    // (silent に握らない = 重複 card id の loud fail 要件を満たす)。
    logger.error({ event: 'ocr.publish.tx_failed', operationId, err })
    return persistPublishRetry(userId, operationId, leaseVersion, 'db_error')
  }

  if (txResult.outcome === 'stale') return { outcome: 'stale' }

  return {
    outcome: 'published',
    cardsPublished: payload.cards.length,
    figuresAttached: plan.figuresAttached,
  }
}
