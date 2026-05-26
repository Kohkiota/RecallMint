'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import imageCompression from 'browser-image-compression'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
// client-safe な format helper + type を `@/lib/exams/format` から取る。
// `@/lib/exams/list` 側は `server-only` 付きで DB 接続を引き込むため使用不可。
import { formatRelativeJa, type ActiveExam } from '@/lib/exams/format'
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
  type ProcessUploadErrorCode,
  type ProcessUploadErrorDetails,
} from '../_actions/process'

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
// 'error' = エラー表示中。
// S1.9.2: 'success' phase を廃止。 OCR 成功時は preview を同 component で描画せず、
// 独立 route /app/upload/result/[sourceDocumentId] に router.push で遷移する
// (Bug B = 残量 banner stale 表示の構造解消、 page 遷移で fresh server render)。
// S1.9.3: 'CLIENT_TIMEOUT' を廃止。 Vercel Pro 昇格で server maxDuration=600s に
// 延長されたため、 client は server の完走をそのまま待つ方針に変更。
type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | {
      kind: 'error'
      message: string
      code: ProcessUploadErrorCode
      details?: ProcessUploadErrorDetails
      // throw/catch 経由のエラーは「試験一覧で確認を」と案内するため、
      // 「ファイルを変更して再試行」サブタイトルを非表示にする。
      // (他の error path は retry hint を表示し続ける)
      hideRetryHint?: boolean
    }

