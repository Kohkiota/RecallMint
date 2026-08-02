'use server'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import {
  exams,
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  type User,
} from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { STALE_PROCESSING_MS } from '@/lib/exams/derive-exam-statuses'
import { TOTAL_UPLOAD_LIMIT_BYTES } from '../_lib/constants'
import { type Destination } from './upload-guard'
import { MAX_ASSET_BYTES, MAX_IMAGE_DIMENSION } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'
import { terminalizeAbandonedOperation } from '../_lib/terminalize-abandoned-operation'

// ②-4a Phase B Task 4 (2026-07-31 改訂): prepareUpload — client 事前 PUT の循環依存を
// 解消するエントリーポイント(spec §1 flow / §3)。client はまだファイルの実バイトを
// どこにも送っていない段階で呼ぶため、この関数は「予約」だけを行う:
// operation(status='awaiting_sources') + exam(new/existing) + source_document
// (status='processing') + source_asset(status='reserved', temp object_key, lean 列のみ)
// を 1 tx で作成し、client が続く presigned PUT(T5)に使う object_key 群を返す。
//
// R2 への実 I/O(presigned URL 発行・実バイト検証・content_hash 算出・最終 key への
// promote)は T5 の責務。本関数は DB-only。
//
// 改訂(2026-07-31・OT 確定・spec §3): 旧 runUploadGuardTx が担っていた「同時 1 upload
// 制限」を prepareUpload 側で再構築する(旧版は意図的に移植しなかったが、その後
// 同時制御と冪等契約が未配線のままだったことが判明し OT 指示で本改訂に追加)。
// 日次 Gemini cap は T6 claim 直前判定(spec §3)であり本 task の対象外。
//
// review fix(canonical+Codex, commit 前): 未認証分岐の到達不能化 / 未検証入力での
// reduce 実行 / source 件数無制限 / live-op gate の claimed・prepared 系統・TTL 失効
// 系統が未検証 / 冪等再送時の reserved 順序が非決定的 / MAX_ASSET_BYTES 3 箇所目
// private コピー、の 6 点を修正(詳細は task-4-revised-report.md 追記分)。

// MAX_ASSET_BYTES / MAX_IMAGE_DIMENSION: asset-actions.ts の reserveInputSchema と
// 同値を ./asset-limits(directive 無し共有 module)から import する(rule of three
// — asset-actions.ts / lib/media/upload.ts に続く private コピーを作らない)。

// 1 回の upload で受け付ける source 数上限。既存 OCR_MAX_PAGES(lib/ai/ocr-limits.ts
// = 40、process.ts の旧 flow で「1 回の upload の合計ページ数上限」として使われて
// いる値)を再利用する — ②-4a は画像専用で source 1 件 = page 1 件(本関数の
// source_document.pagesTotal も sources.length をそのまま使う)ため意味が完全に
// 一致する。review fix: 上限が無いと 1 回の呼出で無制限件数の INSERT が tx 内で
// 逐次実行されうる(review Important #3)。
const MAX_SOURCES_PER_UPLOAD = OCR_MAX_PAGES

const idempotencyKeySchema = z.string().min(1).max(256)

const destinationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new') }),
  z.object({ mode: z.literal('existing'), examId: z.uuid() }),
])

const sourceItemSchema = z.object({
  sourceId: z.string().min(1).max(256),
  mime: z.enum(['image/webp', 'image/png', 'image/jpeg']),
  byteSize: z.number().int().positive().max(MAX_ASSET_BYTES),
  width: z.number().int().positive().max(MAX_IMAGE_DIMENSION),
  height: z.number().int().positive().max(MAX_IMAGE_DIMENSION),
  filename: z.string().min(1).max(256),
})

