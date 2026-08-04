'use server'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { sourceAssets, uploadOperations, type User } from '@/lib/db/schema'
import { getObject } from '@/lib/storage/r2'
import { incrementAiUsage } from '@/lib/ai-usage-counter'
import { isRateLimitError } from '@/lib/retry/transient-error'
import { logger } from '@/lib/logger'
import { buildImageCropExplorationPrompt } from '@/lib/ai/prompts/ocr-figure-suffix'
import { buildImageCropResponseJsonSchema } from '@/lib/ai/schemas/ocr-image-crop-response'
import { buildSourceIdInterleavedParts, type SourceIdImage } from '@/lib/ai/clients/ocr-image-crop-parts'
import { normalizePrepared } from '@/lib/ocr/normalize-prepared'
import { callImageCropWithRetry } from '../_lib/stage-prepared-retry'
import { assemblePreparedPayload, computePreparedHash } from '../_lib/stage-prepared-payload'
import { RETRYABLE_BACKOFF_MS } from '../_lib/constants'
import { purgeOperationSourcesForOp } from '@/lib/media/source-purge'

// ②-4a Phase C Task 8b: OCR → 正規化 → stage payload orchestration action。
// spec §5.4(prepared schema SSoT)/ §2・§2.1(状態機械 + fencing)/ §9(payload
// 運用)/ §8.2(publisher との役割分担)。 T8a(lib/ocr/normalize-prepared.ts +
// lib/ocr/prepared-schema.ts)を消費するだけで再実装しない。
//
// スコープ外(brief 明記): crop(T9-10・prepared commit 後のみ)、 publish(T12)、
// operation 全体 deadline(T14・OCR_OVERALL_DEADLINE_MS 相当の wrapper はここに
// 置かない)、7 日 terminal 化(T14)。
//
// flow(brief 準拠。 R2/Gemini の外部 I/O は tx の外・fenced tx は fencing 読取
// (手順1)と stage-save/failure-persist(手順6)の 2 箇所のみ):
//   1. auth + fencing 読取(withTenantTx・短命tx・fast-fail): operation を
//      SELECT…FOR UPDATE し status='claimed' AND lease_version=leaseVersion を
//      要求。 同一 tx で source_assets を **status で絞らず全行・source_id 順**
//      で読み直し、T6 と同じ manifest 検査(件数一致・全行 ready・byte_size
//      NOT NULL)を再実行する。 検査失敗は同一 tx 内で terminal_failed を
//      確定させる(§2.1 準拠)。 これは高価な R2/Gemini 呼出**前**の安価な
//      早期棄却であり、正しさの最終保証ではない(次点参照)。
//   2. R2 GET(tx 外・外部 I/O): 各 ready source の最終 key から実バイトを取得
//      (手順1 の source_id 順のまま — Gemini に渡す画像順を決定的にする)。
//   3. Gemini call(tx 外・外部 I/O): T7 builder(prompt/schema/parts)+
//      callImageCropWithRetry(429 即停止・transient は指数 backoff・
//      incrementAiUsage を各 attempt 前に計上)。
//   4. parse + normalizePrepared(純粋・T8a)。
//   5. payload 組立 + preparedPayloadSchema.parse()(純粋・T8a 型を再利用)。
//   6. stage-save(withTenantTx・短命tx): **manifest を再度 FOR UPDATE で
//      再検証してから** fenced CAS UPDATE する(review fix Critical#1 —
//      手順1〜手順6 の間(R2/Gemini I/O ウィンドウ)にも source が消失/
//      非 ready 化しうるため、payload commit の直前・同一 tx 内で再検証しないと
//      不完全な manifest の payload を 'prepared' として確定させてしまう)。
//      manifest 崩壊 → terminal_failed。 fencing 不一致(0 行)→ stale。
//
// 失敗系統(Gemini 呼出失敗・JSON parse 不能・0 有効カード)はいずれも
// non-terminal(status='claimed' を維持・lease 解放・next_retry_at/
// attempt_count++/last_error_code を記録・spec §2)— staging しない。この
// 永続化 UPDATE も同じ fencing 条件(status='claimed' AND lease_version=?)で
// CAS するため、Gemini 呼出中に takeover が起きていれば 'stale' に落ちる
// (誤って新しい実行の状態を壊さない)。

