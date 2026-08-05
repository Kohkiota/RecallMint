'use server'

import { after } from 'next/server'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'

import { MAX_ASSET_BYTES } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'
import { getTodayAiUsageGlobal } from '@/lib/ai-usage-counter'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { exams, sourceDocuments, uploadOperations, type User } from '@/lib/db/schema'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import {
  NON_TERMINAL_UPLOAD_OPERATION_STATUSES,
  isLiveUploadOperationCondition,
} from '@/lib/exams/source-doc-status'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { todayInJst } from '@/lib/jst'
import { logger } from '@/lib/logger'
import {
  LEASE_TTL_MS,
  TOTAL_UPLOAD_LIMIT_BYTES,
  TOTAL_UPLOAD_LIMIT_MB,
  UPLOAD_PIPELINE_BUDGET_MS,
} from '../_lib/constants'
import { parseDailyLimit } from '../_lib/daily-limit'
import { sniffMagicBytes } from '../_lib/source-image-verify'
import { terminalizeAbandonedOperation } from '../_lib/terminalize-abandoned-operation'
import {
  absorbUploadPipelineFailure,
  runUploadPipeline,
  type UploadPipelineFile,
} from '../_lib/upload-pipeline'
import { type Destination } from './upload-guard'

// ②-4a 単一 invocation Sprint Task S-1(spec 2026-08-04 §2): upload の入口を
// 1 つの server action に統合する新経路の「sync phase」だけを作る。
//
// 受領した FormData のバイトは request body で 1 回だけ server に入り、この
// invocation のメモリ上でのみ扱う — source を R2 に置かない設計ゆえ、本 file は
// R2 client を import しない(unit/iso 両方で pin 済)。
//
// 範囲は「入力検証 → 1 tx(advisory lock / 冪等 replay / live-op gate / daily cap /
// op + exam + source_document 作成 + lease 発行)→ 応答 → `after()` で本処理
// (OCR → crop → publish・_lib/upload-pipeline.ts)」。
//
// S-4(spec 2026-08-04 §5): 本処理を `after()` に載せ、action は sync tx の直後に
// 返す。完了 / 失敗の伝達は client の poll(/api/exams/status の `docStatuses`)。
// 応答前に全 file を Buffer 化してから callback を登録するため、request / File /
// FormData は closure に入らない(応答後に読むオブジェクトを残さない)。

// sniffMagicBytes が判定に必要とする先頭バイト数(最長 signature = WebP の
// RIFF....WEBP = 12 バイト)。全バイトをメモリへ展開せず先頭だけを読む。
const MAGIC_BYTES_LENGTH = 12

export type SubmitUploadInput = {
  idempotencyKey: string
  destination: Destination
}

// submitUploadTx が使うのは「件数 / 先頭 filename / byteSize 合計」だけ。実バイトは
// OCR phase(S-2)の担当で tx には持ち込まない(tx を短く保つ)。
export type SubmitUploadFileMeta = {
  filename: string
  byteSize: number
}

export type SubmitUploadResult =
  | {
      outcome: 'accepted'
      operationId: string
      examId: string
      sourceDocumentId: string
      // true = 既存 operation を冪等 replay で返しただけ(この呼出は何も作って
      // いない)。呼出側が post-tx phase(OCR)を実行してよいのは **false のとき
      // だけ** — transport retry のたびに Gemini を再実行しないという §4.3 の
      // 冪等契約は、この判別子でしか履行できない(client 向けには accepted 一本の
      // ままで、UI 分岐は増えない)。
      replayed: boolean
    }
  | { outcome: 'in_progress' }
  | { outcome: 'daily_limit_exceeded'; current: number; limit: number }
  | { outcome: 'exam_not_found'; archived: boolean }
  | { outcome: 'invalid_input'; error: string }
  | { outcome: 'unauthenticated' }

