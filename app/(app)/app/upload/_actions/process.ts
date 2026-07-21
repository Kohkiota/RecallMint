'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import {
  type CardOption,
  type CardImage,
} from '@/lib/db/schema'
import { incrementAiUsage } from '@/lib/ai-usage-counter'
import { runOcrPipeline, OcrDeadlineError } from '@/lib/ai/ocr'
import type { GeminiInputFile } from '@/lib/ai/clients/gemini'
import { notifyOps } from '@/lib/ops'
import { logger } from '@/lib/logger'
import { newId } from '@/lib/sync/entity-mutations'
import { pdfPageCount } from '../_lib/pdf-page-count'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { TOTAL_UPLOAD_LIMIT_BYTES, TOTAL_UPLOAD_LIMIT_MB } from '../_lib/constants'
import { runUploadGuardTx, type Destination } from './upload-guard'
import { saveExtractedCards, completeUploadTx, markFailed } from './upload-persistence'

// 結果プレビュー用の card subset (preview UI が render する read-only data)。
// 完全な ExtractedCard をそのまま返すのではなく、 必要最小限に絞ることで
// FormData → Server Action → Client への boundary serialization コスト削減。
// Tag-1: customPropKeys は cards.custom_props DROP に伴い撤去。 タグ表示は Tag-4 で
// tag_options 由来の値を再配線する。
export type ProcessedCard = {
  id: string
  title: string
  questionTextSnippet: string
  optionCount: number
}

export type ProcessResultData = {
  sourceDocumentId: string
  examId: string
  examName: string
  cardsExtracted: number
  ocrCostYen: number
  modelChain: string[]
  cards: ProcessedCard[]
}

// 失敗時の error code (UI 側で分岐に使用、 T4 詳細表示用 details も含む)。
//   AUTH:                    認証なし / user.id 取得失敗
//   INVALID_INPUT:           formData の mode / examId / files が不正
//   EXAM_NOT_FOUND:          既存 exam が見つからない / archived
//   UPLOAD_IN_PROGRESS:      同一 user の OCR ジョブが既に走行中 (S1.9.4)
//                            advisory xact lock 取得失敗 (ms 窓の race) または
//                            in-flight processing 行が存在 (先行ジョブ走行中) の
//                            いずれかで発生する。
//   PAGE_LIMIT_EXCEEDED:     1 回の upload の合算 totalPages が OCR_MAX_PAGES (40) 超過
//   SIZE_LIMIT_EXCEEDED:     1 回の upload の合算 totalSize が TOTAL_UPLOAD_LIMIT_BYTES (4MB) 超過
//   QUOTA_EXCEEDED:          月次 OCR ページ上限 超過
//   GEMINI_DAILY_LIMIT_EXCEEDED: サービス全体の 1 日 Gemini call 上限超過 (S1.8)
//   GEMINI_FAILED:           OCR pipeline (Flash) 失敗
//   SAVE_FAILED:             OCR は成功したが DB 保存 (cards INSERT) 失敗
//   OTHER:                   上記いずれにも該当しない予期しないエラー
export type ProcessUploadErrorCode =
  | 'AUTH'
  | 'INVALID_INPUT'
  | 'EXAM_NOT_FOUND'
  | 'UPLOAD_IN_PROGRESS'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'GEMINI_DAILY_LIMIT_EXCEEDED'
  | 'GEMINI_FAILED'
  | 'SAVE_FAILED'
  | 'OTHER'

// 開発環境 (staging / preview / development) のみで UI 表示する詳細情報。
// production では client に渡されるが UI には表示されない (T4 環境変数判定)。
export type ProcessUploadErrorDetails = {
  rawError?: string
  sourceDocumentId?: string
  costYen?: number
  modelChain?: string[]
  // QUOTA_EXCEEDED 専用 fields
  current?: number
  limit?: number
  requested?: number
}

export type ProcessUploadResult =
  | { ok: true; data: ProcessResultData }
  | {
      ok: false
      code: ProcessUploadErrorCode
      error: string // user 向け文言
      details?: ProcessUploadErrorDetails
    }

const MAX_QUESTION_PREVIEW = 80