export type StagePreparedInput = {
  operationId: string
  leaseVersion: number
}

export type StagePreparedResult =
  | { outcome: 'staged'; cardsTotal: number; cardsExcluded: number }
  // fencing 不一致(takeover 済み・status が claimed でない等)。 stage しない。
  | { outcome: 'stale' }
  // technical failure(Gemini 呼出失敗・JSON parse 不能)。 non-terminal・再 claim 可。
  | { outcome: 'retryable_failed'; reason: string }
  // OCR 自体は完了したが有効カード 0(spec §8.3 の publish 側判断と同じ扱いを
  // stage 時点にも適用 — non-terminal・再 claim 可)。 UI 向けに集計値を返す。
  | { outcome: 'empty'; cardsTotal: number; cardsExcluded: number }
  // データ不整合: claim(T6)が確定した source manifest が stage 時点で崩れている
  // (行欠落・非 ready 化・deleting 混在等 — claim/stage 間の GC/GDPR race やバグ)。
  // 消えた source は回復しないため retryable にせず terminal_failed(review fix・
  // coordinator 2026-07-31 再レビュー Critical)。
  | { outcome: 'terminal_failed'; reason: string }
  | { outcome: 'not_found' }
  | { outcome: 'unauthenticated' }

const stageInputSchema = z.object({
  operationId: z.uuid(),
  leaseVersion: z.number().int().nonnegative(),
})

// ---------------------------------------------------------------------------
// 手順1: fencing 読取 + source manifest の再検証(短命 tx・DB のみ)
//
// [Critical fix・coordinator 2026-07-31 再レビュー] claim(T6)と stage(T8b)は
// 別 tx(間に R2/Gemini の外部 I/O を挟む)であり、claim が commit した時点で
// operation 行ロックは解放される。ゆえに claim〜stage の間に source が削除・
// deleting 化しうる(GC/GDPR race・バグ)。以前の実装は `status='ready'` で
// 絞った**部分集合**を読み直すだけだったため、この race を素通しし、消えた
// source を欠いた不完全な payload を 'prepared' として確定させかねなかった
// (0 件になった時だけ弾いていた=消えたのが 1 件でも残りが 0 件でなければ通る)。
// → T6(claim-operation.ts)の spec §2.1 手順4-5 と同じ検査(status で絞らず
// 全行取得 → expected_source_count 一致 + 全行 ready + byte_size NOT NULL)を
// ここでも再実行する。 claim-operation.ts 自体は不触(検査ロジックは意図的に
// この file 内で再実装 — 既 commit・review 済の T6 file を本 task の範囲外で
// 触るリスクを避けるため。値/判定条件は T6 と完全一致させる)。
// ---------------------------------------------------------------------------

type SourceManifestRow = {
  sourceId: string
  objectKey: string
  mime: string | null
  status: 'reserved' | 'ready' | 'deleting'
  byteSize: number | null
}

// T6(claim-operation.ts)spec §2.1 手順5 と同じ 3 検査(size 合計の再検査は
// 対象外 — 出典コメント参照。 immutable な expected_source_count と実カウント
// の不一致 / 非 ready 行(deleting・reserved への逆行含む)混在 / byte_size
// NULL のいずれかで manifest 崩壊と判定する)。 loadFencedSourceManifest(早期
// fast-fail 読取)と stageSaveCas(atomic re-check・review fix Critical#2 参照)
// の両方から呼ぶ共有 helper — 2 箇所とも同一の判定でなければならないため。
function isSourceManifestValid(
  rows: readonly Pick<SourceManifestRow, 'status' | 'byteSize'>[],
  expectedSourceCount: number,
): boolean {
  return (
    rows.length === expectedSourceCount &&
    rows.every((r) => r.status === 'ready') &&
    rows.every((r) => r.byteSize !== null)
  )
}