// tx 内部の戻り型。client 向けの SubmitUploadResult と分けているのは
// `leaseVersion` のため — OCR phase の fenced CAS が必要とする値だが、client に
// 往復させない(spec §4.3: lease_version の client 往復は廃止)。ゆえに action が
// tx から直接受け取って pipeline へ渡し、戻り値からは落とす。
export type SubmitUploadTxResult =
  | (Extract<SubmitUploadResult, { outcome: 'accepted' }> & { leaseVersion: number })
  | Exclude<SubmitUploadResult, { outcome: 'accepted' }>

type ValidatedSubmission =
  | { ok: true; input: SubmitUploadInput; files: File[] }
  | { ok: false; error: string }

// 入力検証は tx より手前で完結させる(spec §2 の flow)。冪等 replay が「今回の
// 引数を見ない」契約を持つ prepareUpload と違い、新経路の同一 key は transport
// retry のみ(ユーザー再試行は client が submit ごとに新 key を発行する既存契約・
// upload-form.tsx:553-556)= 再送は必ず同じ引数を運ぶため、検証を前段に置いても
// 冪等契約と矛盾しない。
async function validateFormData(formData: FormData): Promise<ValidatedSubmission> {
  const idempotencyKey = formData.get('idempotencyKey')
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 256
  ) {
    return { ok: false, error: '入力内容が正しくありません' }
  }

  const mode = formData.get('mode')
  if (mode !== 'new' && mode !== 'existing') {
    return { ok: false, error: '投入先が指定されていません' }
  }
  let destination: Destination
  if (mode === 'existing') {
    const examId = formData.get('examId')
    if (typeof examId !== 'string' || examId.length === 0) {
      return { ok: false, error: '既存の試験が選択されていません' }
    }
    destination = { mode: 'existing', examId }
  } else {
    destination = { mode: 'new' }
  }

  const files = formData
    .getAll('files')
    .filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) {
    return { ok: false, error: 'ファイルが選択されていません' }
  }
  if (files.length > OCR_MAX_PAGES) {
    return {
      ok: false,
      error: `1 回のアップロードは合計 ${OCR_MAX_PAGES} 件までです`,
    }
  }
  // per-file 上限は合計上限より先に評価する: MAX_ASSET_BYTES(5 MiB)>
  // TOTAL_UPLOAD_LIMIT_BYTES(4MB)ゆえ順序を逆にすると、単一の過大 file が常に
  // 「合計超過」へ丸められ per-file 上限が到達不能になる。
  if (files.some((f) => f.size > MAX_ASSET_BYTES)) {
    return { ok: false, error: '1 ファイルのサイズ上限を超えています' }
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  if (totalSize > TOTAL_UPLOAD_LIMIT_BYTES) {
    return {
      ok: false,
      error: `合計サイズは ${TOTAL_UPLOAD_LIMIT_MB} MB までです。 ファイルを分けてアップロードしてください`,
    }
  }

  // 形式判定は実バイト先頭で行う(client 申告 mime は信用しない)。サイズ上限を
  // 通過した後に読むことで、上限超過の body を読み進めない。sharp decode による
  // 検証は OCR phase(S-2)の責務でここでは行わない。
  for (const file of files) {
    const head = Buffer.from(await file.slice(0, MAGIC_BYTES_LENGTH).arrayBuffer())
    if (sniffMagicBytes(head) === null) {
      return { ok: false, error: '対応していない画像形式です (PNG / JPEG / WebP のみ)' }
    }
  }

  // File のまま返す(実バイトの Buffer 化は tx 成立後・OCR phase の直前に行う —
  // 弾かれる呼出や replay で body を展開しないため)。
  return { ok: true, input: { idempotencyKey, destination }, files }
}