// 中央集約された Server Action。 案 B (kickoff §6) に従い、 OCR + cards INSERT を
// 一気に行い preview に「保存済」 状態の cards を返す。 OCR は完了時点で exam +
// cards が DB 確定済 (S1.9.3 で「破棄して再アップロード」 を廃止、 不要 exam の
// 削除は試験一覧の delete-exam action で行う)。
//
// S1.7 改修: 失敗時の戻り値を code 付き構造化、 plan-limits 超過は exam INSERT /
// source_documents INSERT を一切走らせずに早期 return (kickoff Critical 1)。
export async function processUpload(
  formData: FormData,
): Promise<ProcessUploadResult> {
  // S1.8 → S-cache-2a: 旧来 `revalidatePath('/', 'layout')` は全 path 配下を
  // 一括 revalidate する過剰スコープだった。 真に必要な cross-page 影響は 2 件:
  //   - /app/upload: 残量 banner (upload page.tsx の Server Component で fetch)
  //   - /app: dashboard dueCount (新規 card 投入で due 件数が増えるため)
  // upload 完了後は router.push で `/app/upload/result/[id]` に遷移するため、
  // result page は revalidate 対象外で問題ない (page 自体は表示専用)。
  // 内側 _processUpload は revalidate 責務を持たない (重複発火回避)。
  try {
    return await _processUpload(formData)
  } finally {
    revalidatePath('/app/upload')
    revalidatePath('/app')
  }
}

