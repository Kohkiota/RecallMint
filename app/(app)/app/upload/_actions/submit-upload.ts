'use server'

import { after } from 'next/server'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'

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
import { sourcePdfObjectKey } from '@/lib/media/source-object-key'
import { headObject } from '@/lib/storage/r2'
import {
  LEASE_TTL_MS,
  MAX_PDF_BYTES,
  MAX_PDF_TOTAL_BYTES,
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
  type UploadPipelineSourceOrderEntry,
} from '../_lib/upload-pipeline'
import { type Destination } from './upload-guard'

// ②-4a 単一 invocation Sprint Task S-1(spec 2026-08-04 §2): upload の入口を
// 1 つの server action に統合する新経路の「sync phase」だけを作る。
//
// 受領した FormData のバイトは request body で 1 回だけ server に入り、この
// invocation のメモリ上でのみ扱う。
//
// 範囲は「入力検証 → 1 tx(advisory lock / 冪等 replay / live-op gate / daily cap /
// op + exam + source_document 作成 + lease 発行)→ 応答 → `after()` で本処理
// (OCR → crop → publish・_lib/upload-pipeline.ts)」。
//
// S-4(spec 2026-08-04 §5): 本処理を `after()` に載せ、action は sync tx の直後に
// 返す。完了 / 失敗の伝達は client の poll(/api/exams/status の `docStatuses`)。
// 応答前に全 file を Buffer 化してから callback を登録するため、request / File /
// FormData は closure に入らない(応答後に読むオブジェクトを残さない)。
//
// ②-4b T7(spec §3.4 / D6 / D7): PDF は R2 直 PUT 済(orderManifest がメタのみを
// 運ぶ)。本 file が R2 に触れるのは `headObject`(pre-tx の実在 + サイズ検証)
// **だけ**(unit/iso で pin 済・submit-upload.test.ts)。R2 への PUT/GET/DELETE は
// 行わない — それは reserve/finalize action(T5)と pipeline count/render phase
// (T8)の責務。

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

// ②-4b T7(spec §3.4): orderManifest の PDF entry から抽出した echo メタデータ。
// PDF 本体バイトは R2 直 PUT 済でこの tx には存在しない — ここにあるのは
// client echo(fileId/filename/pageCount/declaredBytes)のみ。pageCount は
// **client echo であり信用しない**(spec D6: 正本は T8 の pipeline count phase)。
export type SubmitUploadPdfMeta = {
  fileId: string
  filename: string
  pageCount: number
  declaredBytes: number
}

// orderManifest の wire 形状(spec §3.4)。zod strict 検証 + 完全性チェック
// (Codex I6: fileId 重複禁止 / image fileIndex の全単射 / 空 manifest 拒否)は
// validateFormData 内で行う — ここは形状のみを定義する。
const orderManifestImageEntrySchema = z
  .object({
    kind: z.literal('image'),
    fileIndex: z.number().int().nonnegative(),
  })
  .strict()
const orderManifestPdfEntrySchema = z
  .object({
    kind: z.literal('pdf'),
    fileId: z.uuid({ version: 'v4' }),
    filename: z.string().min(1),
    // 正当な PDF は必ず 1 ページ以上(spec D7 r4)。0/負値 echo で層 2 判定を
    // 素通りさせない。
    pageCount: z.number().int().min(1),
    declaredBytes: z.number().int().positive().max(MAX_PDF_BYTES),
  })
  .strict()