// sync phase の tx 本体。user(Pick<User,'id'>)と tx を呼出側から受け取るだけで
// Clerk 認証や withTenantTx を自前で張らない(iso test が Clerk 無しで直接
// exercise できるようにする設計)。
export async function submitUploadTx(
  tx: TenantTx,
  user: Pick<User, 'id'>,
  input: SubmitUploadInput,
  files: SubmitUploadFileMeta[],
): Promise<SubmitUploadTxResult> {
  // 1. user 単位 advisory xact lock。取得できなければ並行 submit として弾く
  // (xact-scoped ゆえ commit/rollback で自動解放)。
  const lockResult = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${user.id})) AS locked`,
  )
  if (!lockResult[0]?.locked) {
    return { outcome: 'in_progress' }
  }

  // 2. 冪等 replay: 同一 key の既存 operation があれば**状態不問で**その 3 ID を
  // 返す(completed / terminal_failed も同じ — 終状態の表示は client の poll が
  // 担う)。after() を再スケジュールしない = Gemini を再実行しない(spec §4.3)。
  const existingOp = await tx
    .select({
      id: uploadOperations.id,
      examId: uploadOperations.examId,
      sourceDocumentId: uploadOperations.sourceDocumentId,
      leaseVersion: uploadOperations.leaseVersion,
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
    return {
      outcome: 'accepted',
      operationId: op.id,
      examId: op.examId,
      // 本経路が作る operation は source_document_id を生成と同時に確定するため
      // 常に non-null(schema の nullable は別経路のための予約)。
      sourceDocumentId: op.sourceDocumentId ?? '',
      replayed: true,
      leaseVersion: op.leaseVersion,
    }
  }

  // 3. live-operation gate + supersede。
  //   - 別 key の非終端 op が valid lease を持つ(= 実行中の invocation)→ in_progress。
  //   - lease NULL / 失効 → 放棄とみなして terminalize(+ doc failed)し新規へ進む。
  // 行の列挙(supersede 対象の特定)には SELECT…FOR UPDATE が要るのでロックは残すが、
  // **live 判定は JS で書き直さず共有 SQL 断片に委ねる**(S-5b 追加項目 A):
  // `isLiveUploadOperationCondition()` を boolean 列として同じ文で評価させる。
  // form を隠す判定(hasLiveUploadOperation)も同じ述語を読むため、両者が drift
  // しない(= 「form は出るのに submit は拒否される」窓を構造的に作らない)。
  // 時刻裁定は述語の中の PostgreSQL now() 基準。
  const conflicting = await tx
    .select({
      id: uploadOperations.id,
      isLive: sql<boolean>`(${isLiveUploadOperationCondition()})`,
      sourceDocumentId: uploadOperations.sourceDocumentId,
    })
    .from(uploadOperations)
    .where(
      and(
        eq(uploadOperations.userId, user.id),
        ne(uploadOperations.idempotencyKey, input.idempotencyKey),
        inArray(uploadOperations.status, [...NON_TERMINAL_UPLOAD_OPERATION_STATUSES]),
      ),
    )
    .for('update')

  if (conflicting.length > 0) {
    if (conflicting.some((c) => c.isLive)) {
      return { outcome: 'in_progress' }
    }
    for (const c of conflicting) {
      await terminalizeAbandonedOperation(
        tx,
        user.id,
        { operationId: c.id, sourceDocumentId: c.sourceDocumentId },
        'superseded',
      )
    }
  }

  // 4. 日次 Gemini cap(同 tx 内で判定する)。上限到達なら
  // 行を一切作らずに返す。原子的な枠確保は非実装(spec §6.5・超過 1〜2 回は許容)。
  // guard off(limit=null)は upload-guard.ts と同じ扱い(warn で可視化して素通し)。
  const dailyLimit = parseDailyLimit(process.env.GEMINI_DAILY_LIMIT)
  if (dailyLimit === null) {
    logger.warn({
      event: 'gemini.daily_limit.disabled',
      raw: process.env.GEMINI_DAILY_LIMIT ?? null,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    })
  } else {
    const todayCount = await getTodayAiUsageGlobal(tx)
    if (todayCount >= dailyLimit) {
      return { outcome: 'daily_limit_exceeded', current: todayCount, limit: dailyLimit }
    }
  }

  // 5. exam 解決(新規 or 既存)。INSERT の前に validate する。
  const { destination } = input
  let resolvedExamId: string
  if (destination.mode === 'new') {
    // 仮 name フォーマットは upload-guard.ts と揃える
    // (JST date + HH:mm、ユーザーは後で rename 可能)。
    const today = todayInJst()
    const nowJst = new Date(Date.now() + 9 * 3600 * 1000)
    const hh = String(nowJst.getUTCHours()).padStart(2, '0')
    const mm = String(nowJst.getUTCMinutes()).padStart(2, '0')
    const inserted = await tx
      .insert(exams)
      .values({ userId: user.id, name: `アップロード ${today} ${hh}:${mm}` })
      .returning({ id: exams.id })
    resolvedExamId = inserted[0].id
  } else {
    const found = await tx
      .select({ id: exams.id, archivedAt: exams.archivedAt })
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
  }

  // 6. source_document INSERT(status='processing')。filename 合成と pages_total の
  // 意味(= 受領枚数)は旧経路から踏襲。
  const firstFile = files[0]
  const filename =
    files.length === 1
      ? firstFile.filename
      : `${firstFile.filename} ほか ${files.length - 1} 件`
  const sourceDocInsert = await tx
    .insert(sourceDocuments)
    .values({
      userId: user.id,
      examId: resolvedExamId,
      mode: destination.mode,
      fileType: 'image',
      filename,
      fileSizeBytes: files.reduce((sum, f) => sum + f.byteSize, 0),
      status: 'processing',
      pagesTotal: files.length,
    })
    .returning({ id: sourceDocuments.id })
  const sourceDocumentId = sourceDocInsert[0].id

  // 7. upload_operation INSERT(status='processing')+ lease 発行。lease は
  // 「この invocation が生存している」表明で、live-op gate が唯一の読者
  // (spec §4.3)。時刻は PG 時計基準(app 時計を混ぜない)。
  const opInsert = await tx
    .insert(uploadOperations)
    .values({
      userId: user.id,
      idempotencyKey: input.idempotencyKey,
      examId: resolvedExamId,
      sourceDocumentId,
      status: 'processing',
      leaseVersion: 0,
      attemptCount: 0,
      expectedSourceCount: files.length,
      leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_TTL_MS / 1000})`,
    })
    .returning({ id: uploadOperations.id, leaseVersion: uploadOperations.leaseVersion })

  return {
    outcome: 'accepted',
    operationId: opInsert[0].id,
    examId: resolvedExamId,
    sourceDocumentId,
    replayed: false,
    leaseVersion: opInsert[0].leaseVersion,
  }
}