async function _processUpload(
  formData: FormData,
): Promise<ProcessUploadResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, code: 'AUTH', error: '認証が必要です' }

  // -- formData parse --
  const mode = formData.get('mode')
  if (mode !== 'new' && mode !== 'existing') {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      error: '投入先が指定されていません',
    }
  }
  let destination: Destination
  if (mode === 'existing') {
    const examId = formData.get('examId')
    if (typeof examId !== 'string' || examId.length === 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        error: '既存の試験が選択されていません',
      }
    }
    destination = { mode: 'existing', examId }
  } else {
    destination = { mode: 'new' }
  }

  const fileEntries = formData.getAll('files')
  const files: File[] = fileEntries.filter(
    (f): f is File => f instanceof File && f.size > 0,
  )
  if (files.length === 0) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      error: 'ファイルが選択されていません',
    }
  }

  // -- 推定ページ数算出 (plan-limits 比較用) --
  // DB を触らない file 解析のため、 advisory lock の前に行う。
  // lock は guard transaction の中だけで保持し、 file I/O を含まない。
  let totalPages = 0
  for (const file of files) {
    if (file.type === 'application/pdf') {
      try {
        totalPages += await pdfPageCount(file)
      } catch {
        // PDF 解析失敗時は 1 ページとして扱い、 OCR 段階で本格的なエラーにする
        totalPages += 1
      }
    } else if (file.type.startsWith('image/')) {
      totalPages += 1
    }
  }
  if (totalPages === 0) totalPages = 1 // 念のため最低 1 ページ計上

  // -- 1 回の upload 上限チェック (plan-limits とは独立した実用上限) --
  // Gemini タイムアウト制約由来の物理上限。 DB を触らない file 解析の直後・
  // guard transaction の前に置くことで、 超過時は DB を一切触らずに返る。
  if (totalPages > OCR_MAX_PAGES) {
    return {
      ok: false,
      code: 'PAGE_LIMIT_EXCEEDED',
      error:
        `1 回のアップロードは合計 ${OCR_MAX_PAGES} ページまでです。 ファイルを分けてアップロードしてください`,
    }
  }

  // -- source_documents metadata (transaction 前に算出、lock 保持時間を最小化) --
  const firstFile = files[0]
  const filename =
    files.length === 1 ? firstFile.name : `${firstFile.name} ほか ${files.length - 1} 件`
  const fileType: 'pdf' | 'image' =
    firstFile.type === 'application/pdf' ? 'pdf' : 'image'
  const totalSize = files.reduce((s, f) => s + f.size, 0)

  // -- 合計サイズ上限チェック (client すり抜け対策、 DB を触らない metadata 算出の直後) --
  // Vercel platform body 上限 4.5MB の手前で app-level に enforce する。
  // client 側 totalExceeded チェックが回避された場合でも 4MB 超を弾く。
  if (totalSize > TOTAL_UPLOAD_LIMIT_BYTES) {
    return {
      ok: false,
      code: 'SIZE_LIMIT_EXCEEDED',
      error: `合計サイズは ${TOTAL_UPLOAD_LIMIT_MB} MB までです。 ファイルを分けてアップロードしてください`,
    }
  }

  // ---------------------------------------------------------------------------
  // -- guard transaction: advisory lock + in-flight check + quota + exam/sourceDoc INSERT --
  // ---------------------------------------------------------------------------
  // 「1 user 1 OCR ジョブ」 を 2 機構の併用で担保する:
  //   (A) advisory xact lock: 同時起動 (ms 窓) の race を防ぐ。
  //       pg_try_advisory_xact_lock はロック取得失敗時に false を返す (waiting しない)。
  //       xact lock なので transaction commit/rollback で自動解放、明示的解放不要。
  //   (B) in-flight 行 check: 先行ジョブが OCR 走行中 (lock は source_documents INSERT
  //       の commit で既に解放済) の並列起動を弾く実効ルール。
  //       15 分 window は stale orphan (>15 分 / reconcile 前) による誤発火を防ぐ安全網。
  //
  // advisory lock は source_documents INSERT と同一 transaction に含め、
  // INSERT commit まで lock を保持する。 OCR pipeline (全体 deadline 720s) は transaction の
  // 外で実行するため、 lock が OCR 本体に持ち込まれることはない。
  //
  // hashtext() 衝突は別 user の稀な直列化のみ (OCR queue に落ちる程度)、
  // correctness には影響しないため許容 (user.id は UUID、衝突確率は無視できる)。
  // RLS-P3: guard 一式を owner-scoped な単一 withTenantTx tx に閉じる
  // (advisory xact lock + exam/source_documents INSERT の atomicity を保つ)。
  const guardResult = await withTenantTx(user.id, (tx) =>
    runUploadGuardTx(tx, user, destination, { filename, fileType, totalSize, totalPages }),
  )

  // -- guard transaction 結果の分岐 --
  if (guardResult.outcome === 'in_progress') {
    return {
      ok: false,
      code: 'UPLOAD_IN_PROGRESS',
      error:
        '処理中の OCR があります。完了をお待ちいただくか『試験一覧』で状況をご確認ください。',
    }
  }
  if (guardResult.outcome === 'quota_exceeded') {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      error: `今月の OCR ページ上限に達しました (${guardResult.current}/${guardResult.limit} ページ使用済、 今回要求 ${guardResult.requested} ページ)。 来月までお待ちいただくか上位プランへ。`,
      details: {
        current: guardResult.current,
        limit: guardResult.limit,
        requested: guardResult.requested,
      },
    }
  }
  if (guardResult.outcome === 'daily_limit_exceeded') {
    return {
      ok: false,
      code: 'GEMINI_DAILY_LIMIT_EXCEEDED',
      error:
        '本日のサービス全体の利用上限に達しました。 明日以降にお試しください。',
      details: {
        current: guardResult.current,
        limit: guardResult.limit,
      },
    }
  }
  if (guardResult.outcome === 'exam_not_found') {
    return {
      ok: false,
      code: 'EXAM_NOT_FOUND',
      error: guardResult.archived
        ? 'アーカイブ済の試験には追加できません'
        : '選択された試験が見つかりません',
    }
  }

  // outcome === 'success': guard 通過、 exam / source_documents INSERT 完了
  const { examId, examName, sourceDocumentId } = guardResult

  // -- OCR pipeline --
  let geminiInputs: GeminiInputFile[]
  try {
    geminiInputs = await Promise.all(
      files.map(async (f) => {
        const buf = await f.arrayBuffer()
        const data = Buffer.from(buf).toString('base64')
        return { mimeType: f.type || 'application/octet-stream', data }
      }),
    )
  } catch (err) {
    // OCR 前の失敗: ページ消費なし・cost 0 で台帳に failed 記録
    await markFailed(sourceDocumentId, err, {
      userId: user.id,
      filename,
      fileSizeBytes: totalSize,
      pagesProcessed: 0,
      ocrCostYen: 0,
    })
    return {
      ok: false,
      code: 'OTHER',
      error: 'ファイル読み込みに失敗しました',
      details: {
        rawError: err instanceof Error ? err.message : String(err),
        sourceDocumentId,
      },
    }
  }

  let pipelineResult
  try {
    pipelineResult = await runOcrPipeline(geminiInputs, {
      // S1.8: 各 Gemini call 直前で ai_usage / ai_usage_users counter を加算。
      // best-effort (counter DB エラーは pipeline 側で握りつぶす) のため、
      // counter 失敗で OCR が中断することはない。
      onAttempt: async () => {
        await incrementAiUsage(user.id, 1)
      },
    })
  } catch (err) {
    const isDeadline = err instanceof OcrDeadlineError
    // deadline 超過はページ数過多が原因 → user が対処できる文言を返す。
    // それ以外は一時的なサービス障害として既存文言を維持する。
    const userMessage = isDeadline
      ? '処理時間が長すぎました。ページ数を減らして再アップロードしてください'
      : '混み合っているようです、 少し時間をおいてからお試しください'
    const msg = err instanceof Error ? err.message : String(err)
    // deadline 時は source_documents.errorMessage も user-friendly にする
    // (markFailed 内で err.message.slice(0,500) を保存するため、err を差し替える)。
    const markFailedErr = isDeadline ? new Error(userMessage) : err
    // OCR pipeline 失敗: 完了 pages / cost は確定しないため 0 で台帳に failed 記録
    await markFailed(sourceDocumentId, markFailedErr, {
      userId: user.id,
      filename,
      fileSizeBytes: totalSize,
      pagesProcessed: 0,
      ocrCostYen: 0,
    })
    await notifyOps('ocr pipeline failed', {
      userId: user.id,
      sourceDocumentId,
      examId,
      filename,
      filesCount: files.length,
      totalPages,
      error: msg,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    logger.error({ event: 'ocr.pipeline.failed', sourceDocumentId, err })
    return {
      ok: false,
      code: 'GEMINI_FAILED',
      error: userMessage,
      details: {
        rawError: msg,
        sourceDocumentId,
        // OCR pipeline 失敗時は cost / model_chain が runOcrPipeline の throw 前に
        // tokenUsage を tracking できていないため不明 (Flash retry 中の中断は
        // pipeline 内部で握りつぶされる)。 cost / modelChain は OCR 成功側でのみ確定。
      },
    }
  }

  // -- cards bulk INSERT (成功時) --
  // ExtractedCard を cards row に変換、 sort_key を id 並びに利用しつつ
  // 学習初期値 (FSRS) は default に任せる (schema 側 defaultNow / default 0)。
  const cardRows = pipelineResult.cards.map((c) => ({
    userId: user.id,
    examId,
    sourceDocumentId,
    title: c.title,
    sortKey: c.sort_key ?? null,
    questionText: c.question_text,
    // Sprint I W5: OCR は表示ラベル id のみ返す(Gemini prompt / schema 非接触)。
    // 内部不変 uid はアプリが写像点で mint する(受け皿・画像自動切り出しは非スコープ)。
    options: c.options.map((o) => ({ ...o, uid: newId() })) as CardOption[],
    correctAnswerIds: c.correct_answer_ids,
    explanationText: c.explanation_text ?? null,
    images: (c.images ?? []) as CardImage[],
    // Tag-1: cards.custom_props / cards.tags を DROP したため書込列なし。
    // Gemini discover の `c.custom_props` は Tag-3 (本 task) で tag_categories /
    // tag_options / card_tags に分解書込する (下 applyOcrTags 呼出、 同 tx atomic)。
    // OCR pipeline 本体 (Gemini 呼出 / options 抽出 / discover schema) は不変。
  }))

  let insertedCards: { id: string; title: string }[] = []
  try {
    // B1 (S2.0c): cards bulk INSERT と exams.card_count += N を同一 transaction
    // で実行し、 件数キャッシュ列が card 実体と乖離しないようにする。 examId は
    // OCR の投入先 exam (mode='new' は直前に作成済 / 'existing' は既存)。
    //
    // Tag-3 T2 (spec §2.1 / §4): applyOcrTags も同 tx に同梱して atomic。
    // UNIQUE(category_id, name) 競合は ON CONFLICT DO NOTHING + 再 SELECT で握る
    // 正常系 (helper 内で処理)、 予期せぬ DB error のみ throw で tx 巻き込み →
    // 下 catch で SAVE_FAILED を返す。 inserted row index と pipelineResult.cards
    // の index 対応は drizzle bulk INSERT + RETURNING の VALUES 順保持に依拠
    // (preview 構築 L648-649 と同じ既存契約)。
    insertedCards = await withTenantTx(user.id, (tx) =>
      saveExtractedCards(tx, {
        userId: user.id,
        examId,
        cardRows,
        customProps: pipelineResult.cards.map((c) => c.custom_props),
      }),
    )
  } catch (err) {
    // cards 保存失敗: OCR 自体は成功し cost が発生済のため実値を台帳に failed 記録
    await markFailed(sourceDocumentId, err, {
      userId: user.id,
      filename,
      fileSizeBytes: totalSize,
      pagesProcessed: totalPages,
      ocrCostYen: pipelineResult.costYen,
    })
    await notifyOps('cards insert failed after ocr success', {
      userId: user.id,
      sourceDocumentId,
      examId,
      cardsCount: cardRows.length,
      error: err,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    return {
      ok: false,
      code: 'SAVE_FAILED',
      error: '抽出結果の保存に失敗しました',
      details: {
        rawError: err instanceof Error ? err.message : String(err),
        sourceDocumentId,
        costYen: pipelineResult.costYen,
        modelChain: pipelineResult.modelChain.map(String),
      },
    }
  }

  // -- source_documents 完了更新 + upload_records 台帳 append (1 transaction) --
  // S1.9.1: source_documents UPDATE と upload_records INSERT を一蓮托生で
  // commit/rollback する。 upload_records が月次 quota の集計元 (append-only で
  // 物理削除されないため返金が起きない、 Bug A 解消の本体)。
  //
  // Min4 (S2.0.5 sprint): 完了 tx の throw を try/catch で捕捉する。 cards INSERT
  // は既に成功しているが、 ここ (status='completed' 更新 + upload_records 台帳)
  // が Neon 瞬断等で失敗すると、 捕捉しない限り例外が caller に伝播し
  // source_documents が 'processing' のまま残留する。 markFailed で status を
  // 'failed' に確定させ、 stuck processing を防ぐ。
  try {
    await withTenantTx(user.id, (tx) =>
      completeUploadTx(tx, {
        sourceDocumentId,
        userId: user.id,
        filename,
        totalSize,
        totalPages,
        cardsExtracted: insertedCards.length,
        ocrCostYen: pipelineResult.costYen,
      }),
    )
  } catch (err) {
    // OCR + cards INSERT は成功済 (cost 発生済) のため、 markFailed には実値
    // (pagesProcessed / ocrCostYen) を渡し台帳に failed として記録する。
    await markFailed(sourceDocumentId, err, {
      userId: user.id,
      filename,
      fileSizeBytes: totalSize,
      pagesProcessed: totalPages,
      ocrCostYen: pipelineResult.costYen,
    })
    await notifyOps('completion transaction failed after ocr success', {
      userId: user.id,
      sourceDocumentId,
      examId,
      cardsCount: insertedCards.length,
      error: err,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    logger.error({ event: 'ocr.completion_tx.failed', sourceDocumentId, err })
    return {
      ok: false,
      code: 'SAVE_FAILED',
      error: '抽出結果の保存に失敗しました',
      details: {
        rawError: err instanceof Error ? err.message : String(err),
        sourceDocumentId,
        costYen: pipelineResult.costYen,
        modelChain: pipelineResult.modelChain.map(String),
      },
    }
  }

  // -- preview data の構築 --
  // 完全な card row を返すと payload が膨れる + 学習統計の RTC 不要のため、
  // 表示専用の subset (id / title / question 抜粋 / option 数) に絞る。
  const previewCards: ProcessedCard[] = insertedCards.map((row, idx) => {
    const extracted = pipelineResult.cards[idx]
    return {
      id: row.id,
      title: row.title,
      questionTextSnippet: truncate(extracted.question_text, MAX_QUESTION_PREVIEW),
      optionCount: extracted.options.length,
    }
  })

  return {
    ok: true,
    data: {
      sourceDocumentId,
      examId,
      examName,
      cardsExtracted: insertedCards.length,
      ocrCostYen: pipelineResult.costYen,
      modelChain: pipelineResult.modelChain.map(String),
      cards: previewCards,
    },
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}
