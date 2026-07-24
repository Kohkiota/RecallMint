'use client'

// CardImageGallery: target 単位の画像 gallery(表示・添付・削除)。
// card-editor-fields.tsx に埋め込み、 問題文 / 各 option の下に添付順で並べる
// (画像フェーズ A Task 10 / spec §5)。 T11 で学習ビュー read-only 表示にも共用予定。
//
// 描画対象は UUID key entry のみ (legacy OCR 由来の非 UUID key は非描画、 spec §2.2)。
// 画像 bytes は Cache API / R2 に持ち、 card mirror には assetId(key)のみ保持する
// (署名 URL を <img src> / DB / Dexie に置かない、 spec 前提 1 の恒久防衛)。
//
// 不変条件(card-editor-fields.tsx の landmine を踏襲): props で受け取った images
// のみを消費し、 cards store への独自 useLiveQuery は持たない。 media_assets の
// best-effort 読み取り(width/height, layout-shift 回避)のみ自前で行う。

import * as React from 'react'
import { ImagePlus } from 'lucide-react'

import { getClientDb, type ClientCardImage } from '@/lib/client-db'
import { isAssetKey } from '@/lib/validation/card'
import {
  attachImageToCard,
  removeImageFromCard,
  type AttachErrorCode,
} from '@/lib/media/upload'
import { getAssetObjectURL } from '@/lib/media/get-asset'
import { computeFold } from '@/lib/media/compute-fold'
import { reclaimLocalAssetBlobs } from '@/lib/media/reclaim-local-asset-blobs'
import { useImageZoom, type ZoomImage } from '@/components/media/use-image-zoom'
import { reserveAsset, finalizeAsset, resolveAssetUrls } from '../_actions/asset-actions'

export type CardImageGalleryProps = {
  images: ClientCardImage[]
  target: string
  cardId: string
  userId: string
  readOnly?: boolean
  // Sprint I W3: 選択肢のように gallery 数が要素数に比例して増える面で、空状態の add
  // affordance を dashed「画像を追加」ボタンでなく小さな +画像 アイコンに留める(§9 行高
  // 肥大回避)。thumbnail 描画・attach/delete 経路は不変。
  compact?: boolean
  // compact icon の aria-label 文脈付け(複数選択肢で同名ボタンが並ぶ SR 不可判別を回避)。
  // 例: 「選択肢 a に画像を追加」。未指定時は既定「画像を追加」。
  attachAriaLabel?: string
  // Sprint I fix(§9 行高): add affordance と thumbnail を別配置するための slot 制御。
  // 'full'(既定)= thumbnail + add(従来)/ 'add' = add affordance のみ(ラベル行や選択肢行に
  // 収める)/ 'thumbnails' = thumbnail のみ(add はラベル/行側に置いたので下は表示専用)。
  // readOnly は add を出さないため slot と直交(学習面は 'full' のまま thumbnail のみ)。
  slot?: 'full' | 'add' | 'thumbnails'
  // Task 5(spec §3.2/§3.3): 表示モード。'thumb'(既定)= 64px サムネ(編集/一覧/side-peek)。
  // 'inflow' = 演習 in-flow の大きめ表示(単一 = 幅100%画像 + 縦長畳み、複数 = 128px タイル wrap)。
  // inflow は学習面 read-only 前提で add affordance を持たない。
  display?: 'thumb' | 'inflow'
}

// attach 失敗 code → 短い JP エラーメッセージ(brief 指定の文言、 変更禁止)。
const ATTACH_ERROR_MESSAGE: Record<AttachErrorCode, string> = {
  TOO_MANY_IMAGES: '画像は10枚までです',
  INVALID_TYPE: '対応していない画像形式です',
  COMPRESS_FAILED: '画像の処理に失敗しました',
  RESERVE_FAILED: 'アップロードを開始できませんでした',
  UPLOAD_FAILED: 'アップロードに失敗しました',
  FINALIZE_FAILED: 'アップロードの確定に失敗しました',
}

const ACCEPTED_INPUT_TYPES = 'image/jpeg,image/png,image/webp'

// ---------------------------------------------------------------------------
// Thumbnail (1 entry 分の objectURL 解決 + 描画)
// ---------------------------------------------------------------------------