// getCurrentUser() は「未認証」を UnauthenticatedError の throw で、「session は
// あるが DB に user 行がまだ無い」(webhook sync race)を null で表現する二態。
// 旧経路(prepare-upload.ts)にも同名の private helper があったが、S-5 の旧経路撤去で
// file ごと消えたため共有 module は作らない。
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// after() 境界の防波堤(best-effort 記録のみ)。**失敗クラスの分類はしない** —
// それは runUploadPipeline の責務(no-throw 契約)で、二重に持たない。ここへ来た
// 時点で「pipeline が自力で記録できなかった」ことだけが分かるので、operationId と
// 固定 errorCode だけを台帳へ載せる(PII-free: filename / バイト / カード本文は
// 入れない)。台帳書込も失敗したら log だけ残して飲む。
async function recordAfterBoundaryFailure(
  userId: string,
  operationId: string,
  err: unknown,
): Promise<void> {
  logger.error({
    event: 'upload.pipeline.after_boundary_failed',
    operationId,
    err,
  })
  try {
    await recordIntegrationFailure({
      key: 'ocr_pipeline',
      userId,
      subject: 'upload OCR pipeline after() boundary error',
      errorMessage: err instanceof Error ? err.message : String(err),
      context: { operationId, errorCode: 'after_boundary_error' },
    })
  } catch (recordErr) {
    logger.error({
      event: 'upload.pipeline.after_boundary_record_failed',
      operationId,
      err: recordErr,
    })
  }
}

