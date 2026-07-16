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
import { reclaimLocalAssetBlobs } from '@/lib/media/reclaim-local-asset-blobs'
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
}

function CardImageThumbnail({ image, userId, readOnly, onDelete }: ThumbnailProps) {
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
}: CardImageGalleryProps) {
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // stale / 旧 schema の mirror row では images が undefined / 非配列でありうる。 filter で
  // throw して exam 詳細 view 全体を壊さないよう、 server mapper と同じく Array.isArray で
  // 防御する(Codex 指摘)。
  const safeImages = Array.isArray(images) ? images : []

  // 判別 invariant(spec §2.2): UUID key = asset 参照(描画対象)、 非 UUID = legacy OCR
  // passthrough(非描画)。 target 一致も併せて絞る(gallery は target 単位)。
  const targetImages = safeImages.filter((i) => i.key && isAssetKey(i.key) && i.target === target)

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

  if (targetImages.length === 0 && readOnly) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {targetImages.map((image) => (
        <CardImageThumbnail
          key={image.key}
          image={image}
          userId={userId}
          readOnly={readOnly}
          onDelete={handleDelete}
        />
      ))}

      {!readOnly && (
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