export function UploadForm({
  existingExams,
  currentMonthPages,
  monthlyLimit,
  remaining,
  plan,
}: {
  existingExams: ActiveExam[]
  /** 当月 (JST 月境界) の OCR ページ消費 (Server fetch、 upload_records SUM) */
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
  // S1.9.3: submitting 開始から 90 秒経過したことを示す flag。
  // phase とは独立した state で管理する。 90 秒を超えたら banner を「閉じてよい」
  // 旨に切替え、 離脱ガード (beforeunload / popstate) も解除する。
  // spinner 自体は isSubmitting が true の間ずっと表示し続ける。
  const [longRunning, setLongRunning] = useState(false)
  const longRunningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 重複した filename を 4 秒間 banner 表示するための transient state。
  const [duplicateWarnings, setDuplicateWarnings] = useState<string[]>([])
  const duplicateClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // entry 削除時に object URL を必ず revoke (memory leak 防止)。
  // 重複警告の transient timer と longRunning timer も unmount で確実 clear
  // (stale fire 防止)。
  useEffect(() => {
    return () => {
      for (const e of entries) {
        if (e.kind === 'image' && 'thumbUrl' in e && e.thumbUrl) URL.revokeObjectURL(e.thumbUrl)
      }
      if (duplicateClearTimerRef.current) {
        clearTimeout(duplicateClearTimerRef.current)
        duplicateClearTimerRef.current = null
      }
      if (longRunningTimerRef.current) {
        clearTimeout(longRunningTimerRef.current)
        longRunningTimerRef.current = null
      }
    }
    // entries 依存 ではなく unmount のみ cleanup (removeEntry で個別 revoke 済)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // OCR submitting 中 かつ longRunning でないときのみ、タブ閉じる / リロード /
  // ブラウザ戻る を block。
  // S1.9.3: 90 秒経過後 (longRunning=true) は「もう閉じても大丈夫」とユーザーに
  // 案内するため、 ガードを解除する。 banner 文言も同タイミングで切替わる。
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
    if (!isSubmitting || longRunning) return

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
  }, [isSubmitting, longRunning])

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
  // S1.9.3: client 側 90 秒 timeout (error 化) を廃止。 Vercel Pro 昇格で
  // server maxDuration=600s に延長されたため、 client は server の完走をそのまま
  // 待つ方針に変更。 代わりに 90 秒経過後は longRunning=true にして banner 文言を
  // 「閉じてよい」 旨に切替え、 離脱ガードも解除する。 spinner は submitting 中
  // ずっと表示し続ける。
  // processUpload が throw (504 / network error 等) した場合は catch で 'OTHER'
  // error にして「試験一覧で確認を」 と案内する。 server 側では source_document が
  // 作成済みの場合もあるため、 無条件に retry 誘導しない文言にする。
  async function runProcess() {
    const fd = buildFormData()

    // 90 秒経過したら longRunning=true にして banner / 離脱ガードを切替える。
    // submitting が終わる (成功 / 失敗 / throw) 時点でタイマーを clear する。
    longRunningTimerRef.current = setTimeout(() => {
      setLongRunning(true)
    }, 90_000)

    let result
    try {
      result = await processUpload(fd)
    } catch {
      // 504 / network error 等、 server action が throw した場合。
      // server 側で source_document が作成されている可能性があるため、
      // 無条件再試行でなく「試験一覧で確認を」と案内する。
      // hideRetryHint=true: このエラーメッセージは再試行を推奨しないため、
      // 「ファイルを変更して再試行」サブタイトルを非表示にする (Fix 2)。
      setLongRunning(false)
      setPhase({
        kind: 'error',
        code: 'OTHER',
        message:
          '処理状況を確認できませんでした。「試験一覧」で結果をご確認ください。',
        hideRetryHint: true,
      })
      return
    } finally {
      // 成功・失敗どちらでも longRunning タイマーは不要になるので clear する。
      // catch ブロック内で既に return した後でも finally は実行されるが、
      // 二重 clear は無害。 setLongRunning(false) はここでは呼ばない:
      // 成功時は router.push で遷移するため state は破棄され不要、かつ
      // 90 秒後に longRunning=true になっていた場合に成功 → 「閉じないで」
      // 文言に逆戻りするフラッシュを避ける (Fix 1)。
      if (longRunningTimerRef.current) {
        clearTimeout(longRunningTimerRef.current)
        longRunningTimerRef.current = null
      }
    }

    if (result.ok && result.data) {
      // S1.9.2: OCR 成功 → result page に遷移。 phase は 'submitting' のまま
      // にして navigation 完了まで spinner を出す (success phase は廃止)。
      // setLongRunning(false) は不要: component は router.push で破棄される。
      router.push(`/app/upload/result/${result.data.sourceDocumentId}`)
    } else if (!result.ok) {
      setLongRunning(false)
      setPhase({
        kind: 'error',
        message: result.error,
        code: result.code,
        details: result.details,
        // UPLOAD_IN_PROGRESS はファイルの問題ではなく「並列 OCR 実行中」という
        // 状態エラーなので、「ファイルを変更して再試行」サブタイトルは誤誘導になる。
        // 他の error code (QUOTA_EXCEEDED / GEMINI_FAILED 等) は retry hint を出す。
        hideRetryHint: result.code === 'UPLOAD_IN_PROGRESS',
      })
    } else {
      setLongRunning(false)
      setPhase({
        kind: 'error',
        message: '予期しないエラー',
        code: 'OTHER',
      })
    }
  }

  // handleSubmit の方針:
  //   1. phase 切替を **urgent priority** で行う (startTransition で wrap しない)
  //   2. 非同期処理は IIFE / 直 await で投げ捨て、 await 後の setPhase は urgent
  //   3. これにより React 19 の concurrent renderer が「submitting」 を必ず commit
  //      する (S1a 後の staging smoke で発覚した bug の回避)

  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    // 新しい submit は必ず longRunning=false から開始する。
    // (前回の submit で longRunning=true になっていた場合の防御的リセット)
    setLongRunning(false)
    setPhase({ kind: 'submitting' })
    void runProcess()
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
        // amber 警告色 + alert role に格上げ。 amber は result page
        // (result-actions.tsx) の破棄注意 banner と統一感を持たせる。
        // S1.9.3: 90 秒経過 (longRunning=true) で「もう閉じても大丈夫」旨に切替え。
        // それまでは「閉じないでください」の従来文言を維持する。
        <section
          role="alert"
          aria-live="assertive"
          className="rounded-md bg-amber-50 border border-amber-400 p-4 flex items-start gap-3"
        >
          <Loader2 className="h-5 w-5 animate-spin text-amber-700 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="text-sm text-amber-900">
            {longRunning ? (
              <>
                <p className="font-semibold">AI が問題を抽出しています。通常より時間がかかっています。</p>
                <p className="mt-1">
                  このまま閉じても、後で「試験一覧」から抽出結果を確認できます。
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">AI が問題を抽出しています… (30 秒〜数分かかります)</p>
                <p className="mt-1">
                  ⚠ この画面を閉じたり戻ったりしないでください。 中断しても AI 抽出の利用枠は消費されます。
                </p>
              </>
            )}
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
          {/* hideRetryHint=true (throw/catch 経由) のときは再試行サブタイトルを
              非表示: メッセージが「試験一覧で確認を」なのに「再試行を」と
              矛盾しないようにするため (Fix 2) */}
          {!phase.hideRetryHint && (
            <p className="text-xs text-slate-700">
              ファイルを変更して再度お試しください。
            </p>
          )}
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

// 開発用 (staging / preview / dev) のみで render される詳細エラー section。
// production では呼び出し側で render されない (`process.env.NEXT_PUBLIC_VERCEL_ENV`
// 判定)。 ユーザー文言と独立に code / source_document_id / cost / model_chain /
// rawError を expose し、 OT が画面だけで原因切り分け可能にする。
function ErrorDetails({
  code,
  message,
  details,
}: {
  code: ProcessUploadErrorCode
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