// Server Action entry point。認証 → 入力検証 → sync phase tx → 即応答 +
// after() で本処理。
export async function submitUpload(formData: FormData): Promise<SubmitUploadResult> {
  // 統合 time budget の起点は **action 入口**(sync tx の消費分も予算内)。
  const startedAt = Date.now()

  // Server Action の引数は実行時には untrusted(TS 型は compile-time の保証のみ)。
  // FormData でない payload が渡されると validateFormData の .get() が TypeError で
  // 例外化し 500 になる — auth より前に弾いて invalid_input に落とす。
  if (!(formData instanceof FormData)) {
    return { outcome: 'invalid_input', error: '入力内容が正しくありません' }
  }

  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }

  const validated = await validateFormData(formData)
  if (!validated.ok) return { outcome: 'invalid_input', error: validated.error }

  const result = await withTenantTx(user.id, (tx) =>
    submitUploadTx(
      tx,
      user,
      validated.input,
      validated.files.map((f) => ({ filename: f.name, byteSize: f.size })),
    ),
  )
  if (result.outcome !== 'accepted') return result

  // 本処理(OCR → crop → publish)。`replayed` を必ず見る: replay で返った既存 op は
  // 「この呼出が作った op」ではないため対象にしてはいけない — 見ないと transport
  // retry のたびに Gemini が再実行される(spec §4.3 違反)。
  if (!result.replayed) {
    const userId = user.id
    const refs = {
      operationId: result.operationId,
      examId: result.examId,
      sourceDocumentId: result.sourceDocumentId,
    }
    const leaseVersion = result.leaseVersion
    // **応答前に**実バイトを Buffer 化する。File / FormData(request 由来の
    // オブジェクト)を after() の closure に持ち込まないため — 応答後に request の
    // stream を読む形にすると、platform が body を回収したあとの読取になる。
    // この区間も pipeline と同じ no-throw envelope に入れる: ここで throw させると
    // operation が processing + live lease・error code 無し・台帳行無しで残る。
    let files: UploadPipelineFile[] | null = null
    try {
      const materialized: UploadPipelineFile[] = []
      for (const file of validated.files) {
        materialized.push({
          buffer: Buffer.from(await file.arrayBuffer()),
          filename: file.name,
        })
      }
      files = materialized
    } catch (err) {
      await absorbUploadPipelineFailure(userId, refs, leaseVersion, err)
    }
    if (files !== null) {
      const pipelineFiles = files
      // 統合予算の起点は action 入口(sync tx の消費分も予算内)。after() の実行時間
      // 上限は route の maxDuration に従う(追加枠なし)ため、予算の意味は不変。
      const deadlineAt = new Date(startedAt + UPLOAD_PIPELINE_BUDGET_MS)
      try {
        after(async () => {
          try {
            await runUploadPipeline(
              userId,
              refs,
              leaseVersion,
              pipelineFiles,
              deadlineAt,
            )
          } catch (err) {
            // **防波堤(分類はしない)**: runUploadPipeline は no-throw 契約
            // (spec §4.4 の 5 クラスを自前で分類・terminal 化・台帳記録する)。
            // ここへ来る = その契約が破れたか、pipeline 自身の failure-handler が
            // 落ちたか。どちらも「どのクラスか」を境界からは判定できないので、
            // best-effort の記録だけをして飲む(after() の外へ throw を出さない)。
            await recordAfterBoundaryFailure(userId, refs.operationId, err)
          }
        })
      } catch (err) {
        // **防波堤のもう半分**: after() の**登録**が失敗した場合。callback が一度も
        // 走らない = pipeline 内部の catch も境界の catch も発火しないため、spec
        // §4.4 の (a)〜(e) いずれにも属さない穴になる(lease が切れるまで
        // 「処理中」に見え続ける)。同期側の terminal 化がこのクラスの唯一の検出
        // 経路なので、ここだけは pipeline と同じ envelope へ倒す。
        await absorbUploadPipelineFailure(userId, refs, leaseVersion, err)
      }
    }
  }

  // client へは lease_version を出さない(spec §4.3: client 往復の廃止)。tx の
  // 戻り値をそのまま返すと構造的部分型で leaseVersion が response に載るため、
  // 明示的に組み直す。
  return {
    outcome: 'accepted',
    operationId: result.operationId,
    examId: result.examId,
    sourceDocumentId: result.sourceDocumentId,
    replayed: result.replayed,
  }
}
