'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import imageCompression from 'browser-image-compression'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { formatRelativeJa, type ActiveExam } from '@/lib/exams/list'
import {
  MAX_IMAGE_FILE_MB,
  MAX_IMAGE_WIDTH_OR_HEIGHT,
  MAX_PDF_PAGES,
  TOTAL_UPLOAD_LIMIT_BYTES,
  TOTAL_UPLOAD_LIMIT_MB,
} from '../_lib/constants'
import { pdfPageCount } from '../_lib/pdf-page-count'
import { partitionByDuplicateFilename } from '../_lib/dedupe-filenames'
import {
  processUpload,
  type ProcessResultData,
  type ProcessUploadErrorCode,
  type ProcessUploadErrorDetails,
} from '../_actions/process'
import { discardUpload } from '../_actions/discard'

// 投入先選択 state:
//  - null: 未選択 (submit disable)
//  - { mode: 'new' }: 新規 exam として保存 (仮 name は server side で確定)
//  - { mode: 'existing', examId }: 既存 exam (examId 必須)
//  - exam が 0 件のときは server side で「new」 固定として描画する
export type Destination =
  | null
  | { mode: 'new' }
  | { mode: 'existing'; examId: string }

// 個別 file の処理状態。 'processing' = 圧縮 / page count 解析中、
// 'ready' = 投入可、 'error' = 上限超過 / 解析失敗で使用不可。
type FileEntry =
  | { id: string; kind: 'image'; file: File; thumbUrl: string; originalSize: number; status: 'ready' }
  | {
      id: string
      kind: 'image'
      file: File
      thumbUrl?: string
      originalSize: number
      status: 'processing'
    }
  | { id: string; kind: 'image'; file: File; thumbUrl?: string; originalSize: number; status: 'error'; error: string }
  | { id: string; kind: 'pdf'; file: File; pageCount: number; originalSize: number; status: 'ready' }
  | { id: string; kind: 'pdf'; file: File; pageCount?: number; originalSize: number; status: 'processing' }
  | { id: string; kind: 'pdf'; file: File; pageCount?: number; originalSize: number; status: 'error'; error: string }

function formatBytes(b: number): string {
  if (b < 1_000) return `${b} B`
  if (b < 1_000_000) return `${(b / 1_000).toFixed(1)} KB`
  return `${(b / 1_000_000).toFixed(2)} MB`
}

const planLabelMap = {
  free: 'Free プラン',
  standard: 'Standard プラン',
  pro: 'Pro プラン',
} as const

// phase: 'idle' = ファイル選択中 / 'submitting' = OCR 実行中 (server action 中) /
// 'success' = preview 表示中 / 'error' = エラー表示中。
// success / error は サーバー側で source_documents row が存在し、 やり直し時には
// discardUpload(prevSourceDocumentId) を呼んで掃除する。
type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: ProcessResultData }
  | {
      kind: 'error'
      message: string
      code: ProcessUploadErrorCode | 'CLIENT_TIMEOUT'
      details?: ProcessUploadErrorDetails
      lastSourceDocumentId?: string
    }

