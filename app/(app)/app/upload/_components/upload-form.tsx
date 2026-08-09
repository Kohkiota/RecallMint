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
  DOC_STATUS_POLL_INTERVAL_MS,
  DOC_STATUS_POLL_LIMIT_MS,
  DOC_STATUS_POLL_MAX_FETCH_FAILURES,
  MAX_IMAGE_FILE_MB,
  MAX_IMAGE_WIDTH_OR_HEIGHT,
  MAX_PDF_BYTES,
  MB,
  PDF_PUT_TIMEOUT_MS,
  TOTAL_UPLOAD_LIMIT_BYTES,
  TOTAL_UPLOAD_LIMIT_MB,
  UPLOAD_INTERRUPTED_NOTICE,
  UPLOAD_PENDING_NOTICE,
} from '../_lib/constants'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { reservePdfUploadUrls } from '../_actions/reserve-pdf-upload'
import { finalizePdfSource } from '../_actions/finalize-pdf-source'
import { deletePdfSource } from '../_actions/delete-pdf-source'
import { partitionByDuplicateFilename } from '../_lib/dedupe-filenames'
import {
  type ProcessUploadErrorCode,
  type ProcessUploadErrorDetails,
} from '../_lib/upload-error-types'
import { requestOcrPoll } from '@/lib/exams/ocr-poll-signal'
// ②-4a 単一 invocation Sprint Task S-3: 呼出列(prepare→reserve→PUT→finalize→claim→
// stage→publish)を **submitUpload 1 本**へ差し替える。 client は画像バイトを FormData で
// 1 回だけ送り、server が同一 invocation で OCR→crop→publish まで完了させる
// (spec 2026-08-04 §2)。 旧 action file 群は S-5 で撤去するまで残置(呼出のみ削除)。
//
// Task S-4: server は sync tx の直後に応答し、本処理は `after()` で走る。 ゆえに
// `accepted` は「受け付けた」以上の意味を持たない — 完了 / 失敗の検知は
// /api/exams/status の `docStatuses` を poll して行う(spec 2026-08-04 §5)。
import { submitUpload } from '../_actions/submit-upload'

// 投入先選択 state:
//  - null: 未選択 (submit disable)
//  - { mode: 'new' }: 新規 exam として保存 (仮 name は server side で確定)
//  - { mode: 'existing', examId }: 既存 exam (examId 必須)
//  - exam が 0 件のときは server side で「new」 固定として描画する
export type Destination =
  | null
  | { mode: 'new' }
  | { mode: 'existing'; examId: string }

// 個別 file の処理状態。
// image: 'processing' = 圧縮中、 'ready' = 投入可、 'error' = 解析失敗で使用不可
//   (**従来どおり**・spec D5)。
// pdf: 'uploading'(presign → R2 直 PUT 中)→ 'counting'(finalizePdfSource 往復中)
//   → 'ready'(pageCount 確定)/ 'error'(PUT 失敗 / 0 ページ / 40 超 / parse 失敗)。
// pdf の fileId は `id` を再利用する(reserve/finalize action へそのまま渡す・
// uuid v4 は handleAdd の generateId() が発行)。
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
  | { id: string; kind: 'pdf'; file: File; originalSize: number; status: 'uploading' }
  | { id: string; kind: 'pdf'; file: File; originalSize: number; status: 'counting' }
  | { id: string; kind: 'pdf'; file: File; pageCount: number; originalSize: number; status: 'ready' }
  | { id: string; kind: 'pdf'; file: File; originalSize: number; status: 'error'; error: string }

// submit payload の PDF 側は R2 直 PUT 済のためバイトを運ばない — fileId(=entry id)
// と echo 用のメタデータだけを選択順で送る(T7 が消費)。画像は従来どおり FormData の
// `files` を fileIndex で指す(orderManifest 自体は画像バイトを運ばない)。
type OrderManifestEntry =
  | { kind: 'image'; fileIndex: number }
  | { kind: 'pdf'; fileId: string; filename: string; pageCount: number; declaredBytes: number }

// ②-4b §1(design spec 2026-08-09 §2.2): PDF entry の R2 staging 所在(どの session
// namespace に object があるか)と continuation の飛行状態。
type PdfSourceRecord = { uploadSessionId: string; inFlight: boolean }

// entry id(= pdf の fileId)/ uploadSessionId / idempotencyKey の生成。
// crypto.randomUUID 非対応環境向けの fallback を含む既存 idiom(3 箇所で使うため
// 関数化・rule of three)。
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Codex fix round 5(P2-②): crypto.randomUUID 非対応環境向け fallback。 r5 以降
  // uploadSessionId / fileId は reserve/finalize で `z.uuid({ version: 'v4' })`
  // 検証されるため、旧 `${Date.now()}-${Math.random()}` は形式不一致で常に
  // invalid_input になっていた(idempotencyKey は server 側で「≤256 文字の文字列」
  // としか検証されないため r5 以前は無害だったが、uuid 検証 field へ流用された
  // ことで欠陥になった)。 実際の UUID v4 を生成するよう修正する — PDF 経路を
  // 「crypto.randomUUID 必須」として無効化する案(実装判断の一方)も検討したが、
  // fallback 自体を正しくする方が該当環境でも機能が使え続けて losslessy(採用理由)。
  // crypto.getRandomValues があれば暗号論的乱数を使い、無ければ Math.random に
  // フォールバックする(いずれも version=4/variant=10 bit を明示的に立てる)。
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

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

