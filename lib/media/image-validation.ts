// 出力妥当性検証 (画像圧縮 iOS/WebKit 修正 spec Task 2)。
//
// 「白いか」でなく「情報が消えたか」を判定する。 空/塗り潰し/透過全欠落/偽装
// type の破損出力のみ reject し、 正当な低分散画像 (白紙・単色背景・アイコン・
// 黒板写真・線画・手書きメモ・透過 PNG) は誤検知しない (spec §柱2・誤検知回避最優先)。
//
// decode は WebKit-safe (`HTMLImageElement` + object URL) に統一する。
// `createImageBitmap` は WebKit で不安定なため使わない (spec Codex#4)。

export const VALIDATE_SAMPLE = 64
export const OPAQUE_IN_MIN = 0.5
export const OPAQUE_OUT_MAX = 0.01
export const VAR_IN_MIN = 100
export const VAR_OUT_MAX = 4
export const MAE_MAX = 40

const ALLOWED_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg'])

export type SampleMetrics = {
  opaqueRatio: number
  meanLuma: number
  lumaVar: number
  edgeEnergy: number
}

export type ValidationMetrics = {
  input: SampleMetrics
  output: SampleMetrics
  mae: number
}

export type StructuralResult = {
  ok: boolean
  reason?: string
  width: number
  height: number
}

export type ValidityResult = {
  ok: boolean
  reason?: string
}

/**
 * RGBA サンプルから非透明率・輝度平均・輝度分散・edge energy を算出する純関数。
 * edge energy は隣接画素の輝度差分和 (metrics 記録専用・reject gate には使わない — spec §柱2)。
 */
export function computeSampleMetrics(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): SampleMetrics {
  const pixelCount = width * height
  if (pixelCount === 0) {
    return { opaqueRatio: 0, meanLuma: 0, lumaVar: 0, edgeEnergy: 0 }
  }

  const luma = new Float64Array(pixelCount)
  let opaqueCount = 0
  let lumaSum = 0

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4
    const r = data[offset]
    const g = data[offset + 1]
    const b = data[offset + 2]
    const a = data[offset + 3]

    if (a > 0) opaqueCount++

    // ITU-R BT.601 相当の輝度近似
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    luma[i] = l
    lumaSum += l
  }

  const meanLuma = lumaSum / pixelCount

  let varianceSum = 0
  for (let i = 0; i < pixelCount; i++) {
    const diff = luma[i] - meanLuma
    varianceSum += diff * diff
  }
  const lumaVar = varianceSum / pixelCount

  let edgeEnergy = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (x + 1 < width) {
        edgeEnergy += Math.abs(luma[idx] - luma[idx + 1])
      }
      if (y + 1 < height) {
        edgeEnergy += Math.abs(luma[idx] - luma[idx + width])
      }
    }
  }

  return {
    opaqueRatio: opaqueCount / pixelCount,
    meanLuma,
    lumaVar,
    edgeEnergy,
  }
}

/** 入出力サンプル間の平均絶対誤差 (RGB のみ・alpha は opaqueRatio 側で担保)。 */
export function computeMae(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0

  let sum = 0
  let count = 0
  for (let i = 0; i + 3 < len; i += 4) {
    sum += Math.abs(a[i] - b[i])
    sum += Math.abs(a[i + 1] - b[i + 1])
    sum += Math.abs(a[i + 2] - b[i + 2])
    count += 3
  }

  return count === 0 ? 0 : sum / count
}

/**
 * 構造検証結果 + 入出力 metrics + mae から reject 可否を判定する純関数。
 * 誤検知回避最優先: 正当な白/低分散画像は入力分散も低いため VAR_IN_MIN 前提が
 * 不成立となり通過する (spec §柱2)。
 */
export function evaluateValidity(
  structural: { ok: boolean; reason?: string },
  inM: SampleMetrics,
  outM: SampleMetrics,
  mae: number,
): ValidityResult {
  if (!structural.ok) {
    return { ok: false, reason: structural.reason ?? 'structural_invalid' }
  }

  if (inM.opaqueRatio > OPAQUE_IN_MIN && outM.opaqueRatio < OPAQUE_OUT_MAX) {
    return { ok: false, reason: 'opaque_collapse' }
  }

  if (inM.lumaVar > VAR_IN_MIN && outM.lumaVar < VAR_OUT_MAX && mae > MAE_MAX) {
    return { ok: false, reason: 'flat_collapse' }
  }

  return { ok: true }
}