// source_id は 1 回の呼出内で source_document 内 unique(spec §5.2)。DB の
// UNIQUE(source_document_id, source_id) を最終防衛線にしつつ、書込前に明示 reject
// する(§6.1 改訂: 重複は bad-input error、silent に握り潰さない)。
const sourcesSchema = z
  .array(sourceItemSchema)
  .min(1, { message: 'ソースファイルが指定されていません' })
  .max(MAX_SOURCES_PER_UPLOAD, {
    message: `1 回のアップロードは合計 ${MAX_SOURCES_PER_UPLOAD} 件までです`,
  })
  .superRefine((sources, ctx) => {
    const seen = new Set<string>()
    for (const source of sources) {
      if (seen.has(source.sourceId)) {
        ctx.addIssue({
          code: 'custom',
          message: `source_id が重複しています: ${source.sourceId}`,
        })
      }
      seen.add(source.sourceId)
    }
  })

export type PrepareUploadSourceInput = {
  sourceId: string
  mime: string
  byteSize: number
  width: number
  height: number
  filename: string
}

export type PrepareUploadInput = {
  idempotencyKey: string
  destination: Destination
  sources: PrepareUploadSourceInput[]
}

export type ReservedSource = {
  sourceId: string
  assetId: string
  objectKey: string
}

export type PrepareUploadResult =
  | {
      outcome: 'success'
      operationId: string
      examId: string
      examName: string
      sourceDocumentId: string
      reserved: ReservedSource[]
    }
  | { outcome: 'exam_not_found'; archived: boolean }
  | { outcome: 'in_progress' }
  | { outcome: 'size_exceeded'; current: number; limit: number }
  | { outcome: 'invalid_input'; error: string }
  | { outcome: 'unauthenticated' }

// review fix #C(#A の regression): idempotent 再送パス・新規作成パスの両方が
// 「同一 operation は常に同一の reserved 配列を返す」契約を守るには、両パスが
// 全く同じ順序で結果を返す必要がある。JS 側 `.sort()`(UTF-16 code-unit 順)と
// DB の `ORDER BY sourceAssets.sourceId`(DB 設定 collation 順)は非 ASCII
// source_id では一致する保証が無い — 両パスを DB の `ORDER BY` 1 本に統一する
// ことで、charset/collation に関わらず必ず同じクエリ結果(= 同じ順序)を返す。
async function selectReservedSources(
  tx: TenantTx,
  userId: string,
  sourceDocumentId: string,
): Promise<ReservedSource[]> {
  return tx
    .select({
      sourceId: sourceAssets.sourceId,
      assetId: sourceAssets.id,
      objectKey: sourceAssets.objectKey,
    })
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.userId, userId),
        eq(sourceAssets.sourceDocumentId, sourceDocumentId),
      ),
    )
    .orderBy(sourceAssets.sourceId)
}