const orderManifestEntrySchema = z.discriminatedUnion('kind', [
  orderManifestImageEntrySchema,
  orderManifestPdfEntrySchema,
])
// 空 manifest 拒否(Codex I6)。件数上限は fix round 2(Codex Important)で追加、
// 本コメントは fix round 3 で訂正(旧文言は「上限が無いと headObject fan-out の
// 増幅ベクタになる」と書いていたが、それは層 2 を HEAD より前へ移した後は成立
// しない主張だった — [[lesson_single_point_claims_decay]])。
//
// image entry 数 = FormData `files` 件数(下の全単射検証で強制・各 1 ページ寄与)/
// PDF entry は pageCount ≥ 1(各 ≥1 ページ寄与)ゆえ、**entry 数 ≤ 合計ページ数**が
// 常に成立する。よって entry 数 > OCR_MAX_PAGES は合計ページも必ず超過しており、
// headObject を 1 度も呼ばない層 2(下記・HEAD より前)が独立に却下する — fan-out を
// 実際に閉じているのは層 2 の順序であって、この `.max()` 単体ではない。
//
// それでもここに上限を課すのは、reserve-pdf-upload.ts:51 と同じ「後段判定の早期
// 棄却としての入力検証」(冊数そのものの商品上限ではない): schema 境界で早期に弾く
// ことで、attacker 制御の N に対する後続の JS 配列処理(全単射検証・fileId dedup・
// Σ declaredBytes)自体を走らせずに済む(到達可能な入力への defense-in-depth)。
const orderManifestSchema = z.array(orderManifestEntrySchema).min(1).max(OCR_MAX_PAGES)
type OrderManifestEntry = z.infer<typeof orderManifestEntrySchema>
type OrderManifestPdfEntry = Extract<OrderManifestEntry, { kind: 'pdf' }>

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
  | { outcome: 'exam_not_found' }
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
  | {
      ok: true
      input: SubmitUploadInput
      files: File[]
      // ②-4b T7: PDF 経路の echo manifest(空配列 = 画像のみ・後方互換)。
      pdfFiles: SubmitUploadPdfMeta[]
      // T8 が R2 key を導出するのに要る(spec §13 r5 表)。PDF が 1 件も無い
      // (= orderManifest 自体を送らない)経路では常に null。
      uploadSessionId: string | null
      // ②-4b T7 fix round 1(canonical Critical): `files`/`pdfFiles` へ分岐する
      // 前の manifest 順そのままの写し(spec §2「manifest 順で合流」/ D3「Gemini
      // parts 順 = 選択順を維持」)。`files`/`pdfFiles` は kind で filter した
      // disjoint な 2 配列で、元の interleave 順を復元する手段を持たないため、
      // filter する前にこの配列へ写して境界の向こう(T8)へ渡す。画像のみ経路
      // (legacy)は空配列でよい(選択順 = FormData `files` 到着順のまま)。
      sourceOrder: UploadPipelineSourceOrderEntry[]
    }
  | { ok: false; error: string }