// manifest 崩壊を terminal_failed として永続化する共有 helper。 呼出時点で
// operation 行は SELECT…FOR UPDATE によって同一 tx 内でロック保持中のため
// (claim-operation.ts の persistTerminalFailure と同じ理由)、status ガード
// 付き WHERE は不要 — id+userId のみで安全に一意行を更新できる。
async function persistManifestIncompleteTerminal(
  tx: TenantTx,
  userId: string,
  operationId: string,
  expectedSourceCount: number,
  actualCount: number,
): Promise<void> {
  await tx
    .update(uploadOperations)
    .set({
      status: 'terminal_failed',
      lastErrorCode: 'source_manifest_incomplete',
      resultSummary: {
        reason: 'source_manifest_incomplete',
        expected: expectedSourceCount,
        actual: actualCount,
      },
    })
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))
}

type FencedLoadResult =
  | { outcome: 'ok'; readySources: SourceManifestRow[] }
  | { outcome: 'stale' }
  | { outcome: 'not_found' }
  // manifest 崩壊(データ不整合)を検出し、同一 tx 内で既に terminal_failed を
  // 永続化済み(呼出元は再度 DB に触れず、そのまま outcome を返してよい)。
  | { outcome: 'terminal'; reason: string }

async function loadFencedSourceManifest(
  tx: TenantTx,
  userId: string,
  operationId: string,
  leaseVersion: number,
): Promise<FencedLoadResult> {
  const opRows = await tx
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      expectedSourceCount: uploadOperations.expectedSourceCount,
    })
    .from(uploadOperations)
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))
    .for('update')

  const op = opRows[0]
  if (!op) return { outcome: 'not_found' }
  if (op.status !== 'claimed' || op.leaseVersion !== leaseVersion) {
    return { outcome: 'stale' }
  }
  if (op.sourceDocumentId === null) {
    // T6 が claim する operation は常に source_document_id 確定済み(claim-operation.ts
    // 同様の前提)。 到達しない想定だが防御的に not_found とする。
    return { outcome: 'not_found' }
  }

  // status で絞らず全行取得(T6 spec §2.1 手順4 と同じ理由 — 欠落/deleting 混在を
  // 見逃さないため)。 この読取は fast-fail 目的の非 lock read(FOR UPDATE 無し
  // — atomic な保証は手順6の stageSaveCas が担う・review fix Critical#1 参照)
  // であり、そのまま OCR request の source 列挙にも使うため
  // **`source_id` 順**で取得する(review fix Important#2・spec §2: source 集合は
  // unordered として扱い常に source_id で決定的に処理する。 DB `id` 順にすると
  // 挿入順というアプリ的に無意味な要因で Gemini に渡す画像順が変わりうる)。
  const allRows = await tx
    .select({
      sourceId: sourceAssets.sourceId,
      objectKey: sourceAssets.objectKey,
      mime: sourceAssets.mime,
      status: sourceAssets.status,
      byteSize: sourceAssets.byteSize,
    })
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.sourceDocumentId, op.sourceDocumentId),
        eq(sourceAssets.userId, userId),
      ),
    )
    .orderBy(sourceAssets.sourceId)

  if (!isSourceManifestValid(allRows, op.expectedSourceCount)) {
    await persistManifestIncompleteTerminal(
      tx,
      userId,
      operationId,
      op.expectedSourceCount,
      allRows.length,
    )
    return { outcome: 'terminal', reason: 'source_manifest_incomplete' }
  }

  return { outcome: 'ok', readySources: allRows }
}

