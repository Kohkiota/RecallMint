// WebKit-safe 自前圧縮 pipeline (画像圧縮 iOS/WebKit 修正 spec Task 3)。
//
// 根本原因: WebKit は「フル解像度の中間 canvas」を作った時点で OOM/クラッシュしうる。
// 本 module は最終出力寸法の canvas を 1 個だけ生成し、 フル解像度の中間 canvas を
// 一切作らない (`drawImage(img, 0, 0, outW, outH)` で decode 画像を直接縮小 blit する)。
//
// `createImageBitmap` は使わない (WebKit で不安定・spec Codex#4、 image-validation.ts と
// 同方針)。 EXIF orientation は `HTMLImageElement` のブラウザ既定 (自動適用) に委ね、
// 手動再回転はしない。
//
// 循環 import 回避: `upload.ts` (後続 task) が本 module から `compressImageSafe` を
// import する。 逆方向 (本 module → upload.ts の runtime import) を作ると循環になるため、
// `CompressResult` は type-only import (コンパイル時に消える) に留め、 `sha256Hex` は
// upload.ts が export していないこともあり、 ここに ~5 行の局所実装を複製する
// (循環を断つための意図的な重複・許容範囲)。

import type { CompressResult } from './upload'

export const MAX_EDGE = 2048
export const MAX_PIXELS = 4_000_000
export const JPEG_QUALITY = 0.85
export const WEBP_QUALITY = 0.85

/**
 * 元寸法から出力寸法への縮小 scale を算出する純関数。
 * scale = min(1, MAX_EDGE/srcW, MAX_EDGE/srcH, sqrt(MAX_PIXELS/(srcW*srcH)))。
 * 1 以下に丸めることで upscale はしない。 round 後 0 になりうる極端な縮小でも
 * 最終的に max(1, ...) で ≥1px を保証する (0px canvas を作らせない)。
 */
export function computeScale(srcW: number, srcH: number): { outW: number; outH: number } {
  const scale = Math.min(1, MAX_EDGE / srcW, MAX_EDGE / srcH, Math.sqrt(MAX_PIXELS / (srcW * srcH)))
  const outW = Math.max(1, Math.round(srcW * scale))
  const outH = Math.max(1, Math.round(srcH * scale))
  return { outW, outH }
}

export type OutputFormat = {
  type: 'image/webp' | 'image/png' | 'image/jpeg'
  quality?: number
  whiteFill: boolean
}

/**
 * 出力形式を決める純関数。
 * canWebp → WebP (alpha 保持・白塗り不要)。
 * 否かつ alpha あり → PNG (白塗りしない・alpha 保持)。
 * 否かつ alpha なし → JPEG (この時のみ白塗り。 JPEG は alpha を持てないため)。
 */
export function chooseOutputFormat(canWebp: boolean, hasAlpha: boolean): OutputFormat {
  if (canWebp) {
    return { type: 'image/webp', quality: WEBP_QUALITY, whiteFill: false }
  }
  if (hasAlpha) {
    return { type: 'image/png', whiteFill: false }
  }
  return { type: 'image/jpeg', quality: JPEG_QUALITY, whiteFill: true }
}

let webpSupportCache: boolean | undefined

/**
 * このブラウザが `canvas.toBlob`/`toDataURL` で WebP encode できるかを判定する。
 * 2×2 canvas を `toDataURL('image/webp')` し、 結果が `data:image/webp` で始まるかで
 * 判定する (非対応 browser は silent に PNG data URL を返すため文字列で見分ける)。
 * 結果は memoize (呼び出しごとに canvas を作り直さない)。 例外時は false。
 */
export function canEncodeWebp(): boolean {
  if (webpSupportCache !== undefined) return webpSupportCache

  try {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const dataUrl = canvas.toDataURL('image/webp')
    webpSupportCache = dataUrl.startsWith('data:image/webp')
  } catch {
    webpSupportCache = false
  }
  return webpSupportCache
}

/** upload.ts の版と同一実装 (循環 import 回避のための局所複製・上部コメント参照)。 */
async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** canvas を `type`/`quality` で blob 化する。 `toBlob` 優先、 null なら `toDataURL` fallback。 */
async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  const viaToBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality)
  })
  if (viaToBlob) return viaToBlob

  // toBlob が null を返す環境向け fallback (WebKit で稀に発生)。
  const dataUrl = canvas.toDataURL(type, quality)
  const res = await fetch(dataUrl)
  return res.blob()
}