// 入力検証は tx より手前で完結させる(spec §2 の flow)。冪等 replay が「今回の
// 引数を見ない」契約を持つ prepareUpload と違い、新経路の同一 key は transport
// retry のみ(ユーザー再試行は client が submit ごとに新 key を発行する既存契約・
// upload-form.tsx:553-556)= 再送は必ず同じ引数を運ぶため、検証を前段に置いても
// 冪等契約と矛盾しない。
//
// ②-4b T7(spec §3.4): `orderManifest` の有無で二分岐する。
//   - 無ければ**従来の画像のみ経路**(後方互換・挙動不変)— 以下のブロックは
//     PDF 対応前と一字一句同じ順序・同じ判定を保つ(既存 unit/iso pin を壊さない)。
//   - あれば PDF 経路(D3 混在可)。画像側の基準(per-file / 合計サイズ /
//     magic bytes)は同じ内容を別ブロックで適用し(画像 entry が 0 件の
//     PDF-only 提出もあるため、`files.length === 0` の早期 reject はしない)、
//     manifest 固有の検証(zod strict → 完全性 → Σ バイト → HEAD → 層 2)を
//     spec §3.4/D6/D7 の順で行う。
async function validateFormData(
  formData: FormData,
  userId: string,
): Promise<ValidatedSubmission> {
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

  const rawOrderManifest = formData.get('orderManifest')

  if (typeof rawOrderManifest !== 'string') {
    // ---- 従来の画像のみ経路(後方互換・挙動不変) ----
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
    return {
      ok: true,
      input: { idempotencyKey, destination },
      files,
      pdfFiles: [],
      uploadSessionId: null,
      sourceOrder: [],
    }
  }

  // ---- PDF 経路(spec D3/D6/D7) ----
  // 画像側の基準は画像のみ経路と同じ内容を同じ順序で適用する(PDF-only 提出では
  // files=[] のため各チェックは自明に通過する)。
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
  for (const file of files) {
    const head = Buffer.from(await file.slice(0, MAGIC_BYTES_LENGTH).arrayBuffer())
    if (sniffMagicBytes(head) === null) {
      return { ok: false, error: '対応していない画像形式です (PNG / JPEG / WebP のみ)' }
    }
  }

  // manifest zod strict 検証(Codex I6・形状のみ。完全性は下で別途確認する)。
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(rawOrderManifest)
  } catch {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const parsedManifest = orderManifestSchema.safeParse(manifestJson)
  if (!parsedManifest.success) {
    return { ok: false, error: '入力内容が正しくありません' }
  }
  const manifestEntries = parsedManifest.data

  // ②-4b T7 fix round 1(canonical Critical): manifest 順の写しは **filter する
  // 前**の `manifestEntries` から直接作る(filter 後の `imageEntries`/
  // `pdfEntries` から組み立てると interleave 順が失われる — それ自体が今回の
  // 指摘の欠陥だった)。zod の `z.array()` は要素順を保持するため、JSON 配列の
  // 到着順(= client の選択順)がそのまま残っている。
  const sourceOrder: UploadPipelineSourceOrderEntry[] = manifestEntries.map((e) =>
    e.kind === 'image' ? { kind: 'image', fileIndex: e.fileIndex } : { kind: 'pdf', fileId: e.fileId },
  )

  const imageEntries = manifestEntries.filter(
    (e): e is Extract<OrderManifestEntry, { kind: 'image' }> => e.kind === 'image',
  )
  const pdfEntries = manifestEntries.filter(
    (e): e is OrderManifestPdfEntry => e.kind === 'pdf',
  )

  // 完全性①(Codex I6): image の fileIndex は FormData `files` と過不足ない
  // 全単射(重複・欠番・範囲外を拒否)。3 条件(件数一致・重複なし・範囲内)が
  // 揃って初めて {0,…,files.length-1} に一致する。
  const fileIndices = imageEntries.map((e) => e.fileIndex)
  const isBijective =
    fileIndices.length === files.length &&
    new Set(fileIndices).size === fileIndices.length &&
    fileIndices.every((i) => i >= 0 && i < files.length)
  if (!isBijective) {
    return { ok: false, error: '入力内容が正しくありません' }
  }

  // 完全性②(Codex I6): PDF fileId 重複禁止。
  const pdfFileIds = pdfEntries.map((e) => e.fileId)
  if (new Set(pdfFileIds).size !== pdfFileIds.length) {
    return { ok: false, error: '入力内容が正しくありません' }
  }

  const pdfFiles: SubmitUploadPdfMeta[] = pdfEntries.map((e) => ({
    fileId: e.fileId,
    filename: e.filename,
    pageCount: e.pageCount,
    declaredBytes: e.declaredBytes,
  }))

  // Σ declaredBytes ≤ MAX_PDF_TOTAL_BYTES(spec D7 r4)。
  const totalPdfBytes = pdfFiles.reduce((sum, f) => sum + f.declaredBytes, 0)
  if (totalPdfBytes > MAX_PDF_TOTAL_BYTES) {
    return { ok: false, error: '合計サイズが上限を超えています' }
  }

  // ---- 層 2(spec D6): UX のための早期棄却であり **防御ではない** ----
  // client echo(pageCount)は信用していない。層 2 が画像枚数 + Σecho で弾いても
  // 弾かなくても、データの正しさ(課金記帳・レンダリング量・publish 内容)を
  // 守るのは T8 の pipeline count phase(render 前に数え直す・唯一の機械保証)
  // だけである。層 2 は「無駄な R2 GET / WASM parse を早期に避ける」UX 目的の
  // 棄却でしかなく、これを防御と誤読して層 3(count phase)を緩めてはならない
  // (spec D6 恒久注記)。超過時は行ゼロで却下する(tx を開く前に return する
  // ことで、現行の「検証完了後に tx を開く」順序を維持)。
  //
  // ②-4b T7 fix round 2(Codex Important・controller 実在確定): この判定は
  // **headObject を 1 回も呼ぶ前**に置く(HEAD fan-out より前)。理由 = 却下が
  // 確定している manifest(合計ページ超過)に対しても、順序を誤ると headObject が
  // entry 数ぶん並列発火してしまう(認証済ユーザーが安価に大量 R2 HEAD を誘発
  // できる増幅ベクタ)。層 3(T8 count phase)の機械保証は不変 — 「安いチェックを
  // 先に置く」順序変更であって防御層を減らすものではない。
  const totalPages = files.length + pdfFiles.reduce((sum, f) => sum + f.pageCount, 0)
  if (totalPages > OCR_MAX_PAGES) {
    return {
      ok: false,
      error: `合計ページ数は ${OCR_MAX_PAGES} ページまでです`,
    }
  }

  // uploadSessionId(spec §3.4: PDF を含む manifest では uuid v4 として必須。
  // top-level field・manifest 各要素は fileId だけを持つ)。
  let uploadSessionId: string | null = null
  if (pdfFiles.length > 0) {
    const rawUploadSessionId = formData.get('uploadSessionId')
    const parsedSessionId =
      typeof rawUploadSessionId === 'string'
        ? z.uuid({ version: 'v4' }).safeParse(rawUploadSessionId)
        : null
    if (!parsedSessionId || !parsedSessionId.success) {
      return { ok: false, error: '入力内容が正しくありません' }
    }
    uploadSessionId = parsedSessionId.data

    // headObject 検証(**tx 外**・spec D6 層 2 の一部)。実在 + contentLength ===
    // declaredBytes(declaredBytes は zod で既に ≤ MAX_PDF_BYTES を満たすため、
    // 一致が取れれば contentLength も上限内であることが transitively 保証される
    // — finalize-pdf-source.ts の Codex I5 対処と同じ理由で別途の上限比較は不要)。
    const sessionId = uploadSessionId
    const headResults = await Promise.all(
      pdfFiles.map((pdf) => headObject(sourcePdfObjectKey(userId, sessionId, pdf.fileId))),
    )
    const allVerified = headResults.every(
      (r, i) => r.exists && r.contentLength === pdfFiles[i].declaredBytes,
    )
    if (!allVerified) {
      return { ok: false, error: 'アップロードの検証に失敗しました' }
    }
  }

  return {
    ok: true,
    input: { idempotencyKey, destination },
    files,
    pdfFiles,
    uploadSessionId,
    sourceOrder,
  }
}

