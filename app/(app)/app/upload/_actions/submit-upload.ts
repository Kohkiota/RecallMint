'use server'

import { and, eq, inArray, ne, sql } from 'drizzle-orm'

import { MAX_ASSET_BYTES } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'
import { getTodayAiUsageGlobal } from '@/lib/ai-usage-counter'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { exams, sourceDocuments, uploadOperations, type User } from '@/lib/db/schema'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { todayInJst } from '@/lib/jst'
import { logger } from '@/lib/logger'
import {
  LEASE_TTL_MS,
  TOTAL_UPLOAD_LIMIT_BYTES,
  TOTAL_UPLOAD_LIMIT_MB,
} from '../_lib/constants'
import { parseDailyLimit } from '../_lib/daily-limit'
import { sniffMagicBytes } from '../_lib/source-image-verify'
import { terminalizeAbandonedOperation } from '../_lib/terminalize-abandoned-operation'
import { type Destination } from './upload-guard'

// ②-4a 単一 invocation Sprint Task S-1(spec 2026-08-04 §2): upload の入口を
// 1 つの server action に統合する新経路の「sync phase」だけを作る。
//
// 受領した FormData のバイトは request body で 1 回だけ server に入り、この
// invocation のメモリ上でのみ扱う — source を R2 に置かない設計ゆえ、本 file は
// R2 client を import しない(unit/iso 両方で pin 済)。
//
// 本 task の範囲は「入力検証 → 1 tx(advisory lock / 冪等 replay / live-op gate /
// daily cap / op + exam + source_document 作成 + lease 発行)」まで。OCR(S-2)/
// crop・publish(S-3)は未実装で、action は tx 成立後にその場で operation を
// not_implemented として terminal 化する(UI 未接続)。

// sniffMagicBytes が判定に必要とする先頭バイト数(最長 signature = WebP の
// RIFF....WEBP = 12 バイト)。全バイトをメモリへ展開せず先頭だけを読む。
const MAGIC_BYTES_LENGTH = 12

// 非終端 operation の集合(spec §4.5)。cutover(S-5)まで旧経路
// (awaiting_sources / claimed / prepared)と新経路(processing)が併存するため
// 両方を見る — 片方しか見ないと、もう一方が実行中の upload を live と判定できず
// 二重 submit 防止が抜ける。同じ集合の直値が source-doc-status.ts /
// gc-abandoned-operations.ts / prepare-upload.ts にもある(旧経路撤去時に整理)。
const NON_TERMINAL_STATUSES = [
  'awaiting_sources',
  'claimed',
  'prepared',
  'processing',
] as const

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
      // いない)。呼出側が post-tx phase(S-1 はスタブ / S-2 以降は OCR)を
      // 実行してよいのは **false のときだけ** — transport retry のたびに Gemini を
      // 再実行しないという §4.3 の冪等契約は、この判別子でしか履行できない
      // (client 向けには accepted 一本のままで、UI 分岐は増えない)。
      replayed: boolean
    }
  | { outcome: 'in_progress' }
  | { outcome: 'daily_limit_exceeded'; current: number; limit: number }
  | { outcome: 'exam_not_found'; archived: boolean }
  | { outcome: 'invalid_input'; error: string }
  | { outcome: 'unauthenticated' }

type ValidatedSubmission =
  | { ok: true; input: SubmitUploadInput; files: SubmitUploadFileMeta[] }
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

  return {
    ok: true,
    input: { idempotencyKey, destination },
    files: files.map((f) => ({ filename: f.name, byteSize: f.size })),
  }
}