// tx 本体。 user (Pick<User,'id'>) と tx を呼出側から受け取るだけで、Clerk 認証や
// withTenantTx を自前で張らない (upload-guard.ts の runUploadGuardTx と同型 — iso
// test が Clerk なしで直接 exercise できるようにする設計)。
export async function prepareUploadTx(
  tx: TenantTx,
  user: Pick<User, 'id'>,
  input: PrepareUploadInput,
): Promise<PrepareUploadResult> {
  // 0. idempotencyKey は idempotency lookup の検索 key そのものなので、lock を
  // 取る前・DB を触る前に形だけ検証する(review fix #2 手順 a)。sources/destination
  // の検証はここではまだ行わない — idempotent 再送(手順 2)が「今回の引数を見ない」
  // 契約を守るため、それらの検証は「新規 operation 経路」に入ってから行う。
  const idempotencyKeyParsed = idempotencyKeySchema.safeParse(input.idempotencyKey)
  if (!idempotencyKeyParsed.success) {
    return {
      outcome: 'invalid_input',
      error: idempotencyKeyParsed.error.issues[0]?.message ?? '入力内容が正しくありません',
    }
  }

  // 1. user 単位 advisory xact lock(spec §3 手順 1)。取得できなければ並行 prepare
  // として弾く(xact-scoped ゆえ commit/rollback で自動解放、明示解放不要)。
  // upload-guard.ts:61-67 の runUploadGuardTx と同じ機構をここに移植する。
  const lockResult = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${user.id})) AS locked`,
  )
  const locked = lockResult[0]?.locked
  if (!locked) {
    return { outcome: 'in_progress' }
  }

  // 2. idempotency(spec §3 手順 2 / §2 冪等契約): 同一 key の既存 operation が
  // あれば、今回の引数が異なっていても新規化・エラー化せず「最初に作られた
  // operation」をそのまま返す。sources/destination の検証はまだ行わない
  // (= 2 回目の引数の妥当性そのものを見ない)。
  const existingOp = await tx
    .select({
      id: uploadOperations.id,
      examId: uploadOperations.examId,
      sourceDocumentId: uploadOperations.sourceDocumentId,
    })
    .from(uploadOperations)
    .where(
      and(
        eq(uploadOperations.userId, user.id),
        eq(uploadOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1)

  if (existingOp.length > 0) {
    const op = existingOp[0]
    const examRow = await tx
      .select({ name: exams.name })
      .from(exams)
      .where(and(eq(exams.id, op.examId), eq(exams.userId, user.id)))
      .limit(1)
    // review fix #5 / #C: 順序は selectReservedSources の DB ORDER BY に一本化
    // (新規作成パスと同一クエリ・同一 collation で決定的に一致させる)。
    const reservedRows = op.sourceDocumentId
      ? await selectReservedSources(tx, user.id, op.sourceDocumentId)
      : []
    return {
      outcome: 'success',
      operationId: op.id,
      examId: op.examId,
      examName: examRow[0]?.name ?? '',
      // T4 の生成経路では source_document_id は生成と同時に確定するため常に non-null
      // (schema の nullable は将来の別経路のための予約)。
      sourceDocumentId: op.sourceDocumentId ?? '',
      reserved: reservedRows,
    }
  }

  // 3. live-operation gate + supersede(spec §3 手順 3・②-4a-cutover 案 D 2026-08-02
  // OT 確定)。別 key の非終端 operation を分類する:
  //   - claimed/prepared かつ valid lease(= 実行中の worker)→ in_progress で
  //     ブロック(最大 LEASE_TTL_MS の保護・実行中を clobber しない)。
  //   - awaiting_sources(経過時間問わず)、または claimed/prepared かつ lease
  //     NULL/期限切れ → 旧 submit の放棄とみなし terminalize(+ doc failed)して
  //     新 operation へ進む(1 submit = 1 operation・resume はしない — 案 D)。
  //   - completed/terminal は非 live ゆえ対象外(select で除外・触らない)。
  // 対象行は SELECT…FOR UPDATE でロックしてから terminalize する(claim/takeover
  // との race を行ロックで直列化 — user advisory lock は prepare 同士のみ直列化する)。
  // 時刻裁定は PostgreSQL now() 基準(claim-operation.ts と同規律・spec §2.1)。
  const conflicting = await tx
    .select({
      id: uploadOperations.id,
      status: uploadOperations.status,
      leaseExpiresAt: uploadOperations.leaseExpiresAt,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      dbNow: sql<string>`now()`,
    })
    .from(uploadOperations)
    .where(
      and(
        eq(uploadOperations.userId, user.id),
        ne(uploadOperations.idempotencyKey, input.idempotencyKey),
        inArray(uploadOperations.status, ['awaiting_sources', 'claimed', 'prepared']),
      ),
    )
    .for('update')

  if (conflicting.length > 0) {
    const dbNow = new Date(conflicting[0].dbNow)
    const hasActiveWorker = conflicting.some(
      (c) =>
        c.status !== 'awaiting_sources' &&
        c.leaseExpiresAt !== null &&
        c.leaseExpiresAt.getTime() >= dbNow.getTime(),
    )
    if (hasActiveWorker) {
      return { outcome: 'in_progress' }
    }
    // 実行中 worker 不在 → 非終端 op を全て supersede(terminalize + doc failed)。
    for (const c of conflicting) {
      await terminalizeAbandonedOperation(
        tx,
        user.id,
        { operationId: c.id, sourceDocumentId: c.sourceDocumentId },
        'superseded',
      )
    }
  }

  // review fix #D(Critical・cross-flow coexistence): legacy runUploadGuardTx flow
  // は upload_operations 行を作らず source_documents(status='processing') だけで
  // in-flight を表すため、upload_operations だけを見る上の liveOps では legacy
  // 実行中のアップロードを検出できない — 一時的な両立ガード(legacy flow
  // (runUploadGuardTx) 削除後 = T16 UI 切替後に除去可能)。
  const legacyStaleThreshold = new Date(Date.now() - STALE_PROCESSING_MS)
  const legacyInFlight = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.userId, user.id),
        eq(sourceDocuments.status, 'processing'),
        gte(sourceDocuments.createdAt, legacyStaleThreshold),
      ),
    )
    .limit(1)
  if (legacyInFlight.length > 0) {
    return { outcome: 'in_progress' }
  }

  // 4. 入力検証(新規 operation 経路のみ、review fix #2 手順 c)。destination /
  // sources を size reduce や INSERT より前に完全検証する — 未検証の
  // input.sources を読む箇所(reduce・[0] アクセス等)がこれより前に存在しない
  // ことが不変条件(review Important #2)。
  const destinationParsed = destinationSchema.safeParse(input.destination)
  if (!destinationParsed.success) {
    return {
      outcome: 'invalid_input',
      error: destinationParsed.error.issues[0]?.message ?? '入力内容が正しくありません',
    }
  }
  const destination = destinationParsed.data

  const sourcesParsed = sourcesSchema.safeParse(input.sources)
  if (!sourcesParsed.success) {
    return {
      outcome: 'invalid_input',
      error: sourcesParsed.error.issues[0]?.message ?? '入力内容が正しくありません',
    }
  }
  const sources = sourcesParsed.data

  // 5. 全体サイズ上限の早期検査(client 申告合計、spec §3・T4 制約)。server 実測
  // での再検査は T6(claim 直前)の責務、ここでは検証済 sources の申告値のみで弾く。
  const declaredTotalSize = sources.reduce((sum, s) => sum + s.byteSize, 0)
  if (declaredTotalSize > TOTAL_UPLOAD_LIMIT_BYTES) {
    return {
      outcome: 'size_exceeded',
      current: declaredTotalSize,
      limit: TOTAL_UPLOAD_LIMIT_BYTES,
    }
  }

  // 6. exam 解決(新規 or 既存)。INSERT の前に validate する(失敗時は何も書かない
  // — upload-guard.ts:126-158 と同じ順序方針)。
  let resolvedExamId: string
  let resolvedExamName: string
  if (destination.mode === 'new') {
    // 仮 name フォーマットは upload-guard.ts の runUploadGuardTx と揃える
    // (JST date + HH:mm、ユーザーは後で rename 可能)。
    const today = todayInJst()
    const nowJst = new Date(Date.now() + 9 * 3600 * 1000)
    const hh = String(nowJst.getUTCHours()).padStart(2, '0')
    const mm = String(nowJst.getUTCMinutes()).padStart(2, '0')
    resolvedExamName = `アップロード ${today} ${hh}:${mm}`
    const inserted = await tx
      .insert(exams)
      .values({ userId: user.id, name: resolvedExamName })
      .returning({ id: exams.id })
    resolvedExamId = inserted[0].id
  } else {
    const found = await tx
      .select({ id: exams.id, name: exams.name, archivedAt: exams.archivedAt })
      .from(exams)
      .where(and(eq(exams.id, destination.examId), eq(exams.userId, user.id)))
      .limit(1)
    if (found.length === 0) {
      return { outcome: 'exam_not_found', archived: false }
    }
    if (found[0].archivedAt !== null) {
      return { outcome: 'exam_not_found', archived: true }
    }
    resolvedExamId = found[0].id
    resolvedExamName = found[0].name
  }

  // 7. source_document INSERT(status='processing')
  const firstSource = sources[0]
  const filename =
    sources.length === 1
      ? firstSource.filename
      : `${firstSource.filename} ほか ${sources.length - 1} 件`
  const sourceDocInsert = await tx
    .insert(sourceDocuments)
    .values({
      userId: user.id,
      examId: resolvedExamId,
      mode: destination.mode,
      fileType: 'image',
      filename,
      fileSizeBytes: declaredTotalSize,
      status: 'processing',
      pagesTotal: sources.length,
    })
    .returning({ id: sourceDocuments.id })
  const sourceDocumentId = sourceDocInsert[0].id

  // 8. upload_operation INSERT(status='awaiting_sources')。prepared_payload /
  // result_summary / prepared_hash 等は後続 task(claim/prepare/publish)が
  // 埋めるため null のまま。expectedSourceCount = 検証済 sources 件数(T6 fencing
  // checkpoint 裁定・spec §2/§2.1: claim(T6)の source 集合検証が使う immutable
  // manifest oracle。ここで一度確定させ、以降は不変)。
  const opInsert = await tx
    .insert(uploadOperations)
    .values({
      userId: user.id,
      idempotencyKey: input.idempotencyKey,
      examId: resolvedExamId,
      sourceDocumentId,
      status: 'awaiting_sources',
      leaseVersion: 0,
      attemptCount: 0,
      expectedSourceCount: sources.length,
    })
    .returning({ id: uploadOperations.id })
  const operationId = opInsert[0].id

  // 9. source ごとに lean な source_assets reservation 行を作る(spec §6.1 改訂:
  // 検証済み 5 列は書かない — mime/content_hash/byte_size/width/height は NULL の
  // まま、T5 finalize が実バイト検証後に条件付き UPDATE で確定する)。object_key は
  // temp key(最終 immutable key は T5 finalize/promote で確定)。
  for (const source of sources) {
    const assetId = randomUUID()
    const objectKey = `users/${user.id}/src/tmp/${assetId}`
    await tx.insert(sourceAssets).values({
      id: assetId,
      userId: user.id,
      sourceDocumentId,
      sourceId: source.sourceId,
      objectKey,
      status: 'reserved',
      sourceKind: 'image',
      originalFilename: source.filename,
    })
  }

  // review fix #C(#A の regression): reserved は INSERT 後に selectReservedSources
  // で DB から再取得する(JS 側で in-memory に組み立てて `.sort()` しない)。
  // idempotent 再送パスと全く同じ ORDER BY クエリを通すことで、charset/collation
  // に関わらず両パスが必ず同じ順序を返すことを保証する。
  const reserved = await selectReservedSources(tx, user.id, sourceDocumentId)

  return {
    outcome: 'success',
    operationId,
    examId: resolvedExamId,
    examName: resolvedExamName,
    sourceDocumentId,
    reserved,
  }
}

// getCurrentUser() は「未認証」(Clerk session 無し)を UnauthenticatedError の
// throw で表現し、「session はあるが DB に user 行がまだ無い」(webhook sync race)
// を null 返却で表現する(asset-actions.ts の currentUserOrNull() と同じ二態)。
// review fix #1: 旧実装は throw を catch せず、未認証リクエストが
// { outcome: 'unauthenticated' } でなく reject で終わっていた(到達不能分岐)。
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// Server Action entry point。 Clerk 認証 + tenant tx を張って prepareUploadTx を呼ぶ
// だけの薄い wrapper (process.ts の processUpload/_processUpload と同型)。
// 入力検証は prepareUploadTx 内(冪等チェックの後段)に一本化しているため、ここでは
// 事前検証を行わない — 二重実装を避け、冪等契約(§2: 引数の妥当性を問わず既存
// operation を返す)を単一箇所で担保する。
export async function prepareUpload(
  input: PrepareUploadInput,
): Promise<PrepareUploadResult> {
  // review fix #B: Server Action の引数は実行時には untrusted(TS 型は
  // compile-time の保証のみ)。null/非オブジェクトが渡されると、この後の
  // dereference(currentUserOrNull() は素通りするが、prepareUploadTx 冒頭の
  // `input.idempotencyKey` 参照)が TypeError で例外化してしまう。auth() を
  // 呼ぶより前に弾くことで、Clerk mock 無しでもこの分岐だけを直接検証できる。
  if (typeof input !== 'object' || input === null) {
    return { outcome: 'invalid_input', error: '入力内容が正しくありません' }
  }

  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }

  return withTenantTx(user.id, (tx) => prepareUploadTx(tx, user, input))
}
