// ②-4a Task 12 + T14a fix round 1(Codex P2): publishPreparedUpload の
// orchestration 本体(auth + payload 読取 + crop + 条件判定 + tx 呼出)。
//
// directive 無し共有 module(publish-prepared-plan.ts と同じ「'use server' file
// から参照される directive 無し共有 module」パターン)。
//
// なぜこの file に切り出したか(T14a fix round 1・Codex P2): 当初 `deadlineAt`
// (crop フェーズの time budget)を `publishPreparedUpload`(元は本体そのもの)の
// 第 2 引数として直接持たせていたが、Next.js の file-level `'use server'`
// directive は**その file の全 export を server action 化する**(client が
// import/呼出していなくても action-id 経由で reachable — 「使われていないから
// 安全」ではない)。 ゆえに crop 予算という **サーバー側の安全弁を client が
// 直接コントロールできる引数として公開してしまう**のは不可。 この関数
// (`runPublishPrepared`)は 'use server' を持たないこの file に置くことで
// action 化されず、`'use server'` file(`../_actions/publish-prepared.ts`)側の
// 単一引数 `publishPreparedUpload(input)` が deadline をサーバー側でのみ計算し
// (`new Date(Date.now() + CROP_PHASE_BUDGET_MS)`)、この関数へ渡す。
// テストはこの関数を直接 import して `deadlineAt` を注入する(公開 action の
// シグネチャを汚さずに済む)。
//
// `publishPreparedUploadTx`(fenced tx 本体)は意図的に `../_actions/publish-
// prepared.ts` に残置(T14a fix round 1 の指示「Do NOT touch
// publishPreparedUploadTx」— 内容はもちろん所在も変更しない)。 本 file から
// それを import する形になり `../_actions/publish-prepared.ts` との間に循環
// import が生じるが、双方とも `export async function` 宣言(hoisted)であり
// 実際の呼出は関数本体の中(モジュール評価完了後の実行時)でのみ発生するため
// ESM の循環 import として安全(呼出順序に依存する top-level 副作用が無い)。
// `pnpm build`(Next/Turbopack のバンドル)で検証済み。
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { sourceAssets, uploadOperations, type User } from '@/lib/db/schema'
import {
  cropFigureAndStore,
  classifyCropOutcome,
  type CropAndStoreOutcome,
} from '@/lib/media/crop-and-store'
import { preparedPayloadSchema, type PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'
import { logger } from '@/lib/logger'
import { RETRYABLE_BACKOFF_MS, CROP_MIN_REMAINING_MS } from './constants'
import { purgeOperationSources } from '@/lib/media/source-purge'
import {
  planPublish,
  buildResultSummary,
  isCropBudgetExhausted,
  type FigureDisposition,
} from './publish-prepared-plan'
import { publishPreparedUploadTx } from '../_actions/publish-prepared'

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

// ②-4a Task 14b′(主経路・post-commit): persistTerminalFailed の CAS が実際に
// このtx で terminal_failed を書き込んだ(= 'failed' を返した)場合のみ
// purgeOperationSources を呼ぶ。CAS が 'stale' を返した(lease を横取りされ何も
// 書かなかった)場合は呼ばない — この呼出の役目ではなくなった(横取りした側が
// 自分の terminal 遷移で呼ぶ)。sourceDocumentId が null(= 'source_document_deleted'
// 分岐・FK が既に SET NULL 済)は purge 対象が無いので呼ばない。fenced tx
// (persistTerminalFailedCas)自体は変更しない — purge は commit 後にここで呼ぶ
// (brief「Do NOT modify the fenced publish/claim/stage txs themselves」)。
async function persistTerminalFailedAndPurge(
  userId: string,
  operationId: string,
  leaseVersion: number,
  reason: string,
  sourceDocumentId: string | null,
): Promise<PublishPreparedResult> {
  const result = await persistTerminalFailed(userId, operationId, leaseVersion, reason)
  if (result.outcome === 'failed' && sourceDocumentId !== null) {
    await purgeOperationSources(userId, sourceDocumentId, 'publish_terminal')
  }
  return result
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
// runPublishPrepared — orchestrator 本体(auth + payload 読取 + crop + 条件判定 + tx)。
//
// `deadlineAt`(spec §11 deadline・T14a): crop フェーズ(Step B)の絶対 deadline。
// 呼出元(`publish-prepared.ts` の `publishPreparedUpload`)がサーバー側でのみ
// 計算して渡す(`new Date(Date.now() + CROP_PHASE_BUDGET_MS)`)— client からは
// 一切コントロールできない(fix round 1・Codex P2)。 テストはこの関数を直接
// import し、過去/未来の `Date` を渡すだけで決定論的に検証できる。
// ---------------------------------------------------------------------------
export async function runPublishPrepared(
  input: PublishPreparedInput,
  deadlineAt: Date,
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
    return persistTerminalFailedAndPurge(
      userId,
      operationId,
      leaseVersion,
      'source_document_deleted',
      null,
    )
  }
  const sourceDocumentId = op.sourceDocumentId

  if (op.preparedPayload === null) {
    // status='prepared' なのに payload 無し = 内部不整合(現状コード上は到達不能 —
    // stage は payload と status='prepared' を atomic に書く)。 Fix round 2(Codex
    // fix1 P2 + canonical 収束): これも sibling の corrupt/empty と同じ「恒久破損の
    // prepared op」であり、 stale 返しだと reclaim 機構(T12b prepared takeover・次
    // task)導入後に無限 reclaim に化ける forward-looking hazard。 4 分岐(null-source /
    // corrupt / empty / null-payload)を一貫して fenced terminal に揃える。 warn は
    // observability のため維持。
    logger.warn({ event: 'ocr.publish.prepared_without_payload', operationId })
    return persistTerminalFailedAndPurge(
      userId,
      operationId,
      leaseVersion,
      'prepared_without_payload',
      sourceDocumentId,
    )
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
    return persistTerminalFailedAndPurge(
      userId,
      operationId,
      leaseVersion,
      'payload_corrupt',
      sourceDocumentId,
    )
  }

  if (payload.cards.length === 0) {
    // 有効カード 0 → 恒久失敗(spec §8.3。 stage が cards≥1 を保証するため防御的)。
    // Fix #2: 同上 — fenced terminal 化(prepared のままだと再試行で無限ループ)。
    return persistTerminalFailedAndPurge(
      userId,
      operationId,
      leaseVersion,
      'empty_payload',
      sourceDocumentId,
    )
  }

  // Step B: 全 figure を crop(tx の外・R2 I/O。 spec §7.3「crop-derived asset は
  //   prepared commit 後のみ」は cropFigureAndStore 自身が status='prepared' 確認で
  //   担保。 crop は idempotent = retry/横取りで同 asset へ収束)。
  //
  // T14a(spec §11 deadline): この crop フェーズは 1 つの absolute deadline
  // (`deadlineAt`)を持つ。 各 figure の crop を試みる直前に残り予算を判定し
  // (`isCropBudgetExhausted`・純関数)、 `CROP_MIN_REMAINING_MS` を下回った時点で
  // それ以降の figure(この figure を含む)は crop を試みず `deadline_excluded`
  // として計上する(§13 reason g)。 一度枯渇したら以降のループ全体で crop を
  // 試みない(`budgetExhausted` フラグで固定 — 予算判定を figure ごとに揺り
  // 戻さない)。 card 単位ではなく全 figure を単一 flat list として扱う(disposition
  // は figure.assetId をキーに一意なため card グルーピングは不要)。 crop 全滅と
  // 同じく text card は publish する(§8.3)。
  const deadlineAtMs = deadlineAt.getTime()
  const dispositionByAssetId = new Map<string, FigureDisposition>()
  const allFigures = payload.cards.flatMap((card) => card.figures)
  let budgetExhausted = false
  for (const figure of allFigures) {
    if (
      !budgetExhausted &&
      isCropBudgetExhausted(Date.now(), deadlineAtMs, CROP_MIN_REMAINING_MS)
    ) {
      budgetExhausted = true
    }
    if (budgetExhausted) {
      dispositionByAssetId.set(figure.assetId, 'deadline_excluded')
      continue
    }
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
    txResult = await withTenantTx(userId, async (tx) => {
      // Task S-3 で `publishPreparedUploadTx` から引数化された値。旧経路の挙動を
      // 変えないため、同じ tx 内で同じ SUM を計算して渡す(source_assets.byte_size は
      // finalize 後 immutable ゆえ plain SELECT・lock 不要)。
      //
      // **fencing の前に実行される**のは意図的(canonical review M-6)。fence は
      // publishPreparedUploadTx の冒頭 `SELECT … FOR UPDATE` にあり、引数を先に
      // 評価する以上その前になる。安全な理由: ① ACCESS SHARE のみで lock 順に影響
      // しない ② finalize 後 immutable ゆえ読む時点で値が変わらない ③ 同一 tx なので
      // fence 敗北時は他の読取と一緒に rollback される。コストは「crop 中に takeover
      // された」稀な race での SELECT 1 回だけ(Step A の fenced fast-fail で弾かれる
      // 通常の stale はここまで来ない)。fence の後に移すには fenced tx へ callback を
      // 注入する間接層が要り、簡潔性規律(層を足す前にそれ無しで書けないか試す)と
      // T14a の「fenced tx 本体を触らない」指示の両方に反するため採らない。
      const sizeRows = await tx
        .select({ total: sql<number>`COALESCE(SUM(${sourceAssets.byteSize}), 0)::int` })
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.sourceDocumentId, sourceDocumentId),
            eq(sourceAssets.userId, userId),
          ),
        )
      return publishPreparedUploadTx(tx, {
        userId,
        operationId,
        leaseVersion,
        cards: payload.cards,
        cardImagesByCardId: plan.cardImagesByCardId,
        resultSummary,
        fileSizeBytes: Number(sizeRows[0]?.total ?? 0),
      })
    })
  } catch (err) {
    // 保護 UPDATE 期待未満 / 重複 card id(loud fail)/ その他 DB error は tx 全体が
    // rollback 済み(部分 commit なし)。 retryable に写像し loud に記録する
    // (silent に握らない = 重複 card id の loud fail 要件を満たす)。
    logger.error({ event: 'ocr.publish.tx_failed', operationId, err })
    return persistPublishRetry(userId, operationId, leaseVersion, 'db_error')
  }

  if (txResult.outcome === 'stale') return { outcome: 'stale' }

  // ②-4a Task 14b′(主経路・post-commit・completed): publishPreparedUploadTx が
  // 'published' を返した = tx は既に commit 済(status='completed')。fenced tx
  // 自体は変更せず、ここ(action level)で source を purge する(brief「主経路」)。
  await purgeOperationSources(userId, sourceDocumentId, 'publish_completed')

  return {
    outcome: 'published',
    cardsPublished: payload.cards.length,
    figuresAttached: plan.figuresAttached,
  }
}