// phase: 'idle' = ファイル選択中 / 'submitting' = 受付 + 完了待ち (submitUpload 呼出中
// および docStatuses poll 中) / 'error' = エラー表示中。
// S1.9.2: 'success' phase を廃止。 OCR 成功時は preview を同 component で描画せず、
// 独立 route /app/upload/result/[sourceDocumentId] に router.push で遷移する
// (Bug B = 残量 banner stale 表示の構造解消、 page 遷移で fresh server render)。
// S1.9.3: 'CLIENT_TIMEOUT' を廃止。 Vercel Pro 昇格で server maxDuration=800s に
// 延長されたため、 client は server の完走をそのまま待つ方針に変更。
// S-4: 'submitting' は「server の完走を待つ」ではなく「poll で完了を待つ」に意味が
// 変わった(処理は after() で走っており、このタブが閉じても進む)。
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
  // 派生 flag: 受付 + 完了待ちの最中。 UI controls の disable 判定に集約利用。
  const isSubmitting = phase.kind === 'submitting'
  // 重複した filename を 4 秒間 banner 表示するための transient state。
  const [duplicateWarnings, setDuplicateWarnings] = useState<string[]>([])
  const duplicateClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // unmount 後に poll ループを回し続けない(最長 DOC_STATUS_POLL_LIMIT_MS ぶんの
  // fetch が page 離脱後も残るのを防ぐ)。
  const mountedRef = useRef(true)
  // uploadSessionId(spec r5 §3.1/§3.2・R2 namespace の同一性)。 idempotencyKey
  // (submit 試行の同一性)とは別の値 — 両者は要求が逆向き(retry で idempotencyKey は
  // 必ず新規発行 / uploadSessionId は維持したい)であり、r4 までは 1 値で兼ねていた
  // のが実装中に発見された spec の穴だった(r5 で分離)。 null = 現在有効な session
  // が無い(画像のみ / まだ PDF を 1 件も presign していない / 前回 submit で
  // 消費・無効化済み)。 生存範囲(spec §3.2 の表・server outcome で決まる):
  //   維持 — 新規 operation を作らないことが確定した outcome(in_progress /
  //     invalid_input / exam_not_found / daily_limit_exceeded / unauthenticated)。
  //     object をそのまま再利用でき、再 upload させない。
  //   無効化 — accepted(replayed 含む)/ throw・応答不明(runProcess で判定)。
  //   終了 — entries が空になった時点(removeEntry)。 ②-4b §1 以降、staging object は
  //     削除時に best-effort DELETE 済みで、回収に失敗した残骸だけを lifecycle が拾う。
  const uploadSessionIdRef = useRef<string | null>(null)
  // entry ごとの generation token(Codex I11: stale 応答排除)。 entry 作成時に
  // 発行し、削除時に revoke する。 PUT / finalize の非同期応答は、書込直前に
  // 自分の token がまだ有効か確認してから setEntries する — 削除済み entry への
  // 旧応答が state を書き戻すのを防ぐ。
  const generationRef = useRef<Map<string, number>>(new Map())
  // ②-4b §1(spec §2.2): entry 削除時に「その object がどの session に居るか」と
  // 「continuation が飛行中か(= 削除主体は continuation 側か)」を引くための registry。
  // status(uploading / counting)で飛行判定しないのは、continuation 完了 →
  // re-render の 1 commit 窓で × を押されると status は「飛行中」と誤読し、誰も
  // DELETE しない orphan になるため — ref なら checkpoint → 解除が JS 単一 thread 上で
  // 原子的に連続し、この窓がない。
  const pdfSourceRef = useRef<Map<string, PdfSourceRecord>>(new Map())

  // entry 削除時に object URL を必ず revoke (memory leak 防止)。
  // 重複警告の transient timer も unmount で確実 clear (stale fire 防止)。
  useEffect(() => {
    // **effect 本体で必ず true に戻す**(`components/media/use-image-zoom.ts` と同型)。
    // cleanup でしか false→true を戻さないと、StrictMode(next.config.ts の
    // `reactStrictMode: true`)の dev 二重実行 setup→cleanup→setup で ref が false の
    // まま固定され、poll が最初の周期で 'aborted' を返して spinner が出たまま
    // auto-nav も失敗表示も起きなくなる(production build では二重実行しないため
    // stg smoke に出ず、ローカル開発でだけ新 flow が丸ごと死ぬ出方をする)。
    mountedRef.current = true
    return () => {
      mountedRef.current = false
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

  // S-4: **離脱ガード(beforeunload / popstate sentinel)を撤去した**。
  // あれは「処理が request 内で走っていた時代」の遺物 — 当時は離脱 = invocation
  // 打ち切りで抽出結果が失われうるという前提があった。 S-4 で本処理は `after()`
  // (応答後の server 側実行)へ移り、タブを閉じても処理は完走して結果は試験一覧に
  // 出る。 ガードを残すと「閉じても大丈夫」という設計と UI が矛盾し、 実害
  // (S-3 stg smoke: 同一タブで result へ遷移すると確認 dialog + 60 秒待ち)も出る。
  // 90 秒でガードを外す longRunning の分岐も同じ理由で消えた(切替える対象が無い)。

  const totalBytes = entries.reduce((s, e) => s + e.file.size, 0)
  // TOTAL_UPLOAD_LIMIT_BYTES は submitUpload の FormData body 上限 — PDF は R2 直 PUT
  // で body を経由しない(バイトは orderManifest に載らない)ため、判定は画像 entry
  // のみで行う(全 entry 込みで判定すると PDF 追加だけで誤ってブロックされる)。
  const totalImageBytes = entries.reduce(
    (s, e) => (e.kind === 'image' ? s + e.file.size : s),
    0,
  )
  const totalExceeded = totalImageBytes > TOTAL_UPLOAD_LIMIT_BYTES
  // 「処理中」集合(spec D5): image の 'processing' に加え、 pdf の
  // 'uploading' / 'counting' も含める(送信ゲートは既存構造のまま・変えるのは表示)。
  const anyProcessing = entries.some(
    (e) => e.status === 'processing' || e.status === 'uploading' || e.status === 'counting',
  )
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
  // OCR pipeline の 1 リクエスト上限 (plan-limits とは独立した別軸)。
  // 超過時はファイルを分割して投入するよう案内する。
  const overPageCap = totalRequestedPages > OCR_MAX_PAGES

  // 合計ページの 3 状態表示(spec D5): 処理中の PDF が 1 つでもあれば数値でなく
  // 「未確定」を明示する(処理中は totalRequestedPages がゼロ加算で少なく見える
  // 部分和になるため、確定した N と誤読させない)。
  const pageSummaryText = anyProcessing
    ? '合計未確定'
    : overPageCap
      ? `合計 ${totalRequestedPages} ページ・超過`
      : `合計 ${totalRequestedPages} ページ`

  const submitDisabled =
    entries.length === 0 ||
    anyProcessing ||
    anyError ||
    totalExceeded ||
    !destinationReady ||
    overQuota ||
    alreadyAtQuota ||
    overPageCap

  async function processImage(file: File, id: string) {
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: MAX_IMAGE_FILE_MB,
        maxWidthOrHeight: MAX_IMAGE_WIDTH_OR_HEIGHT,
        useWebWorker: true,
        // 出力 mime を webp に固定する。 未指定だと browser-image-compression は
        // 入力 file.type をそのまま出力 mime にするため、 HEIC(UI は「HEIC」と案内)
        // や GIF 等は submitUpload の magic-byte 検証(image/webp|png|jpeg のみ)で
        // invalid_input になる。 lib/media/upload.ts の COMPRESSION_OPTIONS と同値。
        fileType: 'image/webp',
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

  // generation token を確認してから setEntries する共通 helper(Codex I11)。
  // 呼出時点で token が一致しなければ(entry 削除済み)何も書かない。
  function writeEntry(id: string, generation: number, updater: (prev: FileEntry) => FileEntry) {
    if (generationRef.current.get(id) !== generation) return
    setEntries((prev) => prev.map((e) => (e.id === id ? updater(e) : e)))
  }

  function pdfErrorEntry(id: string, file: File, error: string): FileEntry {
    return { id, kind: 'pdf', file, originalSize: file.size, status: 'error', error }
  }

  // reserve 後続き: 直 PUT(browser→R2)→ finalize(完了通知・pageCount 確定)。
  // reserve はバッチ単位で呼出元(reservePdfBatch)がまとめて完了させるため、
  // ここは uploadUrl を受け取ってから始まる。
  //
  // ②-4b §1(spec §2.1): 飛行中に entry が削除された(= generation が revoke された)
  // ことを各 checkpoint で検知したら、以後の工程を打ち切って **自分が PUT した object を
  // 自分で DELETE** する。 飛行中は removeEntry 側が撃たない(spec §2 の削除主体一意化)
  // ため、この経路が唯一の回収者になる。
  async function continuePdfUpload(
    file: File,
    id: string,
    generation: number,
    uploadSessionId: string,
    uploadUrl: string,
    rec: PdfSourceRecord,
  ) {
    // registry の掃除は「自分が登録した record が今も現役」の時だけ行う(identity
    // guard): retry 等で別 record に差し替わっていたら、その id の削除主体は新しい
    // continuation であり、ここで消すと registry から所在が失われる。
    const releaseRegistry = () => {
      if (pdfSourceRef.current.get(id) === rec) pdfSourceRef.current.delete(id)
    }
    try {
      // checkpoint 1(spec §2.1-1): PUT 前に無効化済みなら object を作らないので
      // DELETE は不要。 判定と registry 解除の間に await を置かない — 置くとその窓で
      // removeEntry が「非飛行」を見て二重の削除主体になる(spec §5-1)。
      if (generationRef.current.get(id) !== generation) {
        releaseRegistry()
        return
      }
      // 直 PUT(browser → R2)。 lib/media/upload.ts の画像直 PUT saga と同型
      // (mode/credentials/redirect/timeout)。 署名済み URL への PUT ゆえ cookie 不要。
      let putOk = false
      try {
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': 'application/pdf' },
          mode: 'cors',
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(PDF_PUT_TIMEOUT_MS),
        })
        putOk = put.ok
      } catch {
        putOk = false
      }
      // checkpoint 2(spec §2.1-2): **putOk 不問**で DELETE する — client timeout
      // (AbortSignal.timeout)後に R2 側で着地している可能性があり(uncertain outcome)、
      // DELETE は 404 = 成功系ゆえ無条件化のコストがない。 判定 → DELETE → registry 解除
      // の間に await を挟まない(挟むと解除前の窓で removeEntry も撃てる・spec §5-1)。
      if (generationRef.current.get(id) !== generation) {
        void deletePdfSource({ uploadSessionId, fileId: id }).catch(() => {})
        releaseRegistry()
        return
      }
      if (!putOk) {
        writeEntry(id, generation, () => pdfErrorEntry(id, file, 'PDF のアップロードに失敗しました'))
        return
      }

      writeEntry(id, generation, (prev) =>
        prev.kind === 'pdf'
          ? { id, kind: 'pdf' as const, file, originalSize: file.size, status: 'counting' as const }
          : prev,
      )

      try {
        const finalized = await finalizePdfSource({
          uploadSessionId,
          fileId: id,
          declaredBytes: file.size,
        })
        // checkpoint 3(spec §2.1-3): 無効なら state は書かず DELETE だけ撃つ
        // (reject 経路は server 側が削除済 → 404 no-op ゆえ、成否で分岐しない一様規則)。
        // ここも判定 → DELETE → registry 解除の間に await を挟まない(spec §5-1)。
        if (generationRef.current.get(id) !== generation) {
          void deletePdfSource({ uploadSessionId, fileId: id }).catch(() => {})
          releaseRegistry()
          return
        }
        if (!finalized.ok) {
          writeEntry(id, generation, () => pdfErrorEntry(id, file, finalized.error))
          return
        }
        const pageCount = finalized.data?.pageCount
        if (pageCount === undefined) {
          writeEntry(id, generation, () => pdfErrorEntry(id, file, 'PDF の検証に失敗しました'))
          return
        }
        writeEntry(id, generation, () => ({
          id,
          kind: 'pdf' as const,
          file,
          pageCount,
          originalSize: file.size,
          status: 'ready' as const,
        }))
      } catch (err) {
        // checkpoint 3(catch 節先頭・spec §2.1-3): finalize throw でも回収経路は同じ。
        // 判定 → DELETE → registry 解除の間に await を挟まない(spec §5-1)。
        if (generationRef.current.get(id) !== generation) {
          void deletePdfSource({ uploadSessionId, fileId: id }).catch(() => {})
          releaseRegistry()
          return
        }
        writeEntry(id, generation, () =>
          pdfErrorEntry(id, file, err instanceof Error ? err.message : 'PDF の検証に失敗しました'),
        )
      }
    } finally {
      // 全終了経路(throw 含む)で必ず飛行フラグを落とす(spec §5-1): 漏れると
      // その entry が「永遠に飛行中」に見えて誰も DELETE しない orphan になる。
      rec.inFlight = false
    }
  }

  // reserve を **バッチ単位**でまとめて 1 回呼び(canonical review Important 2
  // fix)、成功した file だけ PUT+finalize(continuePdfUpload)へ進める。
  // sessionFiles = この reserve 呼出の Σ declaredBytes 検証に使う全体集合
  // (呼出元が「既存アクティブ分」を含めるかどうかを決める)。 toUpload = 実際に
  // PUT+finalize を実行する対象(sessionFiles の部分集合、または同一)。 1 file
  // ずつ presign すると個々が必ず ≤ MAX_PDF_BYTES(50MB)以下になり、
  // reserve-pdf-upload.ts の Σ declaredBytes ≤ MAX_PDF_TOTAL_BYTES(200MB)判定
  // (spec D7)が構造的に発火しないため、呼出元で常にまとめる。
  async function reservePdfBatch(
    sessionFiles: { fileId: string; declaredBytes: number }[],
    toUpload: { file: File; id: string; generation: number }[],
    uploadSessionId: string,
  ) {
    if (toUpload.length === 0) return
    let reserved: Awaited<ReturnType<typeof reservePdfUploadUrls>>
    try {
      reserved = await reservePdfUploadUrls({ uploadSessionId, files: sessionFiles })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'アップロードURLの発行に失敗しました'
      for (const f of toUpload) {
        writeEntry(f.id, f.generation, () => pdfErrorEntry(f.id, f.file, message))
      }
      return
    }
    if (!reserved.ok) {
      for (const f of toUpload) {
        writeEntry(f.id, f.generation, () => pdfErrorEntry(f.id, f.file, reserved.error))
      }
      return
    }

    for (const f of toUpload) {
      // ActionResult.data は型上 optional(action の成功時は必ず設定されるが、
      // TS 上は undefined を許すため防御的に確認する)。
      const entry = reserved.data?.find((d) => d.fileId === f.id)
      if (!entry) {
        writeEntry(f.id, f.generation, () =>
          pdfErrorEntry(f.id, f.file, 'アップロードURLの発行に失敗しました'),
        )
        continue
      }
      // ②-4b §1(spec §2.2): registry 登録は continuation の dispatch と同一同期区間で
      // 行う(間に await が入ると「object を作りにいくのに registry に居ない」窓ができ、
      // その窓の removeEntry が所在を知らないまま orphan を残す)。 record object 自体を
      // continuation へ渡し、以後の registry 操作は identity 比較で自分の登録に限定する
      // (retryPdfSession も同じ loop を通るため、retry では新 record が上書きする)。
      const rec: PdfSourceRecord = { uploadSessionId, inFlight: true }
      pdfSourceRef.current.set(f.id, rec)
      void continuePdfUpload(f.file, f.id, f.generation, uploadSessionId, entry.uploadUrl, rec)
    }
  }

  // PDF batch flow(spec D5 / §2 / §3.1): handleAdd で新規追加された PDF 群を
  // 1 回の reserve にまとめる。 このバッチには「既存のアクティブ(非 error)な
  // PDF entry」も declaredBytes ぶん含める(自分は再アップロードしない・再 PUT
  // はしない — Σ が既存分を含むことが要件)。 失敗すれば **この呼出で新規追加した
  // PDF だけ** を error にする(既存の進行中 entry はこの呼出の失敗に巻き込まない)。
  async function processPdfBatch(
    newFiles: { file: File; id: string; generation: number }[],
  ) {
    if (newFiles.length === 0) return
    // uploadSessionId: 最初の presign 要求時に発行し、以後同 session の全 PDF が
    // 使い回す(spec D5 / §3.1)。 submit 試行の同一性(idempotencyKey)とは
    // 独立 — session の無効化/維持は runProcess が server outcome から判定する
    // (§3.2)。
    if (uploadSessionIdRef.current === null) {
      uploadSessionIdRef.current = generateId()
    }
    const uploadSessionId = uploadSessionIdRef.current

    const existingActive = entries.filter(
      (e): e is Extract<FileEntry, { kind: 'pdf' }> => e.kind === 'pdf' && e.status !== 'error',
    )
    const sessionFiles = [
      ...existingActive.map((e) => ({ fileId: e.id, declaredBytes: e.file.size })),
      ...newFiles.map((f) => ({ fileId: f.id, declaredBytes: f.file.size })),
    ]

    await reservePdfBatch(sessionFiles, newFiles, uploadSessionId)
  }

  // D5 point 5(terminal 失敗後の再試行): submit が accepted された時点で
  // uploadSessionId は既に無効化されている(spec §3.2「accepted は消費済み」)。
  // 完了通知が failed(terminal 失敗)を返すと、server 側の全出口 DELETE
  // (spec §6 本線 2)で旧 session の R2 object も削除される — この時点で
  // `ready` の PDF entry を `uploading` へ戻し、**新 session**で
  // reserve→PUT→finalize をやり直しておく(counting を経て ready へ復帰)。
  // これが無いと、次の submit クリック時に新 namespace へ object が存在しない
  // まま送信され、T7 の HEAD 検証で落ちる。 fire-and-forget(runProcess の
  // 'failed' 分岐から呼ぶ・失敗表示自体はブロックしない)。
  async function retryPdfSession() {
    const readyPdfs = entries.filter(
      (e): e is Extract<FileEntry, { kind: 'pdf'; status: 'ready' }> =>
        e.kind === 'pdf' && e.status === 'ready',
    )
    if (readyPdfs.length === 0) return

    const retryFiles = readyPdfs.map((e) => {
      const generation = (generationRef.current.get(e.id) ?? 0) + 1
      generationRef.current.set(e.id, generation)
      return { file: e.file, id: e.id, generation }
    })
    setEntries((prev) =>
      prev.map((e) => {
        const match = retryFiles.find((f) => f.id === e.id)
        return match
          ? {
              id: e.id,
              kind: 'pdf' as const,
              file: match.file,
              originalSize: match.file.size,
              status: 'uploading' as const,
            }
          : e
      }),
    )

    if (uploadSessionIdRef.current === null) {
      uploadSessionIdRef.current = generateId()
    }
    const uploadSessionId = uploadSessionIdRef.current
    const sessionFiles = retryFiles.map((f) => ({
      fileId: f.id,
      declaredBytes: f.file.size,
    }))
    await reservePdfBatch(sessionFiles, retryFiles, uploadSessionId)
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
    // このバッチ(1 回の handleAdd 呼出)で新規追加された PDF は 1 回の
    // reservePdfUploadUrls にまとめて渡す(Important 2 fix・processPdfBatch)。
    const newPdfFiles: { file: File; id: string; generation: number }[] = []
    for (const file of unique) {
      const id = generateId()
      if (file.type === 'application/pdf') {
        // 新規 id ゆえ generation は常に 1 から開始(id は generateId() が毎回
        // 発行する乱数、再利用しない)。
        const generation = 1
        generationRef.current.set(id, generation)
        newEntries.push({
          id,
          kind: 'pdf',
          file,
          originalSize: file.size,
          status: 'uploading',
        })
        newPdfFiles.push({ file, id, generation })
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
    if (newPdfFiles.length > 0) void processPdfBatch(newPdfFiles)
    // input value を reset、 同じ file 連続選択でも change が発火するように
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeEntry(id: string) {
    // generation token を revoke(Codex I11): 削除後に届く旧 PUT / finalize 応答は
    // writeEntry の token 比較で弾かれ、state を書き戻せなくなる。
    generationRef.current.delete(id)
    // ②-4b §1(spec §2.3): 非飛行(ready / error)の PDF は removeEntry が削除主体。
    // 飛行中は continuation が checkpoint で自分の object を回収するため撃たない
    // (削除主体の一意性・spec §5-3)。 登録なし(image / reserve 前・reserve 失敗)は
    // R2 に object が無いので何もしない。 revoke → 飛行判定 → DELETE → registry 解除の
    // 間に await を挟まない — 挟むとその窓で continuation の checkpoint と両方が撃つ
    // (= 一意性が崩れる)(spec §5-1)。
    const rec = pdfSourceRef.current.get(id)
    if (rec && !rec.inFlight) {
      void deletePdfSource({ uploadSessionId: rec.uploadSessionId, fileId: id }).catch(() => {})
      pdfSourceRef.current.delete(id)
    }
    setEntries((prev) => {
      const target = prev.find((e) => e.id === id)
      if (target && target.kind === 'image' && 'thumbUrl' in target && target.thumbUrl) {
        URL.revokeObjectURL(target.thumbUrl)
      }
      const next = prev.filter((e) => e.id !== id)
      // entries が空になったら uploadSessionId も畳む(D5 point 4「終了」)。
      // ②-4b §1 以降、staging object は削除時に best-effort DELETE 済み(上の registry
      // 分岐 / continuation の checkpoint)— 回収に失敗した残骸だけを lifecycle が拾う。
      if (next.length === 0) {
        uploadSessionIdRef.current = null
      }
      return next
    })
  }

  // エラー表示の共通 helper。 hideRetryHint は元の legacy action 経路
  // (旧 runProcess の `!result.ok` 分岐)と同じ導出規則を維持する — UPLOAD_IN_PROGRESS
  // は「並列 OCR 実行中」という状態エラーなので「ファイルを変更して再試行」が誤誘導に
  // なるため隠す。 PAGE_LIMIT_EXCEEDED は新 flow では発生しない outcome だが、 コード自体は
  // ProcessUploadErrorCode に残っているため条件はそのまま維持する(規約変更なし)。
  function setError(
    code: ProcessUploadErrorCode,
    message: string,
    details?: ProcessUploadErrorDetails,
  ) {
    setPhase({
      kind: 'error',
      code,
      message,
      details,
      hideRetryHint: code === 'UPLOAD_IN_PROGRESS' || code === 'PAGE_LIMIT_EXCEEDED',
    })
  }

  // Codex fix round 5(P2-①): `accepted` を受けた後、form を再操作可能な状態
  // (= error phase で submit ボタンが再有効化される)へ戻す**全ての出口**で
  // 必ず通す共通 helper。 `accepted` 受信時点で uploadSessionId は既に
  // 無効化済み(このファイル内 `if (result.outcome === 'accepted')`)なので、
  // ready な PDF entry を再アップロードしておかないと次の submit が空
  // uploadSessionId を送って必ず invalid_input になる(D5 point 5 と同じクラス
  // の穴)。 出口ごとに個別に `retryPdfSession()` を呼ぶと今後の分岐追加で
  // 取りこぼすため、`accepted` 分岐内で「表示して抜ける」箇所はこの helper
  // 経由に統一する(sourceDocumentId 空 / failed / degraded の 3 箇所)。
  // `completed`(router.push で離脱)と `aborted`(unmount)は form を再操作
  // 可能にしないため対象外。
  function setErrorAfterAccepted(phase: Extract<Phase, { kind: 'error' }>) {
    void retryPdfSession()
    setPhase(phase)
  }

  // runProcess は phase 切替を行わない (caller が setPhase('submitting') を
  // **urgent priority** で先に撃つ責務を持つ)。 ここで setPhase を呼ぶと
  // 「submitting 」 が transition priority 化して React 19 のバッチング判定で
  // skip される (S1a 後の staging smoke で発覚した bug、 詳細は handoff doc)。
  //
  // S1.9.3: client 側 90 秒 timeout (error 化) を廃止。 client は server の完走を
  // そのまま待つ方針に変更。
  //
  // ②-4a 単一 invocation Sprint Task S-3(2026-08-05): 呼出列を `submitUpload` 1 本へ
  // 差し替える。 呼出 = 圧縮(既存・client)→ FormData(idempotencyKey / mode / examId /
  // files)→ submitUpload。
  //
  // Task S-4: server は sync tx 直後に `accepted` を返し、本処理は `after()` で走る。
  // ゆえに client は **`accepted` で result page へ push しない** — push すると
  // 「⏳ まだ処理中です」の page に着地するだけで、完了しても自動で更新されない。
  // 代わりに自分の source_document を poll し、`completed` で初めて遷移する。
  //
  // **client は operation を終端化しない**(S-1 申し送り): 新経路の operation は
  // server 側 pipeline が失敗も含めて必ず終端化する。 client 発の abandon(旧 案 D)は
  // fencing token(lease_version)を client に往復させる前提だったが、 新経路はそれを
  // 廃止した(spec §4.3)ため成立しない。 ゆえに失敗表示は「表示するだけ」。
  //
  // ②-4a は画像入稿のみ(PDF rasterize は ②-4b・spec 冒頭)。 PDF が 1 件でも混在すると
  // server 側の入力検証で全体が弾かれるため、 送信前に明示ブロックして理由を出す。
  // 自分の source_document 1 件の完了 / 失敗を poll する(spec 2026-08-04 §5)。
  // 戻り値: 'completed' / 'failed' / 'degraded'(判定不能のまま打ち切り)/
  // 'aborted'(unmount — 呼出側は何も表示しない)。
  //
  // 縮退は 2 条件(どちらも「無限 poll を作らない」ため):
  //   ① 連続 fetch 失敗が DOC_STATUS_POLL_MAX_FETCH_FAILURES 回
  //   ② 開始からの経過が DOC_STATUS_POLL_LIMIT_MS(絶対上限)
  // ② が要るのは、endpoint が正常に応答しつつ `processing` を返し続ける
  // hard-death(after() の callback が platform kill された)ケースがあるため —
  // ①(fetch 失敗)だけでは永久に止まらない。
  async function pollDocStatus(
    sourceDocumentId: string,
  ): Promise<'completed' | 'failed' | 'degraded' | 'aborted'> {
    const startedAt = Date.now()
    let consecutiveFailures = 0
    for (;;) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, DOC_STATUS_POLL_INTERVAL_MS),
      )
      if (!mountedRef.current) return 'aborted'
      if (Date.now() - startedAt >= DOC_STATUS_POLL_LIMIT_MS) return 'degraded'
      try {
        // 自分の doc を **名指しで**問い合わせる(fix round 2 / Codex P2)。 endpoint の
        // 既定 map は exam ごと最新 1 件に縮約されるため、同じ exam に 2 件目の upload が
        // 入ると自分の doc が落ちる — 落ちた key を「まだ処理中」と読んで絶対上限まで
        // 待たされるのを防ぐ。
        const res = await fetch(
          `/api/exams/status?doc=${encodeURIComponent(sourceDocumentId)}`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`status ${res.status}`)
        const body: unknown = await res.json()
        consecutiveFailures = 0
        const docStatuses =
          typeof body === 'object' && body !== null && 'docStatuses' in body
            ? (body as { docStatuses?: Record<string, string> }).docStatuses
            : undefined
        const status = docStatuses?.[sourceDocumentId]
        if (status === 'completed') return 'completed'
        if (status === 'failed') return 'failed'
        // 'processing' / key 不在(まだ結果が出ていない)は継続。
      } catch {
        consecutiveFailures += 1
        if (consecutiveFailures >= DOC_STATUS_POLL_MAX_FETCH_FAILURES) return 'degraded'
      }
    }
  }

  // ②-4b §1(spec §2.2): 消費済み session の object は server pipeline が所有している
  // (読取中でありうる)ため、client DELETE が競合すると pdf_source_unavailable の誤
  // terminal 化を誘発する。 uploadSessionId を無効化する 2 点で当該 session の全登録を
  // registry からも落とし、以後 removeEntry がその session を指せなくする。 inFlight は
  // 不問 — 「accepted 時点で飛行中は無い」(submit gate が anyProcessing 不在を要求)と
  // いう前提に purge の網羅性を依存させない。
  function purgePdfSourceRegistry(sessionId: string) {
    for (const [id, rec] of pdfSourceRef.current) {
      if (rec.uploadSessionId === sessionId) pdfSourceRef.current.delete(id)
    }
  }

  async function runProcess() {
    try {
      if (destination === null) {
        // submitDisabled が destinationReady を要求するため通常到達しない
        // (defensive・TS narrowing 目的)。
        setError('OTHER', '投入先が選択されていません。')
        return
      }
      // 混在可(spec D3)。 選択順(= entries 配列順)を維持したまま、画像は従来どおり
      // FormData の `files` へ、 PDF は orderManifest(JSON)へ echo メタデータのみを積む
      // (PDF バイト本体は presign 済 直 PUT で既に R2 にある)。
      const readyEntries = entries.filter(
        (e): e is Extract<FileEntry, { status: 'ready' }> => e.status === 'ready',
      )
      const manifestEntries: OrderManifestEntry[] = []
      const imageFiles: File[] = []
      for (const e of readyEntries) {
        if (e.kind === 'image') {
          manifestEntries.push({ kind: 'image', fileIndex: imageFiles.length })
          imageFiles.push(e.file)
        } else {
          manifestEntries.push({
            kind: 'pdf',
            fileId: e.id,
            filename: e.file.name,
            pageCount: e.pageCount,
            declaredBytes: e.originalSize,
          })
        }
      }
      const hasPdf = manifestEntries.some((m) => m.kind === 'pdf')

      // idempotencyKey(spec §3.1: 論理 submit 試行の同一性)は **常に新規発行**
      // する — session(R2 namespace)とは独立で、image-only 経路と同じ扱い
      // (ユーザー再試行 = 別 operation という既存契約・submit-upload.ts:99-103)。
      const idempotencyKey = generateId()

      // ②-4b §1(spec §2.2): この submit が消費する session を捕捉しておき、無効化する
      // 2 点(accepted 受信 / submitUpload throw)で registry からも同期して落とす。
      // null = PDF を含まない submit(registry に該当登録が無く purge も不要)。
      const submittedSessionId = uploadSessionIdRef.current

      const fd = new FormData()
      fd.set('idempotencyKey', idempotencyKey)
      fd.set('mode', destination.mode)
      if (destination.mode === 'existing') fd.set('examId', destination.examId)
      for (const file of imageFiles) fd.append('files', file, file.name)
      if (hasPdf) {
        // 後方互換: PDF が 1 つも無ければ manifest / uploadSessionId を送らない
        // (T7 は manifest 不在を従来経路と解釈する)。 uploadSessionId は spec
        // §3.4 の wire 契約どおり FormData の top-level field(manifest 各要素は
        // fileId のみ)。 hasPdf な readyEntries が存在する時点で
        // uploadSessionIdRef は reserve 済みのはずで non-null — 万一 null なら
        // 空文字を送り、T7 の zod uuid 検証で invalid_input として弾かせる
        // (silent failure にしない)。
        fd.set('orderManifest', JSON.stringify(manifestEntries))
        fd.set('uploadSessionId', submittedSessionId ?? '')
      }

      let result: Awaited<ReturnType<typeof submitUpload>>
      try {
        result = await submitUpload(fd)
      } catch (err) {
        // throw / 応答不明(spec §3.2 行 3): server 側で uploadSessionId が
        // 既に消費されているかどうか判別できないため無効化する。
        uploadSessionIdRef.current = null
        // ②-4b §1(spec §2.2 / §5-1): null 化と**同一同期区間**で registry も落とす。
        // 間に await を挟むと「session は無効化済みだが registry には残る」窓ができ、
        // その窓の removeEntry が consumed session へ DELETE を撃てる。 下の
        // retryPdfSession が新 session で再登録するより前に実行される必要もある。
        if (submittedSessionId) purgePdfSourceRegistry(submittedSessionId)
        // Codex fix round 4(Important P2): 無効化しただけだと ready な PDF
        // entry が旧 session 配下の object を指したまま残り、次の submit で
        // 空 session が送られる/新規 PDF 追加時は新旧 session の object が
        // manifest に混在する(D5 point 5 の terminal 失敗経路と同じクラスの
        // 欠陥)。 throw も「応答不明」= 実質 terminal 失敗として扱い、既存の
        // retryPdfSession()(D5 point 5)をそのまま再利用して ready な PDF を
        // uploading へ戻し新 session で reserve→PUT→finalize をやり直す
        // (fire-and-forget・エラー表示自体はブロックしない)。
        // 安全性: throw 時に実際には operation が作成済みだった場合でも、
        // 回復後の再 submit は live-op gate(submit-upload.ts の advisory lock /
        // 非終端 op チェック)に当たって in_progress を返すだけで、二重
        // operation は作られない(既存 gate が担保する)。
        void retryPdfSession()
        throw err
      }
      // uploadSessionId の生存範囲(spec §3.2 の表): 新規 operation を作らない
      // ことが確定した outcome(in_progress / invalid_input / exam_not_found /
      // daily_limit_exceeded / unauthenticated)は**維持**する(object を再利用
      // でき、再 upload させない)。 accepted(replayed 含む)だけ消費済みとして
      // 無効化する — それ以外の outcome は下の switch へ進む前に何もしない
      // (デフォルトで「維持」)。
      if (result.outcome === 'accepted') {
        uploadSessionIdRef.current = null
        // ②-4b §1(spec §2.2 / §5-1): null 化と同一同期区間で registry も落とす
        // (上の throw 経路と同型 — await を挟むと consumed session へ撃てる窓ができる)。
        if (submittedSessionId) purgePdfSourceRegistry(submittedSessionId)
      }
      switch (result.outcome) {
        case 'accepted': {
          if (result.sourceDocumentId.length === 0) {
            // 冪等 replay で返った既存 operation の source_document が既に消えている
            // (GDPR 削除 / GC)。空 id で result page へ飛ばすと 404 になるため、
            // 一覧で確認してもらう(server 側 replay は状態不問で 3 ID を返す契約)。
            // form が再操作可能に戻るため setErrorAfterAccepted 経由(P2-①)。
            setErrorAfterAccepted({
              kind: 'error',
              code: 'OTHER',
              message:
                '処理状況を確認できませんでした。「試験一覧」で結果をご確認ください。',
              hideRetryHint: true,
            })
            return
          }
          // 受付済み。本処理は server の after() で走っているので、完了を poll で待つ。
          // phase は 'submitting' のまま(spinner + 「閉じても大丈夫」案内を出し続ける)。
          const outcome = await pollDocStatus(result.sourceDocumentId)
          if (outcome === 'aborted') return
          if (outcome === 'completed') {
            router.push(`/app/upload/result/${result.sourceDocumentId}`)
            return
          }
          if (outcome === 'failed') {
            // D5 point 5: uploadSessionId は accepted 受信時に既に無効化済み。
            // server 側の全出口 DELETE で旧 session の R2 object も削除される
            // ため setErrorAfterAccepted 経由で回復する(client は operation を
            // 終端化しない・S-1 申し送り・表示するだけ)。
            setErrorAfterAccepted({
              kind: 'error',
              code: 'OTHER',
              message: UPLOAD_INTERRUPTED_NOTICE,
              hideRetryHint: true,
            })
            return
          }
          // degraded: 判定不能のまま打ち切った。処理自体は server 側で継続しうる。
          // form は再操作可能に戻るため setErrorAfterAccepted 経由(P2-①・failed
          // と同じクラスの回復が必要 — round 4 まではここが取りこぼされていた)。
          setErrorAfterAccepted({
            kind: 'error',
            code: 'OTHER',
            message:
              '処理状況を確認できませんでした。「試験一覧」で結果をご確認ください。',
            hideRetryHint: true,
          })
          return
        }
        case 'in_progress':
          // 別の operation が valid lease を保持している(= 生きている。死んで lease が
          // 切れていれば supersede される)。 gate が閉じている間の再試行は実行不能ゆえ、
          // 中断を主張しない中立文言(I-3(b))。
          setError('UPLOAD_IN_PROGRESS', UPLOAD_PENDING_NOTICE)
          return
        case 'daily_limit_exceeded':
          setError(
            'GEMINI_DAILY_LIMIT_EXCEEDED',
            '本日の AI 利用上限に達しました。しばらくしてから再度お試しください。',
            { current: result.current, limit: result.limit },
          )
          return
        case 'exam_not_found':
          setError(
            'EXAM_NOT_FOUND',
            result.archived
              ? '選択した試験はアーカイブされています。'
              : '選択した試験が見つかりません。',
          )
          return
        case 'invalid_input':
          // 上限超過(1 file / 合計サイズ / 枚数)・未対応形式はここに集約される
          // (server 文言をそのまま出す — client 側の事前ブロックと同じ基準)。
          setError('INVALID_INPUT', result.error)
          return
        case 'unauthenticated':
          setError('AUTH', '認証が必要です。再度ログインしてください。')
          return
      }
    } catch {
      // network error / body 上限超過 / unexpected throw 等。 operation が作成済みか
      // どうかを client からは判別できないため、 無条件再試行でなく「試験一覧で確認を」と
      // 案内する(旧 legacy action 経路の catch と同じ方針)。
      // hideRetryHint=true: 「ファイルを変更して再試行」サブタイトルを非表示にする。
      setPhase({
        kind: 'error',
        code: 'OTHER',
        message:
          '処理状況を確認できませんでした。「試験一覧」で結果をご確認ください。',
        hideRetryHint: true,
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
    setPhase({ kind: 'submitting' })
    // OCR 開始を layout 常駐 poller に通知する。
    // submitUpload は sync phase 完了で即返る(本処理は after() 継続)が、
    // 応答を待たず開始を検知させるため client submit を起点にする。
    // requestOcrPoll は同期関数で listener を呼ぶだけ (例外は内部 try/catch で隔離済み)。
    // setPhase の urgent priority batching を壊さないよう setPhase 直後・runProcess 前に置く。
    requestOcrPoll()
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
        // S-4: 処理は server 側(after())で走っており、この画面を閉じても完走する。
        // ゆえに「閉じないでください」の警告(および離脱ガード)は撤去し、
        // 「閉じても後で確認できる」案内に統一した。 警告ではなくなったので amber の
        // 警告色から slate の情報色へ落とし、role も status(非割込)にする。
        <section
          role="status"
          aria-live="polite"
          className="rounded-md bg-slate-50 border border-slate-300 p-4 flex items-start gap-3"
        >
          <Loader2 className="h-5 w-5 animate-spin text-slate-700 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="text-sm text-slate-800">
            <p className="font-semibold">AI が問題を抽出しています…</p>
            <p className="mt-1">
              完了すると自動で結果画面に切り替わります。 この画面を閉じても処理は続き、
              後で「試験一覧」から結果を確認できます。
            </p>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-bold mb-2">ファイルを選択</h2>
        <p className="text-sm text-slate-600 mb-3">
          画像 (JPG / PNG / HEIC 等) は自動で圧縮されます。 PDF にも対応しています。
          <br />
          合計 {OCR_MAX_PAGES} ページ・PDF 1 ファイルあたり {MAX_PDF_BYTES / MB} MB・
          画像合計サイズ上限 {TOTAL_UPLOAD_LIMIT_MB} MB まで。
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
            {entries.length} 件選択中 (合計 {formatBytes(totalBytes)}、 {pageSummaryText})
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
          {overPageCap && (
            <div
              role="alert"
              className="mb-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800"
            >
              合計 {OCR_MAX_PAGES} ページまでアップロード可能です (現在 {totalRequestedPages} ページ)。
              ファイルを分割して複数回に分けてアップロードしてください。
            </div>
          )}
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {entries.map((e) => (
              <li key={e.id}>
                <Card className={e.status === 'error' ? 'ring-red-200' : ''}>
                  <CardContent className="p-3 space-y-2">
                    {e.kind === 'image' && 'thumbUrl' in e && e.thumbUrl ? (
                      // TODO(波1): next/image 化 (loader / remotePatterns 設定 + Next 16 default 変更と同時)
                      // eslint-disable-next-line @next/next/no-img-element
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
                            {e.status === 'ready' && <span>{e.pageCount} ページ</span>}
                            {e.status === 'uploading' && <span>アップロード中…</span>}
                            {e.status === 'counting' && <span>ページ数確認中…</span>}
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
                      {e.status === 'processing' || e.status === 'uploading' || e.status === 'counting'
                        ? e.status === 'uploading'
                          ? 'アップロード中…'
                          : e.status === 'counting'
                            ? 'ページ数確認中…'
                            : '処理中…'
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
        /* UPLOAD_IN_PROGRESS は失敗ではなく「別の upload がまだ実行中」という
           状態通知(文言も中立の UPLOAD_PENDING_NOTICE)。赤の error panel だと
           「失敗した」と読めてしまうため amber に落とす(follow-up・挙動不変)。 */
        <section
          className={
            phase.code === 'UPLOAD_IN_PROGRESS'
              ? 'rounded-md bg-amber-50 border border-amber-200 p-4 space-y-2'
              : 'rounded-md bg-red-50 border border-red-200 p-4 space-y-2'
          }
        >
          <p
            className={
              phase.code === 'UPLOAD_IN_PROGRESS'
                ? 'text-sm text-amber-800'
                : 'text-sm text-red-700'
            }
          >
            {phase.message}
          </p>
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
            ? // S-4: 所要時間の数値は出さない(公開文言の規律と揃える)。
              'AI で抽出中…'
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