// sync phase の tx 本体。user(Pick<User,'id'>)と tx を呼出側から受け取るだけで
// Clerk 認証や withTenantTx を自前で張らない(iso test が Clerk 無しで直接
// exercise できるようにする設計)。
export async function submitUploadTx(
  tx: TenantTx,
  user: Pick<User, 'id'>,
  input: SubmitUploadInput,
  files: SubmitUploadFileMeta[],
  // ②-4b T7(spec D3/D6): PDF echo manifest。既定 `[]` で全既存呼出元(画像のみ)は
  // 無改変のまま通る — 値は fileType / pagesTotal / expectedSourceCount の分岐
  // にのみ使い、tx の構造(advisory lock / replay / live-op gate / daily cap の
  // 各 step 順序)は変えない。
  pdfFiles: SubmitUploadPdfMeta[] = [],
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
      .select({ id: exams.id })
      .from(exams)
      .where(and(eq(exams.id, destination.examId), eq(exams.userId, user.id)))
      .limit(1)
    if (found.length === 0) {
      return { outcome: 'exam_not_found' }
    }
    resolvedExamId = found[0].id
  }

  // 6. source_document INSERT(status='processing')。filename 合成 / pages_total /
  // fileType / expected_source_count は画像のみ経路から踏襲しつつ、②-4b で PDF
  // 経路(spec D3/D6)を追加する。
  //
  // filename の「先頭」は 画像 → PDF の優先順で選ぶ(表示合成規則 D3「単一 = 原名 /
  // 複数 = 「A ほか N 件」」を満たせば足り、選択順そのものの厳密な保持は不要 —
  // それは Gemini parts 順としてのみ意味を持ち、T8 が manifest から個別に組む)。
  const hasPdf = pdfFiles.length > 0
  const totalSourceCount = files.length + pdfFiles.length
  const firstFile = files[0]
  const firstPdf = pdfFiles[0]
  const firstName = files.length > 0 ? firstFile.filename : firstPdf.filename
  const filename =
    totalSourceCount === 1 ? firstName : `${firstName} ほか ${totalSourceCount - 1} 件`
  const fileSizeBytes =
    files.reduce((sum, f) => sum + f.byteSize, 0) +
    pdfFiles.reduce((sum, f) => sum + f.declaredBytes, 0)
  const sourceDocInsert = await tx
    .insert(sourceDocuments)
    .values({
      userId: user.id,
      examId: resolvedExamId,
      mode: destination.mode,
      fileType: hasPdf ? 'pdf' : 'image',
      filename,
      fileSizeBytes,
      status: 'processing',
      // PDF 含みは NULL で INSERT → T8 の pipeline count phase が fenced CAS で
      // 確定値を書く(spec D6)。画像のみは従来どおり受領枚数が確定値。
      pagesTotal: hasPdf ? null : files.length,
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
      // PDF 含みは 0 sentinel(T8 の pipeline count phase が fenced CAS で確定値
      // へ更新・spec D6)。画像のみは従来どおり受領枚数(即時確定)。
      expectedSourceCount: hasPdf ? 0 : files.length,
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

  const validated = await validateFormData(formData, user.id)
  if (!validated.ok) return { outcome: 'invalid_input', error: validated.error }

  const result = await withTenantTx(user.id, (tx) =>
    submitUploadTx(
      tx,
      user,
      validated.input,
      validated.files.map((f) => ({ filename: f.name, byteSize: f.size })),
      validated.pdfFiles,
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
              // ②-4b T7: PDF manifest + uploadSessionId(T8 が R2 key を導出するのに
              // 要る・spec §13 r5 表)。T8 未実装につき現時点は受け取るだけで未使用。
              validated.pdfFiles,
              validated.uploadSessionId ?? undefined,
              // ②-4b T7 fix round 1(canonical Critical): 混在 submit の manifest 順
              // (spec §2/D3)。T8 が files/pdfFiles を zip し直すための唯一の手段。
              validated.sourceOrder,
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