// ---------------------------------------------------------------------------
// 手順6: fenced CAS UPDATE(stage-save 成功 / manifest 崩壊 / non-terminal
// failure の系統)
//
// [Critical fix・coordinator 2026-07-31 再レビュー #2] 手順1(fast-fail 読取)
// の manifest 検査だけでは不十分 — R2/Gemini の外部 I/O ウィンドウ中(手順1 の
// tx が commit した後・本 UPDATE の前)にも source が削除/`deleting` 化しうる
// (T6 の「size 検査は claim と同一 tx で atomic」でなければならない Critical
// と同じ問題の系統)。ゆえに payload commit の直前、**同一 tx 内**で
// operation → source_assets の順に FOR UPDATE ロックを取り直し、manifest を
// 再検証してから初めて UPDATE する。 ロック保持中は他 tx がこれらの行を
// 書き換えられないため、この再検証〜commit の間に新たな race は起きない
// (payload commit が「有効な manifest」と atomic になる)。
// ---------------------------------------------------------------------------

type StageSaveOutcome = 'staged' | 'stale' | 'manifest_incomplete'

async function stageSaveCas(
  tx: TenantTx,
  userId: string,
  operationId: string,
  leaseVersion: number,
  preparedPayload: Record<string, unknown>,
  preparedHash: string,
): Promise<StageSaveOutcome> {
  // 1. re-fence: operation を SELECT…FOR UPDATE(lock order: operation が先・
  //    spec §2.1)。 手順1 の fast-fail 判定と同じ条件を再確認する — この間に
  //    takeover が起きていれば stale。
  const opRows = await tx
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      expectedSourceCount: uploadOperations.expectedSourceCount,
    })
    .from(uploadOperations)
    .where(and(eq(uploadOperations.id, operationId), eq(uploadOperations.userId, userId)))
    .for('update')

  const op = opRows[0]
  if (!op || op.status !== 'claimed' || op.leaseVersion !== leaseVersion) {
    return 'stale'
  }
  if (op.sourceDocumentId === null) {
    // 手順1 と同じ防御的分岐(到達しない想定)。
    return 'stale'
  }

  // 2. manifest を FOR UPDATE で再検証(lock order: source_assets が次・ID順 —
  //    spec §2.1「operation→source_document→source_assets(ID順)」に合わせ、
  //    複数 tx が同じ行集合を異なる順でロックしてデッドロックを作らないように
  //    する。 この読取は Gemini request 用ではなく検証専用のため source_id 順
  //    にする理由が無い)。 ここで FOR UPDATE ロックを取ることで、以降 commit
  //    まで他 tx(GC/GDPR 等)がこれらの行を書き換えられなくなる。
  const manifestRows = await tx
    .select({ status: sourceAssets.status, byteSize: sourceAssets.byteSize })
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.sourceDocumentId, op.sourceDocumentId),
        eq(sourceAssets.userId, userId),
      ),
    )
    .orderBy(sourceAssets.id)
    .for('update')

  if (!isSourceManifestValid(manifestRows, op.expectedSourceCount)) {
    // manifest が崩れている = この OCR 結果はもはや正しい source 集合を反映
    // していない。 payload を commit せず terminal_failed へ遷移する(手順1 と
    // 同じ理由・同じ error code)。
    await persistManifestIncompleteTerminal(
      tx,
      userId,
      operationId,
      op.expectedSourceCount,
      manifestRows.length,
    )
    return 'manifest_incomplete'
  }

  // 3. manifest 健全 — fenced stage-save UPDATE(手順1/2 で既に上と同じ条件を
  //    確認済みだが、CAS の WHERE ガード自体は defense-in-depth として維持する
  //    — claim-operation.ts の claim CAS と同じ設計判断)。
  const updated = await tx
    .update(uploadOperations)
    .set({
      status: 'prepared',
      preparedPayload,
      preparedHash,
      preparedSchemaVersion: 1,
      // review fix(canonical Minor / Codex Important): 成功遷移は「現在エラー
      // 無し・再試行予定無し」を意味するため、直前の retryable-failed 試行が
      // 残した last_error_code / next_retry_at を明示的に clear する(放置すると
      // status='prepared' の行が obsolete な失敗メタデータを持ち続ける)。
      // attempt_count は履歴として意図的に維持(触らない)。
      lastErrorCode: null,
      nextRetryAt: null,
    })
    .where(
      and(
        eq(uploadOperations.id, operationId),
        eq(uploadOperations.userId, userId),
        eq(uploadOperations.status, 'claimed'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  return updated.length > 0 ? 'staged' : 'stale'
}

async function persistNonTerminalFailureCas(
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
        eq(uploadOperations.status, 'claimed'),
        eq(uploadOperations.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: uploadOperations.id })
  return updated.length > 0
}

// non-terminal failure(retryable_failed / empty のどちらも DB 上は同じ CAS
// 更新)を永続化する。 fencing に負けた(takeover 済み)場合は stale を返し、
// この実行の失敗情報で他実行の状態を上書きしない。
async function persistNonTerminalFailure(
  userId: string,
  operationId: string,
  leaseVersion: number,
  errorCode: string,
): Promise<boolean> {
  const persisted = await withTenantTx(userId, (tx) =>
    persistNonTerminalFailureCas(tx, userId, operationId, leaseVersion, errorCode),
  )
  if (!persisted) {
    logger.warn({
      event: 'ocr.stage.persist_failure_raced',
      operationId,
      errorCode,
    })
  } else {
    logger.error({
      event: 'ocr.stage.retryable_failure',
      operationId,
      errorCode,
    })
  }
  return persisted
}

async function retryableFailure(
  userId: string,
  operationId: string,
  leaseVersion: number,
  reason: string,
): Promise<StagePreparedResult> {
  const persisted = await persistNonTerminalFailure(userId, operationId, leaseVersion, reason)
  return persisted ? { outcome: 'retryable_failed', reason } : { outcome: 'stale' }
}

async function emptyFailure(
  userId: string,
  operationId: string,
  leaseVersion: number,
  cardsTotal: number,
  cardsExcluded: number,
): Promise<StagePreparedResult> {
  const persisted = await persistNonTerminalFailure(userId, operationId, leaseVersion, 'empty_cards')
  return persisted ? { outcome: 'empty', cardsTotal, cardsExcluded } : { outcome: 'stale' }
}

// ---------------------------------------------------------------------------
// getCurrentUser() は「未認証」を UnauthenticatedError の throw で表現し、
// 「session はあるが DB に user 行がまだ無い」を null 返却で表現する
// (claim-operation.ts / prepare-upload.ts と同じ二態)。
// ---------------------------------------------------------------------------
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

export async function stagePrepared(input: StagePreparedInput): Promise<StagePreparedResult> {
  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }

  const parsed = stageInputSchema.safeParse(input)
  if (!parsed.success) return { outcome: 'not_found' }
  const { operationId, leaseVersion } = parsed.data

  // 手順1: fencing 読取 + source manifest の再検証(claim 時点の全行が今も
  // 揃って ready かを T6 と同じ検査で確認する — Critical fix 参照)。
  const loaded = await withTenantTx(user.id, (tx) =>
    loadFencedSourceManifest(tx, user.id, operationId, leaseVersion),
  )
  if (loaded.outcome === 'terminal') {
    // ②-4a Task 14b′(主経路・post-commit): loadFencedSourceManifest 内の
    // persistManifestIncompleteTerminal は自前の withTenantTx で既に commit 済
    // (fenced tx 自体は変更しない)。purge はここ(action level・tx 外)で呼ぶ。
    await purgeOperationSourcesForOp(user.id, operationId, 'stage_terminal')
    return { outcome: 'terminal_failed', reason: loaded.reason }
  }
  if (loaded.outcome !== 'ok') return { outcome: loaded.outcome }

  if (loaded.readySources.length === 0) {
    // manifest 検査(expected_source_count 一致)を通過した以上、通常は
    // 到達しない(T4 が expected_source_count>=1 を保証)— 念のための防御的
    // backstop として維持する。
    return retryableFailure(user.id, operationId, leaseVersion, 'no_ready_sources')
  }
  const missingMime = loaded.readySources.find((s) => s.mime === null)
  if (missingMime) {
    // 'ready' 行は finalize が検証済み 5 列を同時確定させるため通常起き得ない
    // (防御的分岐・claim-operation.ts の byte_size NULL チェックと同じ位置付け)。
    return retryableFailure(user.id, operationId, leaseVersion, 'source_metadata_missing')
  }
  const readySources = loaded.readySources.map((s) => ({
    sourceId: s.sourceId,
    objectKey: s.objectKey,
    mime: s.mime as string, // 直上の missingMime チェックで非 null を確認済み
  }))

  // 手順2: R2 GET(tx 外・外部 I/O)。
  const sourceImages: SourceIdImage[] = []
  for (const source of readySources) {
    const obj = await getObject(source.objectKey)
    if (obj === null) {
      return retryableFailure(user.id, operationId, leaseVersion, 'source_object_missing')
    }
    sourceImages.push({
      sourceId: source.sourceId,
      file: { mimeType: source.mime, data: obj.bytes.toString('base64') },
    })
  }

  // 手順3: Gemini call(tx 外・外部 I/O・T7 builder 一式)。
  const prompt = buildImageCropExplorationPrompt()
  const schema = buildImageCropResponseJsonSchema()
  const parts = buildSourceIdInterleavedParts(sourceImages, prompt)

  let geminiText: string
  try {
    const result = await callImageCropWithRetry(parts, schema, () => incrementAiUsage(user.id, 1))
    geminiText = result.text
  } catch (err) {
    const reason = isRateLimitError(err) ? 'gemini_rate_limited' : 'gemini_call_failed'
    return retryableFailure(user.id, operationId, leaseVersion, reason)
  }

  // 手順4: parse + normalizePrepared(純粋・T8a)。
  let rawResponse: unknown
  try {
    rawResponse = JSON.parse(geminiText)
  } catch {
    return retryableFailure(user.id, operationId, leaseVersion, 'json_parse_failed')
  }

  const validSourceIds = new Set(readySources.map((s) => s.sourceId))
  const normalized = normalizePrepared(rawResponse, validSourceIds, randomUUID)

  if (normalized.cards.length === 0) {
    // successful OCR call だが有効カード 0(raw cards 自体が 0 件・または全 card
    // が要素隔離で除外された、のいずれも同じ扱い — spec §8.3 の publish 側判断
    // 「有効カード 0 → retryable」を stage 時点にも適用する)。
    return emptyFailure(
      user.id,
      operationId,
      leaseVersion,
      normalized.cardsTotal,
      normalized.cardsExcluded,
    )
  }

  // 手順5: payload 組立 + preparedPayloadSchema.parse()。 normalize の契約
  // (T8a: 生成される全 card は preparedCardSchema を通る)により本 parse は常に
  // 成功する前提 — 失敗は「バグ」として loud に throw する(brief: a parse
  // failure here is a loud internal error, not a user error)。
  const payload = assemblePreparedPayload(normalized)
  const preparedHash = computePreparedHash(payload)

  // 手順6: fenced stage-save(withTenantTx・短命tx・manifest 再検証を内包する
  // atomic CAS — review fix Critical#1 参照)。
  const stageOutcome = await withTenantTx(user.id, (tx) =>
    stageSaveCas(tx, user.id, operationId, leaseVersion, payload, preparedHash),
  )
  if (stageOutcome === 'stale') return { outcome: 'stale' }
  if (stageOutcome === 'manifest_incomplete') {
    // ②-4a Task 14b′(主経路・post-commit): stageSaveCas 内の
    // persistManifestIncompleteTerminal も上と同じく自前の withTenantTx で commit
    // 済(fenced tx 自体は変更しない)。
    await purgeOperationSourcesForOp(user.id, operationId, 'stage_terminal')
    return { outcome: 'terminal_failed', reason: 'source_manifest_incomplete' }
  }

  return {
    outcome: 'staged',
    cardsTotal: normalized.cardsTotal,
    cardsExcluded: normalized.cardsExcluded,
  }
}