// sync phase の tx 本体。user(Pick<User,'id'>)と tx を呼出側から受け取るだけで
// Clerk 認証や withTenantTx を自前で張らない(prepare-upload.ts の prepareUploadTx
// と同型 — iso test が Clerk 無しで直接 exercise できるようにする設計)。
export async function submitUploadTx(
  tx: TenantTx,
  user: Pick<User, 'id'>,
  input: SubmitUploadInput,
  files: SubmitUploadFileMeta[],
): Promise<SubmitUploadResult> {
  // 1. user 単位 advisory xact lock(prepare-upload.ts:199-205 と同機構)。取得
  // できなければ並行 submit として弾く(xact-scoped ゆえ commit/rollback で自動解放)。
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
    }
  }

  // 3. live-operation gate + supersede(prepare-upload.ts:264-308 と同 semantics)。
  //   - 別 key の非終端 op が valid lease を持つ(= 実行中の invocation)→ in_progress。
  //   - lease NULL / 失効、または awaiting_sources(旧経路の source 待ち)→ 放棄と
  //     みなして terminalize(+ doc failed)し新規へ進む。
  // 対象行は SELECT…FOR UPDATE でロックしてから terminalize する(claim/takeover
  // との race を行ロックで直列化)。時刻裁定は PostgreSQL now() 基準。
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
        inArray(uploadOperations.status, [...NON_TERMINAL_STATUSES]),
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
    for (const c of conflicting) {
      await terminalizeAbandonedOperation(
        tx,
        user.id,
        { operationId: c.id, sourceDocumentId: c.sourceDocumentId },
        'superseded',
      )
    }
  }

  // 4. 日次 Gemini cap(claim-operation.ts:289-305 と同型・同 tx)。上限到達なら
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
    // 仮 name フォーマットは prepare-upload.ts / upload-guard.ts と揃える
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
  // 意味(= 受領枚数)は現行踏襲(prepare-upload.ts:399-402)。
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
    .returning({ id: uploadOperations.id })

  return {
    outcome: 'accepted',
    operationId: opInsert[0].id,
    examId: resolvedExamId,
    sourceDocumentId,
    replayed: false,
  }
}

// getCurrentUser() は「未認証」を UnauthenticatedError の throw で、「session は
// あるが DB に user 行がまだ無い」(webhook sync race)を null で表現する二態。
// prepare-upload.ts に同名の private helper があるが、あちらは S-5 の旧経路撤去で
// file ごと消える予定ゆえ共有 module へは切り出さない。
async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// Server Action entry point。認証 → 入力検証 → sync phase tx。
export async function submitUpload(formData: FormData): Promise<SubmitUploadResult> {
  // Server Action の引数は実行時には untrusted(TS 型は compile-time の保証のみ)。
  // FormData でない payload が渡されると validateFormData の .get() が TypeError で
  // 例外化し 500 になる — auth より前に弾いて invalid_input に落とす
  // (prepare-upload.ts:504-511 の同趣旨 guard と規律を揃える)。
  if (!(formData instanceof FormData)) {
    return { outcome: 'invalid_input', error: '入力内容が正しくありません' }
  }

  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }

  const validated = await validateFormData(formData)
  if (!validated.ok) return { outcome: 'invalid_input', error: validated.error }

  const result = await withTenantTx(user.id, (tx) =>
    submitUploadTx(tx, user, validated.input, validated.files),
  )

  // S-1 スタブ: OCR(S-2)/ crop・publish(S-3)は未実装。ここで terminal 化せずに
  // 返すと lease が生きたままの operation が残り、次の submit が最大
  // LEASE_TTL_MS(15 分)ブロックされる。S-2 でこの分岐が OCR phase に置き換わる。
  //
  // `replayed` を必ず見る: replay で返った既存 op は「この呼出が作った op」では
  // ないため、post-tx phase の対象にしてはいけない。既に completed / terminal な
  // op を terminalizeAbandonedOperation の contract(非終端 op 前提・呼出元が
  // FOR UPDATE 済み前提)に流し込むことになり、S-2 で本 phase が OCR に置き換わった
  // 瞬間 transport retry のたびに Gemini が再実行される(spec §4.3 違反)。
  // 対象 op はこの呼出が直前に作ったもので他の書き手がいないため、
  // terminalizeAbandonedOperation が前提とする行ロックは取らない。
  if (result.outcome === 'accepted' && !result.replayed) {
    await withTenantTx(user.id, (tx) =>
      terminalizeAbandonedOperation(
        tx,
        user.id,
        { operationId: result.operationId, sourceDocumentId: result.sourceDocumentId },
        'not_implemented',
      ),
    )
  }

  return result
}