/** 使用済み canvas を解放する (連続添付でのメモリ圧迫防止・image-validation.ts と同方針)。 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

/**
 * 添付画像を WebKit-safe に圧縮する。
 *
 * 手順: `HTMLImageElement` + `URL.createObjectURL` で decode (`createImageBitmap` は
 * 使わない) → `img.decode()` await → oriented 済み natural 寸法 (EXIF はブラウザ既定に
 * 委ね再回転しない) → `computeScale` で出力寸法算出 → **最終寸法の canvas を 1 個だけ**
 * 生成し `drawImage(img, 0, 0, outW, outH)` (フル解像度中間 canvas を作らない) →
 * alpha 判定 (白塗り**前**の `getImageData` で alpha<255 の有無を見る。 白塗り後だと
 * alpha が潰れて判定できない) → `chooseOutputFormat` → JPEG の時だけ別 canvas に白背景
 * 合成 → encode (`toBlob` 優先、 null は `toDataURL` fallback) → `mime` は実出力
 * `blob.type` (webp と仮定しない) → `hash` は SHA-256。
 *
 * src 寸法が 0/NaN (decode 失敗 or 不正画像) は throw する。
 */
export async function compressImageSafe(file: File): Promise<CompressResult> {
  const url = URL.createObjectURL(file)
  let img: HTMLImageElement
  try {
    img = new Image()
    img.src = url
    await img.decode()
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err instanceof Error ? err : new Error('image decode failed')
  }
  URL.revokeObjectURL(url)

  const srcW = img.naturalWidth
  const srcH = img.naturalHeight
  if (!srcW || !srcH || Number.isNaN(srcW) || Number.isNaN(srcH)) {
    throw new Error('image decode failed: invalid dimensions')
  }

  const { outW, outH } = computeScale(srcW, srcH)

  // 最終寸法の canvas 1 個だけを生成する (根本方針。 フル解像度 canvas は作らない)。
  const drawCanvas = document.createElement('canvas')
  drawCanvas.width = outW
  drawCanvas.height = outH
  // canvas 確保〜release を try/finally で包む。 getContext null / getImageData /
  // canvasToBlob いずれが throw しても、 確保済み canvas を width=height=0 で確実に
  // 解放する (本 module は WebKit の canvas メモリ安全が存在理由ゆえ leak を残さない)。
  let outputCanvas: HTMLCanvasElement = drawCanvas
  try {
    const drawCtx = drawCanvas.getContext('2d')
    if (!drawCtx) throw new Error('2d context unavailable')
    drawCtx.drawImage(img, 0, 0, outW, outH)

    // alpha 判定は白塗り前に行う (白塗り後は alpha channel が潰れて判定不能になるため)。
    const sample = drawCtx.getImageData(0, 0, outW, outH).data
    let hasAlpha = false
    for (let i = 3; i < sample.length; i += 4) {
      if (sample[i] < 255) {
        hasAlpha = true
        break
      }
    }

    const format = chooseOutputFormat(canEncodeWebp(), hasAlpha)

    if (format.whiteFill) {
      // JPEG のみ: 白背景を先に敷いた別 canvas に合成する (alpha を破壊する白塗りは
      // JPEG 出力専用の canvas でのみ行い、 alpha 判定に使った drawCanvas は汚さない)。
      const fillCanvas = document.createElement('canvas')
      fillCanvas.width = outW
      fillCanvas.height = outH
      // getContext より前に代入し、 fill 途中の throw でも finally の解放対象にする。
      outputCanvas = fillCanvas
      const fillCtx = fillCanvas.getContext('2d')
      if (!fillCtx) throw new Error('2d context unavailable')
      fillCtx.fillStyle = '#ffffff'
      fillCtx.fillRect(0, 0, outW, outH)
      fillCtx.drawImage(img, 0, 0, outW, outH)
    }

    const blob = await canvasToBlob(outputCanvas, format.type, format.quality)
    const mime = blob.type
    const hash = await sha256Hex(blob)

    return { blob, mime, width: outW, height: outH, hash }
  } finally {
    releaseCanvas(drawCanvas)
    if (outputCanvas !== drawCanvas) releaseCanvas(outputCanvas)
  }
}