type ThumbnailProps = {
  image: ClientCardImage
  userId: string
  readOnly: boolean
  onDelete: (assetId: string) => void
  // 画像本体 tap → 全画面モーダル。 gallery が target 単位で ZoomImage[] を組むため、
  // thumbnail は自 key を渡すだけ (解決/dims 収集は gallery 側 openModal)。
  onOpen: (assetId: string) => void
}

function CardImageThumbnail({ image, userId, readOnly, onDelete, onOpen }: ThumbnailProps) {
  // undefined=loading / null=失敗(placeholder+retry) / string=resolved objectURL。
  const [url, setUrl] = React.useState<string | null | undefined>(undefined)
  const [retryTick, setRetryTick] = React.useState(0)
  // best-effort: media_assets から width/height を読む(layout-shift 回避)。 読めなければ
  // 属性を付けないだけで描画は成立する(brief: skip if it complicates things への配慮)。
  const [dims, setDims] = React.useState<{ width: number; height: number } | null>(null)

  React.useEffect(() => {
    let alive = true
    getAssetObjectURL(userId, image.key, { resolveAssetUrls }).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [userId, image.key, retryTick])

  React.useEffect(() => {
    let alive = true
    getClientDb()
      .media_assets.get(image.key)
      .then((row) => {
        if (alive && row) setDims({ width: row.width, height: row.height })
      })
      .catch(() => {
        // best-effort。 読めなくても表示は成立する。
      })
    return () => {
      alive = false
    }
  }, [image.key])

  if (url === undefined) {
    return (
      <div
        className="h-16 w-16 shrink-0 animate-pulse rounded-md border border-slate-200 bg-slate-100"
        aria-hidden="true"
      />
    )
  }

  if (url === null) {
    return (
      <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-slate-200 bg-slate-100 p-1 text-center">
        <span className="text-[10px] text-slate-500">画像を取得できません</span>
        <button
          type="button"
          onClick={() => {
            // retry click 起点で loading 表示に戻す(effect 本体からの同期 setState は
            // cascading render を招くため避け、 ユーザー操作のイベントハンドラで行う)。
            setUrl(undefined)
            setRetryTick((t) => t + 1)
          }}
          className="min-h-8 rounded px-1 text-[10px] font-medium text-slate-600 underline hover:text-slate-900"
        >
          再読み込み
        </button>
      </div>
    )
  }

  return (
    <div className="group relative shrink-0">
      {/* 画像本体 tap = 全画面モーダル。 tap-gate: この resolved 分岐 (url が string) でのみ
          button を出す = loading/失敗 placeholder は tap 不可 (空モーダル防止、 spec §3.6)。
          × 削除とは別 hit target で、 button を入れ子にしない (兄弟に置く)。 button は
          block h-16 w-16 で <img> と同寸ゆえ flex layout / × 配置を変えない。 */}
      <button
        type="button"
        // iOS Safari は tap だけで button に focus が乗らないことがある。 open 前に明示 focus し、
        // hook が focus 復帰 trigger として tap した button を確実に捕捉できるようにする (§3.6)。
        onClick={(e) => {
          e.currentTarget.focus()
          void onOpen(image.key)
        }}
        // 操作要素の名前は「拡大」を常に含める (alt 有無どちらでも操作を伝える a11y)。
        // alt 空 → 「画像を拡大」 / alt あり → 「<alt>を拡大」。
        aria-label={`${image.alt || '画像'}を拡大`}
        className="block h-16 w-16 rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        {/* objectURL は next/image の最適化対象外(remotePatterns 変更なし、 spec §5)。
            既存 upload-form.tsx と同じ suppression pattern を踏襲。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={image.alt || ''}
          width={dims?.width}
          height={dims?.height}
          className="h-16 w-16 rounded-md border border-slate-200 object-cover"
        />
      </button>
      {!readOnly && (
        <button
          type="button"
          onClick={() => onDelete(image.key)}
          aria-label="画像を削除"
          className="absolute -right-1.5 -top-1.5 flex min-h-6 min-w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-xs text-slate-500 shadow-sm transition-colors hover:bg-slate-100 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// display='inflow' (Task 5): 演習 in-flow 大きめ表示。
// 単一(===1)= 幅100%画像 + 縦長畳み(computeFold 実関数)、複数(>=2)= 128px タイル wrap。
// ---------------------------------------------------------------------------

// asset objectURL を解決する共通 hook(inflow single / tile 用)。thumbnail は既存の inline
// 実装を保つ(display='thumb' 面の byte 不変を優先)ため refactor しない。
// undefined=loading / null=失敗(retry) / string=resolved objectURL。
function useAssetObjectUrl(userId: string, key: string) {
  const [url, setUrl] = React.useState<string | null | undefined>(undefined)
  const [retryTick, setRetryTick] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    getAssetObjectURL(userId, key, { resolveAssetUrls }).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [userId, key, retryTick])
  const retry = React.useCallback(() => {
    // 失敗 placeholder の再読み込み: loading 表示へ戻し resolve をやり直す。
    setUrl(undefined)
    setRetryTick((t) => t + 1)
  }, [])
  return { url, retry }
}

// inflow 畳み定数(spec §3.3 開始値)。閾値は computeFold へ引数で渡す(pure 関数に埋め込まない)。
const INFLOW_ABS_MARGIN_PX = 48
const INFLOW_RATIO = 1.15
// cap の CSS。測定要素 / clip wrapper が共有する min(70svh,44rem)(svh を JS で再計算しない)。
const INFLOW_CAP_MAX_H_CLASS = 'max-h-[min(70svh,44rem)]'

type InflowImageProps = {
  image: ClientCardImage
  userId: string
  // 画像 tap / 畳みボタン → target 単位の全画面モーダル(gallery 側 openModal)。
  onOpen: (assetId: string) => void
}

// 単一(===1): 幅100%画像 + 縦長畳み。
// capPx = 測定要素の clientHeight(= used max-height min(70svh,44rem) の px 値。clip とは分離 =
// fold=false 画像を silently clip しない)。getComputedStyle().maxHeight は CSSOM 上 computed 値で
// 式文字列を返す engine があり(iOS Safari)parseFloat が NaN 化して畳みが永久 no-op になるため
// 使わない。renderedWidthPx = clip wrapper の clientWidth。dims は media_assets mirror 優先、無ければ
// onLoad の naturalWidth/Height で再評価。ResizeObserver で幅/向き/split view 変化に追従(unmount で cleanup)。
function CardImageInflowSingle({ image, userId, onOpen }: InflowImageProps) {
  const { url, retry } = useAssetObjectUrl(userId, image.key)
  const [dims, setDims] = React.useState<{ width: number; height: number } | null>(null)
  const [fold, setFold] = React.useState(false)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const measureRef = React.useRef<HTMLDivElement>(null)
  const imgRef = React.useRef<HTMLImageElement>(null)
  // onLoad で読む natural 寸(mirror dims 欠落時の fallback)。render を跨いで保持するため ref。
  const naturalRef = React.useRef<{ width: number; height: number } | null>(null)

  // best-effort: mirror から dims を読む(layout-shift 回避 + 初回 fold 判定材料)。
  React.useEffect(() => {
    let alive = true
    getClientDb()
      .media_assets.get(image.key)
      .then((row) => {
        if (alive && row) setDims({ width: row.width, height: row.height })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [image.key])

  const recomputeFold = React.useCallback(() => {
    const wrapper = wrapperRef.current
    const measure = measureRef.current
    if (!wrapper || !measure) return
    // capPx = 測定要素の clientHeight = used max-height(min(70svh,44rem))を px 解決した値。
    // getComputedStyle().maxHeight は CSSOM 上 computed 値で式文字列("min(70svh, 44rem)")を返す
    // engine があり(iOS Safari)parseFloat が NaN になり畳みが永久 no-op 化する。測定要素は
    // overflow-hidden + 超高 spacer で自身の used height を max-height に clamp するため、
    // clientHeight が used px を返す(svh→px はブラウザが layout で解決・JS は svh を再計算しない)。
    const capPx = measure.clientHeight
    const renderedWidthPx = wrapper.clientWidth
    const naturalWidth = dims?.width ?? naturalRef.current?.width ?? 0
    const naturalHeight = dims?.height ?? naturalRef.current?.height ?? 0
    // dims 未確定 / 測定不能(未 layout)は畳まない(全高)。
    if (
      naturalWidth <= 0 ||
      naturalHeight <= 0 ||
      !Number.isFinite(capPx) ||
      capPx <= 0 ||
      renderedWidthPx <= 0
    ) {
      setFold(false)
      return
    }
    const result = computeFold({
      naturalWidth,
      naturalHeight,
      renderedWidthPx,
      capPx,
      absMarginPx: INFLOW_ABS_MARGIN_PX,
      ratio: INFLOW_RATIO,
    })
    setFold(result.fold)
  }, [dims])

  // mount / dims 変化 / url 解決時に再評価し、ResizeObserver で幅・向き変化に追従(cleanup 付き)。
  // wrapper(clientWidth = renderedWidthPx)に加え measure(clientHeight = capPx = min(70svh,44rem))も
  // observe する。capPx は svh 基準ゆえ wrapper 幅が不変でも viewport 高さ変化(desktop 縦リサイズ等)で
  // 変わり、その時 measure だけが resize するため。単一 disconnect が両方の cleanup を兼ねる。
  React.useEffect(() => {
    recomputeFold()
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const measure = measureRef.current
    const ro = new ResizeObserver(() => recomputeFold())
    ro.observe(wrapper)
    if (measure) ro.observe(measure)
    return () => ro.disconnect()
  }, [recomputeFold, url])

  const handleLoad = () => {
    const img = imgRef.current
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      naturalRef.current = { width: img.naturalWidth, height: img.naturalHeight }
    }
    recomputeFold()
  }

  if (url === undefined) {
    return (
      <div
        className="h-48 w-full animate-pulse rounded-md border border-slate-200 bg-slate-100"
        aria-hidden="true"
      />
    )
  }

  if (url === null) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-1 rounded-md border border-slate-200 bg-slate-100 p-4 text-center">
        <span className="text-xs text-slate-500">画像を取得できません</span>
        <button
          type="button"
          onClick={retry}
          className="min-h-8 rounded px-1 text-xs font-medium text-slate-600 underline hover:text-slate-900"
        >
          再読み込み
        </button>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div
        ref={wrapperRef}
        className={
          fold ? `relative w-full overflow-hidden ${INFLOW_CAP_MAX_H_CLASS}` : 'relative w-full'
        }
      >
        {/* 画像本体 tap = 全画面モーダル(iOS pre-focus)。 */}
        <button
          type="button"
          onClick={(e) => {
            e.currentTarget.focus()
            void onOpen(image.key)
          }}
          aria-label={`${image.alt || '画像'}を拡大`}
          className="block w-full rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          {/* objectURL は next/image 最適化対象外。既存 upload-form.tsx の suppression を踏襲。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={url}
            alt={image.alt || ''}
            onLoad={handleLoad}
            width={dims?.width}
            height={dims?.height}
            className="block h-auto w-full rounded-md border border-slate-200"
          />
        </button>
        {/* 下端フェード(clip 端の視覚的つながり)。clip 内・pointer-events-none = tap は画像へ透過。 */}
        {fold && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white via-white/70 to-transparent"
          />
        )}
      </div>
      {/* 「拡大して全体を見る」= clip wrapper の外(clip されない)。hit ≥44px・同一 openModal 経路。 */}
      {fold && (
        <button
          type="button"
          onClick={(e) => {
            e.currentTarget.focus()
            void onOpen(image.key)
          }}
          aria-label={`${image.alt || '画像'}を拡大して全体を見る`}
          className="mt-2 flex min-h-11 w-full items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          拡大して全体を見る
        </button>
      )}
      {/* capPx 測定要素(常時 max-height を保持 = fold=false でも読める)。overflow-hidden + 超高
          spacer(cap を必ず超える高さ)で自身の used height を max-height の px 値に clamp させ、
          measure.clientHeight で used px を読む(getComputedStyle().maxHeight は computed=式文字列を
          返す engine があり NaN 化するため使わない)。clip とは分離 = fold=false 画像の silent-clip を
          防ぐ(measurement ≠ clipping)。invisible absolute + w-0 で実 layout に干渉しない。 */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className={`pointer-events-none invisible absolute w-0 overflow-hidden ${INFLOW_CAP_MAX_H_CLASS}`}
      >
        {/* cap(min(70svh,44rem))より必ず高い spacer。overflow-hidden 親の height を max-height に
            張り付かせるためだけの要素(視覚・layout には出ない)。 */}
        <div aria-hidden="true" className="h-[100000px] w-px" />
      </div>
    </div>
  )
}

// 複数(>=2): 中サイズ 128px タイル(object-cover)。畳みなし・各タイル tap→モーダル。
function CardImageInflowTile({ image, userId, onOpen }: InflowImageProps) {
  const { url, retry } = useAssetObjectUrl(userId, image.key)

  if (url === undefined) {
    return (
      <div
        className="h-32 w-32 shrink-0 animate-pulse rounded-md border border-slate-200 bg-slate-100"
        aria-hidden="true"
      />
    )
  }

  if (url === null) {
    return (
      <div className="flex h-32 w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-slate-200 bg-slate-100 p-1 text-center">
        <span className="text-[10px] text-slate-500">画像を取得できません</span>
        <button
          type="button"
          onClick={retry}
          className="min-h-8 rounded px-1 text-[10px] font-medium text-slate-600 underline hover:text-slate-900"
        >
          再読み込み
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.currentTarget.focus()
        void onOpen(image.key)
      }}
      aria-label={`${image.alt || '画像'}を拡大`}
      className="block h-32 w-32 shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={image.alt || ''}
        className="h-32 w-32 rounded-md border border-slate-200 object-cover"
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// CardImageGallery
// ---------------------------------------------------------------------------

export function CardImageGallery({
  images,
  target,
  cardId,
  userId,
  readOnly = false,
  compact = false,
  attachAriaLabel,
  slot = 'full',
  display = 'thumb',
}: CardImageGalleryProps) {
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const { open } = useImageZoom()

  // stale / 旧 schema の mirror row では images が undefined / 非配列でありうる。 filter で
  // throw して exam 詳細 view 全体を壊さないよう、 server mapper と同じく Array.isArray で
  // 防御する(Codex 指摘)。
  const safeImages = Array.isArray(images) ? images : []

  // 判別 invariant(spec §2.2): UUID key = asset 参照(描画対象)、 非 UUID = legacy OCR
  // passthrough(非描画)。 target 一致も併せて絞る(gallery は target 単位)。
  const targetImages = safeImages.filter((i) => i.key && isAssetKey(i.key) && i.target === target)

  // 画像 tap → target 全体の解決済み ZoomImage[] を組み、 tap 画像を起点に全画面モーダルを
  // 開く(swipe で target 内を移動できるよう ordinal 順を維持)。 未解決/decode 失敗は集合から
  // 除外し、 startIndex は除外後に tap key で再計算する(spec §3.6)。
  const openModal = async (tappedKey: string): Promise<void> => {
    const resolved = await Promise.all(
      targetImages.map(async (image) => {
        // getAssetObjectURL は resolver cache の objectURL を返す(所有権は resolver、
        // ここで revoke してはならない)。
        const src = await getAssetObjectURL(userId, image.key, { resolveAssetUrls })
        if (!src) return null // 解決不可 → 除外
        const row = await getClientDb()
          .media_assets.get(image.key)
          .catch(() => undefined)
        let width: number
        let height: number
        if (row) {
          width = row.width
          height = row.height
        } else {
          // 未表示兄弟は DOM <img> ref が無いため、 同じ cache URL を decode して natural 寸を得る
          // (新 objectURL を作らない = revoke 対象なし)。 decode 失敗は集合から除外。
          try {
            const probe = new Image()
            probe.src = src
            await probe.decode()
            width = probe.naturalWidth
            height = probe.naturalHeight
          } catch {
            return null
          }
        }
        return { key: image.key, zoom: { src, width, height, alt: image.alt || '' } satisfies ZoomImage }
      }),
    )

    const usable = resolved.filter((r): r is NonNullable<typeof r> => r !== null)
    const startIndex = usable.findIndex((r) => r.key === tappedKey)
    // tap 画像は tap-gate で解決済みゆえ通常必ず含まれる。 万一 decode 失敗で外れた場合は
    // 無効 index でモーダルを開かない。
    if (startIndex < 0) return
    await open(
      usable.map((r) => r.zoom),
      startIndex,
    )
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 同じ file を再選択しても change が発火するよう value を都度リセットする
    // (成功/失敗どちらの経路でも実施)。
    e.target.value = ''
    if (!file) return

    setError(null)
    const result = await attachImageToCard(
      { userId, cardId, target, file, currentImages: safeImages },
      { reserveAsset, finalizeAsset },
    )
    if (!result.ok) {
      setError(ATTACH_ERROR_MESSAGE[result.code])
    }
  }

  const handleDelete = async (assetId: string) => {
    // 削除 = images 配列から entry 除去のみ(asset / R2 object は残置、 spec §5)。
    // abandonUpload は使わない(in-progress upload の巻戻し専用、 delete とは別経路)。
    // removeImageFromCard 経由で attach/abandon と同じ per-card 直列化 + mirror fresh read を
    // 通す(props snapshot での full-array-replace が in-flight な attach の楽観追加と競合し
    // lost-update するのを防ぐ — Codex 指摘)。
    setError(null)
    await removeImageFromCard({ cardId, assetId })
    // ローカル Cache blob + media_assets 行を best-effort 掃除する(spec §4.7)。 R2/DB の
    // grace とは独立の disposable cache 掃除なので fire-and-forget(失敗しても削除 UX は
    // ブロックしない)。
    void reclaimLocalAssetBlobs(userId, [assetId])
  }

  // slot='add' は add affordance のみ / 'thumbnails'(+ readOnly)は thumbnail のみ。
  const showThumbnails = slot !== 'add'
  const showAdd = slot !== 'thumbnails' && !readOnly
  // thumbnail も add も描画しない組合せ(空 thumbnails / 空 readOnly / add+readOnly の
  // 想定外併用)は空 wrapper を出さず null(§9 行高: 空 div も出さない)。
  if (!(showThumbnails && targetImages.length > 0) && !showAdd) {
    return null
  }

  // Task 5: 演習 in-flow 大きめ表示。null-guard を抜けた = targetImages.length >= 1 が保証される。
  // 単一 / 複数の二分のみ(枚数別の細分岐は作らない・spec §3.2 / YAGNI)。inflow は学習面
  // read-only 前提で add affordance / attach error を描画しない(thumb 面は不変)。
  if (display === 'inflow') {
    return (
      <div className="w-full">
        {targetImages.length === 1 ? (
          // key で asset ごとに remount する(演習で次カードへ進むと同 position の single が
          // 再利用され、useAssetObjectUrl の url / dims / fold / naturalRef が前 asset のまま
          // 残留する — mirror row 無しの新 asset で旧 dims が居座り fold 誤りになる。keyed な
          // 兄弟(tile / thumbnail)と同じく key で state を rest する)。
          <CardImageInflowSingle
            key={targetImages[0].key}
            image={targetImages[0]}
            userId={userId}
            onOpen={openModal}
          />
        ) : (
          // 複数(>=2): 128px タイル wrap。畳みなし。128px タイルは行数を厳密に上限しないが、
          // 幅100%単列積み上げに比べ高さが有界(per-target 複数は tail、有限枚数 ≤10 に留め
          // 行数制限/横スクロールは足さない・YAGNI・spec §3.2)。
          <div className="flex flex-wrap gap-2">
            {targetImages.map((image) => (
              <CardImageInflowTile
                key={image.key}
                image={image}
                userId={userId}
                onOpen={openModal}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showThumbnails &&
        targetImages.map((image) => (
          <CardImageThumbnail
            key={image.key}
            image={image}
            userId={userId}
            readOnly={readOnly}
            onDelete={handleDelete}
            onOpen={openModal}
          />
        ))}

      {showAdd && (
        <>
          {compact ? (
            // compact: 小さな +画像 アイコン(gallery 内 × 削除ボタンと同寸 h-6 w-6)。
            // 空選択肢の行高増分を最小化する(§9)。onClick / hidden input は共有。
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label={attachAriaLabel ?? '画像を追加'}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              <ImagePlus className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex min-h-11 items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              画像を追加
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_INPUT_TYPES}
            onChange={handleFileChange}
            className="hidden"
          />
        </>
      )}

      {error && (
        <p role="alert" className="w-full text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