/** blob 先頭バイトから magic-byte を判定する (RIFF..WEBP / \x89PNG / \xFFD8\xFF)。 */
function detectMagicType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  return null
}

/** decode + magic-byte↔type + 寸法のみを検証する (内容は問わない・T5 fallback が元画像に再利用)。 */
export async function validateImageStructure(
  blob: Blob | null | undefined,
  expected?: { width: number; height: number },
): Promise<StructuralResult> {
  if (!blob || blob.size === 0) {
    return { ok: false, reason: 'empty_blob', width: 0, height: 0 }
  }

  if (!blob.type || !ALLOWED_TYPES.has(blob.type)) {
    return { ok: false, reason: 'invalid_type', width: 0, height: 0 }
  }

  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const magicType = detectMagicType(head)
  if (magicType === null || magicType !== blob.type) {
    return { ok: false, reason: 'magic_mismatch', width: 0, height: 0 }
  }

  const decoded = await decodeImage(blob)
  if (!decoded) {
    return { ok: false, reason: 'decode_failed', width: 0, height: 0 }
  }

  const { width, height } = decoded
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: 'decode_failed', width: 0, height: 0 }
  }

  if (expected) {
    const dw = Math.abs(width - expected.width)
    const dh = Math.abs(height - expected.height)
    if (dw > 1 || dh > 1) {
      return { ok: false, reason: 'dimension_mismatch', width, height }
    }
  }

  return { ok: true, width, height }
}

/**
 * 圧縮出力の妥当性を検証する (構造 + 情報消失)。 全経路共通のエントリポイント。
 * 内容検証は入出力を VALIDATE_SAMPLE 角 canvas に全体縮小して比較する
 * (crop でなく全体縮小ゆえ端欠け・片側破損・空描画が縮小版に現れる)。
 */
export async function validateCompressionOutput(
  input: Blob,
  output: Blob,
  expected?: { width: number; height: number },
): Promise<{ ok: boolean; reason?: string; metrics: ValidationMetrics }> {
  const emptyMetrics: SampleMetrics = { opaqueRatio: 0, meanLuma: 0, lumaVar: 0, edgeEnergy: 0 }
  const emptyValidationMetrics: ValidationMetrics = {
    input: emptyMetrics,
    output: emptyMetrics,
    mae: 0,
  }

  const structural = await validateImageStructure(output, expected)
  if (!structural.ok) {
    return { ok: false, reason: structural.reason, metrics: emptyValidationMetrics }
  }

  const inSample = await sampleToCanvas(input)
  const outSample = await sampleToCanvas(output)
  if (!inSample || !outSample) {
    return { ok: false, reason: 'decode_failed', metrics: emptyValidationMetrics }
  }

  const inM = computeSampleMetrics(inSample.data, inSample.width, inSample.height)
  const outM = computeSampleMetrics(outSample.data, outSample.width, outSample.height)
  const mae = computeMae(inSample.data, outSample.data)
  const metrics: ValidationMetrics = { input: inM, output: outM, mae }

  const validity = evaluateValidity({ ok: true }, inM, outM, mae)
  return { ok: validity.ok, reason: validity.reason, metrics }
}

/** WebKit-safe decode (HTMLImageElement + object URL)。 decode 不能時は null。 */
async function decodeImage(blob: Blob): Promise<{ img: HTMLImageElement; width: number; height: number } | null> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (width <= 0 || height <= 0) return null
    return { img, width, height }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** blob を VALIDATE_SAMPLE 角 canvas に全体縮小して ImageData を取得する。 */
async function sampleToCanvas(
  blob: Blob,
): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  const decoded = await decodeImage(blob)
  if (!decoded) return null

  const canvas = document.createElement('canvas')
  canvas.width = VALIDATE_SAMPLE
  canvas.height = VALIDATE_SAMPLE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(decoded.img, 0, 0, VALIDATE_SAMPLE, VALIDATE_SAMPLE)
  const imageData = ctx.getImageData(0, 0, VALIDATE_SAMPLE, VALIDATE_SAMPLE)

  // 使用後は canvas を解放する (連続添付のメモリ圧迫防止・spec Codex#3 と同理由)
  canvas.width = 0
  canvas.height = 0

  return { data: imageData.data, width: VALIDATE_SAMPLE, height: VALIDATE_SAMPLE }
}