export function UploadForm({
  existingExams,
  currentMonthPages,
  monthlyLimit,
  remaining,
  plan,
}: {
  existingExams: ActiveExam[]
  /** 当月 (JST 月境界) の OCR ページ消費 (Server fetch、 stale 排除済) */
  currentMonthPages: number
  /** plan 別 月次上限。 Pro は null (公平利用)。 */
  monthlyLimit: number | null
  /** 残量 = monthlyLimit - currentMonthPages。 Pro は null。 */
  remaining: number | null
  /** plan 名 (CTA で「Pro へアップグレード」 等の出し分けに使用) */
  plan: 'free' | 'standard' | 'pro'
}) {
  const router = useRouter()
  const [entries, setEntries] = useState<FileEntry[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // exam 0 件なら destination は強制的に 'new' (UI 上の選択肢を出さない)。
  // 1 件以上あれば null 開始 (ユーザー選択を強制)。
  const [destination, setDestination] = useState<Destination>(
    existingExams.length === 0 ? { mode: 'new' } : null,
  )
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // 派生 flag: OCR Server Action 実行中。 UI controls の disable 判定に集約利用。
  const isSubmitting = phase.kind === 'submitting'
  // 重複した filename を 4 秒間 banner 表示するための transient state。
  const [duplicateWarnings, setDuplicateWarnings] = useState<string[]>([])
  const duplicateClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // entry 削除時に object URL を必ず revoke (memory leak 防止)。
  // 重複警告の transient timer も unmount で確実 clear (stale fire 防止)。
  useEffect(() => {
    return () => {
      for (const e of entries) {
        if (e.kind === 'image' && 'thumbUrl' in e && e.thumbUrl) URL.revokeObjectURL(e.thumbUrl)
      }
      if (duplicateClearTimerRef.current) {
        clearTimeout(duplicateClearTimerRef.current)
        duplicateClearTimerRef.current = null
      }
    }
    // entries 依存 ではなく unmount のみ cleanup (removeEntry で個別 revoke 済)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // OCR submitting 中はタブ閉じる / リロード / ブラウザ戻る を block。
  // 詳細:
  //   - beforeunload: 標準 browser confirm dialog を発火 (modern browsers は
  //     custom 文言を無視するが dialog 自体は出る)
  //   - popstate: sentinel state pattern。 effect 入りで history.pushState で
  //     ダミー entry を仕込み、 ユーザーが back を押すと popstate が発火する。
  //     confirm で「中断する」 なら navigation を許可 (sentinel 消費済)、
  //     「キャンセル」 なら history.pushState で sentinel を再配置して
  //     現在 page に留まらせる
  //   - Next.js Link クリックによる soft navigation は popstate を発火しない
  //     ため block 対象外 (spinner banner の文言で expectation 設定)
  useEffect(() => {
    if (!isSubmitting) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // returnValue は modern TS lib で deprecated marking されているが、
      // 一部 legacy browser (Edge 旧 / Safari) は preventDefault のみでは dialog を
      // 出さず returnValue を見るため、 cross-browser 互換のため維持。 MDN も
      // 「set to empty string」 と案内している。 TS の deprecation hint
      // (6385) は build を block しないため受け流す (eslint disable や
      // ts-expect-error は他の警告で対応している file との一貫性を欠くため
      // 不要、 コメントで意図を残すのみ)。
      e.returnValue = ''
    }

    let sentinelActive = true
    const handlePopState = () => {
      if (!sentinelActive) return
      const ok = window.confirm(
        'AI 抽出を実行中です。 このまま戻ると抽出結果が失われる可能性があります。 中断して戻りますか?',
      )
      if (!ok) {
        // sentinel を再配置し、 現在 page に留まらせる
        window.history.pushState(null, '', window.location.href)
      } else {
        // 一度だけ「中断」 を許可、 以降の popstate (forward etc.) は block しない
        sentinelActive = false
      }
    }

    // sentinel state を仕込む (back を押されたときに popstate が発火する余地を作る)
    window.history.pushState(null, '', window.location.href)
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('popstate', handlePopState)

    return () => {
      sentinelActive = false
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('popstate', handlePopState)
      // sentinel push は cleanup で pop しない (タイミング次第で
      // navigation を妨害する risk)。 ユーザーには「戻る」 を 1 回余分に押す
      // 必要が残るが、 submitting 終了後の通常 page では問題なし。
    }
  }, [isSubmitting])

  const totalBytes = entries.reduce((s, e) => s + e.file.size, 0)
  const totalExceeded = totalBytes > TOTAL_UPLOAD_LIMIT_BYTES
  const anyProcessing = entries.some((e) => e.status === 'processing')
  const anyError = entries.some((e) => e.status === 'error')
  const destinationReady =
    destination !== null &&
    (destination.mode === 'new' ||
      (destination.mode === 'existing' && destination.examId.length > 0))

  // 合計 page 数 (PDF: pageCount / 画像: 1)。 ready / processing 含む (error 除く)。
  // processing 中はまだ page count 不確定なので 0 扱い、 ready になり次第加算。
  const totalRequestedPages = entries.reduce((sum, e) => {
    if (e.status === 'error') return sum
    if (e.kind === 'image') return sum + 1
    if (e.kind === 'pdf' && e.status === 'ready') return sum + e.pageCount
    return sum
  }, 0)
  // 残量超過判定 (Pro は remaining=null で常に false)。
  const overQuota =
    remaining !== null && totalRequestedPages > remaining
  // 既に残量 0 で来た user (Pro 以外)。 file 選択前から submit 不可。
  const alreadyAtQuota = remaining !== null && remaining === 0

  const submitDisabled =
    entries.length === 0 ||
    anyProcessing ||
    anyError ||
    totalExceeded ||
    !destinationReady ||
    overQuota ||
    alreadyAtQuota

  async function processImage(file: File, id: string) {
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: MAX_IMAGE_FILE_MB,
        maxWidthOrHeight: MAX_IMAGE_WIDTH_OR_HEIGHT,
        useWebWorker: true,
      })
      const thumbUrl = URL.createObjectURL(compressed)
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                id,
                kind: 'image' as const,
                file: compressed,
                thumbUrl,
                originalSize: file.size,
                status: 'ready' as const,
              }
            : e,
        ),
      )
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                id,
                kind: 'image' as const,
                file,
                originalSize: file.size,
                status: 'error' as const,
                error: err instanceof Error ? err.message : '画像圧縮に失敗しました',
              }
            : e,
        ),
      )
    }
  }

  async function processPdf(file: File, id: string) {
    try {
      const pages = await pdfPageCount(file)
      if (pages > MAX_PDF_PAGES) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  id,
                  kind: 'pdf' as const,
                  file,
                  pageCount: pages,
                  originalSize: file.size,
                  status: 'error' as const,
                  error: `PDF が ${pages} ページ (上限 ${MAX_PDF_PAGES} ページ)`,
                }
              : e,
          ),
        )
        return
      }
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                id,
                kind: 'pdf' as const,
                file,
                pageCount: pages,
                originalSize: file.size,
                status: 'ready' as const,
              }
            : e,
        ),
      )
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                id,
                kind: 'pdf' as const,
                file,
                originalSize: file.size,
                status: 'error' as const,
                error: err instanceof Error ? err.message : 'PDF 解析に失敗しました',
              }
            : e,
        ),
      )
    }
  }

  function handleAdd(filesList: FileList | null) {
    if (!filesList) return
    const incoming = Array.from(filesList)
    // 同一 filename (既存 + 同 batch 内) を弾く。 hash 比較は MVP 不要、
    // filename 一致のみで判定。
    const { unique, duplicates } = partitionByDuplicateFilename(
      incoming,
      entries.map((e) => ({ file: e.file })),
    )
    if (duplicates.length > 0) {
      setDuplicateWarnings(duplicates)
      if (duplicateClearTimerRef.current) {
        clearTimeout(duplicateClearTimerRef.current)
      }
      duplicateClearTimerRef.current = setTimeout(() => {
        setDuplicateWarnings([])
        duplicateClearTimerRef.current = null
      }, 4000)
    }
    const newEntries: FileEntry[] = []
    for (const file of unique) {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
      if (file.type === 'application/pdf') {
        newEntries.push({
          id,
          kind: 'pdf',
          file,
          originalSize: file.size,
          status: 'processing',
        })
        void processPdf(file, id)
      } else if (file.type.startsWith('image/')) {
        newEntries.push({
          id,
          kind: 'image',
          file,
          originalSize: file.size,
          status: 'processing',
        })
        void processImage(file, id)
      } else {
        // 想定外 mime: 無視 (input accept で弾く想定だが念のため)
      }
    }
    setEntries((prev) => [...prev, ...newEntries])
    // input value を reset、 同じ file 連続選択でも change が発火するように
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeEntry(id: string) {
    setEntries((prev) => {
      const target = prev.find((e) => e.id === id)
      if (target && target.kind === 'image' && 'thumbUrl' in target && target.thumbUrl) {
        URL.revokeObjectURL(target.thumbUrl)
      }
      return prev.filter((e) => e.id !== id)
    })
  }

  function buildFormData(): FormData {
    const fd = new FormData()
    if (destination?.mode === 'new') {
      fd.set('mode', 'new')
    } else if (destination?.mode === 'existing') {
      fd.set('mode', 'existing')
      fd.set('examId', destination.examId)
    }
    for (const e of entries) fd.append('files', e.file, e.file.name)
    return fd
  }

  // runProcess は phase 切替を行わない (caller が setPhase('submitting') を
  // **urgent priority** で先に撃つ責務を持つ)。 ここで setPhase を呼ぶと
  // 「submitting 」 が transition priority 化して React 19 のバッチング判定で
  // skip される (S1a 後の staging smoke で発覚した bug、 詳細は handoff doc)。
  //
  // S1.7 T6: client 側 90 秒 timeout を追加。 Vercel function が 60 秒で kill
  // されても catch に届かない場合、 client が spinner 永続化しないよう defensive
  // に切り上げ、 retry 誘導する。 server 側 source_documents は 10 分 stale 排除
  // で集計から外れる (T1)。
  async function runProcess() {
    const fd = buildFormData()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      setPhase({
        kind: 'error',
        code: 'CLIENT_TIMEOUT',
        message:
          '処理がタイムアウトしました。 ファイルを変えて再試行してください。',
        details: {
          rawError: 'client 90s timeout exceeded',
        },
      })
    }, 90_000)

    let result
    try {
      result = await processUpload(fd)
    } finally {
      clearTimeout(timeoutId)
    }

    // timeout 発火後に server が遅れて応答した場合は state を上書きしない
    // (ユーザーは既に「タイムアウト」 を見ている、 retry に進んでいる可能性あり)
    if (timedOut) return

    if (result.ok && result.data) {
      setPhase({ kind: 'success', result: result.data })
    } else if (!result.ok) {
      setPhase({
        kind: 'error',
        message: result.error,
        code: result.code,
        details: result.details,
        // server action 内で source_documents.status='failed' まで打って返している
        // ため、 retry 時の discard 対象 id は不明 (failed row は user 視点で
        // 見えない、 retry は新規 source_document を作るだけ)。
      })
    } else {
      setPhase({
        kind: 'error',
        message: '予期しないエラー',
        code: 'OTHER',
      })
    }
  }

  // handleSubmit / handleRetry / handleChangeFiles の共通方針:
  //   1. phase 切替を **urgent priority** で行う (startTransition で wrap しない)
  //   2. 非同期処理は IIFE / 直 await で投げ捨て、 await 後の setPhase は urgent
  //   3. これにより React 19 の concurrent renderer が「submitting」 を必ず commit
  //      する (submitting + success 両方 urgent priority のため、 中間 render が
  //      coalesce されない)

  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    setPhase({ kind: 'submitting' })
    void runProcess()
  }

  function handleRetry() {
    // 「やり直し」 = 直前の成功 source_document を消してから新規 process
    if (phase.kind !== 'success') return
    const prevId = phase.result.sourceDocumentId
    // S1.9: auto 作成 exam (mode==='new') なら discard 時に空 exam も掃除させる。
    // 既存 exam への追加だった場合は undefined を渡し exam を残す。
    const autoCreatedExamId = phase.result.examWasAutoCreated
      ? phase.result.examId
      : undefined
    setPhase({ kind: 'submitting' })
    void (async () => {
      await discardUpload(prevId, autoCreatedExamId)
      await runProcess()
      // S1.8: 同 page 内 button のため別 path への navigation がない。
      // discard / process Server Action 内で revalidatePath('/','layout') 済だが、
      // 同 page を「再 render」 させるには client から router.refresh が必要。
      // discard と process の delta を一括反映するため最後に 1 回だけ呼ぶ
      // (中間 refresh はユーザーが submitting 中で見えないため無駄)。
      router.refresh()
    })()
  }

  function handleChangeFiles() {
    // 「ファイル変更して再試行」 = state を idle に戻し、 entries も clear。
    // ボタン文言が「ファイル変更」 なのに entries (サムネ) が残っていると UX が
    // 一貫しないため、 entry の object URL を revoke してから空配列にリセットする
    // (S1.7 review Important 4 で指摘)。 成功時の source_document は user 視点で
    // 「破棄」 すべきなので discardUpload も呼ぶ。
    const clearEntries = () => {
      setEntries((prev) => {
        for (const e of prev) {
          if (e.kind === 'image' && 'thumbUrl' in e && e.thumbUrl) {
            URL.revokeObjectURL(e.thumbUrl)
          }
        }
        return []
      })
    }
    if (phase.kind === 'success') {
      const prevId = phase.result.sourceDocumentId
      // S1.9: auto 作成 exam (mode==='new') なら discard 時に空 exam も掃除させる。
      const autoCreatedExamId = phase.result.examWasAutoCreated
        ? phase.result.examId
        : undefined
      // discard 中も spinner を出すため一時的に submitting に。
      // discard 完了 (通常 1 秒以内) で idle + entries clear。
      setPhase({ kind: 'submitting' })
      void (async () => {
        await discardUpload(prevId, autoCreatedExamId)
        clearEntries()
        setPhase({ kind: 'idle' })
        // S1.8: file 選択画面に戻った時点で残量 banner を新値で再 render。
        router.refresh()
      })()
    } else {
      clearEntries()
      setPhase({ kind: 'idle' })
    }
  }

  // 結果プレビュー (success state) は idle UI と排他で表示する。
  if (phase.kind === 'success') {
    return (
      <ResultPreview
        result={phase.result}
        onRetry={handleRetry}
        onChangeFiles={handleChangeFiles}
      />
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6"
    >
      {/* 月次 OCR 残量表示 (S1.7 T3)。 Pro (remaining=null) は「無制限」、
          Free / Standard は「残り N / M」 を常時表示 + 0/M は警告色。 */}
      <section
        className={`rounded-md border p-3 text-sm ${
          alreadyAtQuota
            ? 'bg-amber-50 border-amber-200 text-amber-900'
            : 'bg-slate-50 border-slate-200 text-slate-700'
        }`}
        aria-label="今月の OCR ページ残量"
      >
        {remaining === null ? (
          <>今月の OCR ページ残量: <span className="font-bold">無制限</span> ({planLabelMap[plan]})</>
        ) : (
          <>
            今月の OCR ページ残量: <span className="font-bold">{remaining}</span> / {monthlyLimit} ページ ({planLabelMap[plan]})
            {currentMonthPages > 0 && (
              <span className="ml-2 text-xs text-slate-500">
                (使用済 {currentMonthPages} ページ)
              </span>
            )}
          </>
        )}
        {alreadyAtQuota && (
          <div className="mt-2 text-xs">
            今月の OCR 上限に達しています。 来月までお待ちいただくか、 上位プランへのアップグレードをご検討ください。
          </div>
        )}
      </section>

      {isSubmitting && (
        // S1.8: 中断 = 利用枠だけ消費されて cards が得られない事を強調するため
        // amber 警告色 + alert role に格上げ。 amber は ResultPreview の破棄注意
        // banner と統一感を持たせる。
        <section
          role="alert"
          aria-live="assertive"
          className="rounded-md bg-amber-50 border border-amber-400 p-4 flex items-start gap-3"
        >
          <Loader2 className="h-5 w-5 animate-spin text-amber-700 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">AI が問題を抽出しています… (30 秒〜数分かかります)</p>
            <p className="mt-1">
              ⚠ この画面を閉じたり戻ったりしないでください。 中断しても AI 抽出の利用枠は消費されます。
            </p>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-bold mb-2">ファイルを選択</h2>
        <p className="text-sm text-slate-600 mb-3">
          画像 (JPG / PNG / HEIC 等) は自動で圧縮されます。 PDF はそのまま投入されます (最大 {MAX_PDF_PAGES} ページ)。
          <br />
          合計サイズ上限 {TOTAL_UPLOAD_LIMIT_MB} MB。
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          disabled={isSubmitting}
          onChange={(e) => handleAdd(e.target.files)}
          className="block w-full text-sm text-slate-700 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-slate-900 file:text-white hover:file:bg-slate-800 file:font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {duplicateWarnings.length > 0 && (
          <div
            role="alert"
            className="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3"
          >
            同じファイル名が既に選択されています:
            <ul className="list-disc list-inside mt-1">
              {duplicateWarnings.map((name, i) => (
                <li key={`${name}-${i}`} className="break-all">{name}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {entries.length > 0 && (
        <section>
          <h3 className="font-medium mb-2 text-sm text-slate-700">
            {entries.length} 件選択中 (合計 {formatBytes(totalBytes)} / 上限 {TOTAL_UPLOAD_LIMIT_MB} MB、 合計 {totalRequestedPages} ページ)
          </h3>
          {overQuota && remaining !== null && (
            <div
              role="alert"
              className="mb-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900"
            >
              現在の選択 ({totalRequestedPages} ページ) は今月の残量 ({remaining} ページ) を超過します。
              ファイルを削減するか、 上位プランへのアップグレードをご検討ください。
            </div>
          )}
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {entries.map((e) => (
              <li key={e.id}>
                <Card className={e.status === 'error' ? 'ring-red-200' : ''}>
                  <CardContent className="p-3 space-y-2">
                    {e.kind === 'image' && 'thumbUrl' in e && e.thumbUrl ? (
                      <img
                        src={e.thumbUrl}
                        alt={e.file.name}
                        className="w-full aspect-square object-cover rounded"
                      />
                    ) : (
                      <div className="w-full aspect-square bg-slate-100 rounded flex flex-col items-center justify-center text-slate-500 text-xs">
                        {e.kind === 'pdf' ? (
                          <>
                            <span className="text-2xl">PDF</span>
                            {e.kind === 'pdf' && e.status === 'ready' && (
                              <span>{e.pageCount} ページ</span>
                            )}
                          </>
                        ) : (
                          <span>処理中…</span>
                        )}
                      </div>
                    )}
                    <div className="text-xs truncate" title={e.file.name}>
                      {e.file.name}
                    </div>
                    <div className="text-xs text-slate-500">
                      {e.status === 'processing'
                        ? '処理中…'
                        : e.status === 'error'
                          ? <span className="text-red-700">{e.error}</span>
                          : `${formatBytes(e.file.size)}${
                              e.kind === 'image' && e.originalSize > e.file.size
                                ? ` (元 ${formatBytes(e.originalSize)})`
                                : ''
                            }`}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSubmitting}
                      onClick={() => removeEntry(e.id)}
                      className="w-full text-xs py-1"
                    >
                      削除
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
          {totalExceeded && (
            <p className="mt-3 text-sm text-red-700">
              合計サイズが上限 {TOTAL_UPLOAD_LIMIT_MB} MB を超えています。 一部ファイルを削除してください。
            </p>
          )}
        </section>
      )}

      {existingExams.length > 0 && (
        <section>
          <h2 className="text-lg font-bold mb-2">投入先を選択</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setDestination({ mode: 'new' })}
              className={`text-left rounded-xl border p-4 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                destination?.mode === 'new'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-300 bg-white hover:border-slate-500'
              }`}
            >
              <div className="font-bold mb-1">＋ 新規 exam として保存</div>
              <div className="text-xs opacity-80">
                試験名は「アップロード YYYY-MM-DD HH:mm」 の仮 name で作成、 後から編集可能
              </div>
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                // 既存 mode に切替、 examId 未選択のまま dropdown を出して選択を待つ
                setDestination({ mode: 'existing', examId: '' })
              }}
              className={`text-left rounded-xl border p-4 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                destination?.mode === 'existing'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-300 bg-white hover:border-slate-500'
              }`}
            >
              <div className="font-bold mb-1">既存 exam に追加</div>
              <div className="text-xs opacity-80">
                既存の試験を選んで cards を追加
              </div>
            </button>
          </div>
          {destination?.mode === 'existing' && (
            <div className="mt-3">
              <label className="block text-sm text-slate-700 mb-1">
                追加先の試験を選択
              </label>
              <select
                value={destination.examId}
                disabled={isSubmitting}
                onChange={(e) =>
                  setDestination({ mode: 'existing', examId: e.target.value })
                }
                className="block w-full rounded-md border border-slate-300 bg-white p-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">— 試験を選択 —</option>
                {existingExams.map((exam, idx) => (
                  <option key={exam.id} value={exam.id}>
                    {idx === 0 ? '【直近】 ' : ''}
                    {exam.name} ({formatRelativeJa(exam.updatedAt)})
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>
      )}

      {phase.kind === 'error' && (
        <section className="rounded-md bg-red-50 border border-red-200 p-4 space-y-2">
          <p className="text-sm text-red-700">{phase.message}</p>
          <p className="text-xs text-slate-700">
            ファイルを変更して再度お試しください。
          </p>
          {/* 開発用詳細 (staging / preview / development のみ表示、
              NEXT_PUBLIC_VERCEL_ENV が 'production' 以外なら出す)。
              build 時に環境変数が embed されるため、 production build には
              この block は実質残らない (`if (false)` 相当で tree-shake)。 */}
          {process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production' && (
            <ErrorDetails
              code={phase.code}
              message={phase.message}
              details={phase.details}
            />
          )}
        </section>
      )}

      <div className="pt-4">
        <Button
          type="submit"
          disabled={submitDisabled || phase.kind === 'submitting'}
          className="w-full py-3 text-base font-bold"
        >
          {phase.kind === 'submitting'
            ? 'AI で抽出中… (1-2 分かかる場合があります)'
            : anyProcessing
              ? '処理中…'
              : !destinationReady
                ? '投入先を選択してください'
                : 'AI で問題を抽出する'}
        </Button>
      </div>
    </form>
  )
}

function ResultPreview({
  result,
  onRetry,
  onChangeFiles,
}: {
  result: ProcessResultData
  onRetry: () => void
  onChangeFiles: () => void
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-md bg-emerald-50 border border-emerald-200 p-4">
        <h2 className="text-lg font-bold mb-1">
          ✅ {result.cardsExtracted} 問を抽出しました
        </h2>
        <p className="text-sm text-slate-700">
          試験「{result.examName}」 に保存されました。
        </p>
        {/* S1.7 T5: preview からコスト表示を削除。 DB の ocr_cost_yen 保存 +
            notifyOps 通知 + 詳細エラー (staging 表示) は維持。 */}
      </section>

      <section>
        <h3 className="font-bold mb-2">抽出結果のプレビュー</h3>
        <ul className="space-y-2">
          {result.cards.map((c) => (
            <li key={c.id}>
              <Card>
                <CardContent className="p-3">
                  <div className="font-medium text-sm mb-1">{c.title}</div>
                  <div className="text-xs text-slate-700 mb-1">
                    {c.questionTextSnippet}
                  </div>
                  <div className="text-xs text-slate-500">
                    選択肢 {c.optionCount} 件
                    {c.customPropKeys.length > 0 && (
                      <span> / プロパティ: {c.customPropKeys.join(', ')}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button asChild className="flex-1 py-3 text-base font-bold">
          {/* S1.8: OCR 完了直後は「抽出 cards が試験単位で記録されたか」 を
              user が確認したいため、 dashboard ではなく試験一覧に誘導する。
              dashboard へは header の logo から戻れる。 */}
          <Link href="/app/exams">試験一覧へ</Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRetry}
          className="flex-1 py-3 text-base"
        >
          同じファイルでやり直す
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onChangeFiles}
          className="flex-1 py-3 text-base"
        >
          ファイルを変えて再試行
        </Button>
      </div>
      {/* S1.8: 破棄系 button のリスク説明を amber 警告 banner に格上げ。
          「破棄したら残量が戻る」 と誤解されないよう、 利用枠は戻らない旨を
          明示する (Gemini API call は走り済 = ai_usage はカウント済)。 */}
      <div
        role="alert"
        className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <p className="font-semibold">⚠ ご注意</p>
        <p className="mt-1">
          「同じファイルでやり直す」 / 「ファイルを変えて再試行」 を押すと、 ここまでの抽出結果は破棄されます。
          ただし AI 抽出の利用枠は元に戻りません。
        </p>
      </div>
    </div>
  )
}

// 開発用 (staging / preview / dev) のみで render される詳細エラー section。
// production では呼び出し側で render されない (`process.env.NEXT_PUBLIC_VERCEL_ENV`
// 判定)。 ユーザー文言と独立に code / source_document_id / cost / model_chain /
// rawError を expose し、 OT が画面だけで原因切り分け可能にする。
function ErrorDetails({
  code,
  message,
  details,
}: {
  code: ProcessUploadErrorCode | 'CLIENT_TIMEOUT'
  message: string
  details?: ProcessUploadErrorDetails
}) {
  const rows: Array<[string, string]> = [
    ['code', code],
    ['user message', message],
  ]
  if (details?.rawError) rows.push(['rawError', details.rawError])
  if (details?.sourceDocumentId)
    rows.push(['sourceDocumentId', details.sourceDocumentId])
  if (details?.costYen !== undefined)
    rows.push(['costYen', String(details.costYen)])
  if (details?.modelChain)
    rows.push(['modelChain', details.modelChain.join(' → ')])
  if (details?.current !== undefined)
    rows.push(['current', String(details.current)])
  if (details?.limit !== undefined) rows.push(['limit', String(details.limit)])
  if (details?.requested !== undefined)
    rows.push(['requested', String(details.requested)])

  return (
    <details className="mt-3 rounded border border-slate-300 bg-slate-50 p-2">
      <summary className="cursor-pointer text-xs font-mono text-slate-700 select-none">
        詳細 (staging / dev only)
      </summary>
      <dl className="mt-2 text-xs font-mono text-slate-800 space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[140px_1fr] gap-2">
            <dt className="text-slate-500 truncate">{k}</dt>
            <dd className="break-all whitespace-pre-wrap">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
