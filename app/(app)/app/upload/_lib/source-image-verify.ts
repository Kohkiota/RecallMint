import sharp from 'sharp'
import { MAX_IMAGE_DIMENSION } from '@/app/(app)/app/exams/[id]/_actions/asset-limits'

// ②-4a Task 5(build-blocker fix・2026-07-31): source finalize の実バイト検証
// helper を集約する directive 無し module。
//
// なぜ独立 file か: `../_actions/source-asset-actions.ts` は 'use server' を
// 持つ Server Actions file であり、 Next.js の SWC "use server" transform は
// 「非 async 関数の export」を compile error(71011: Only async functions are
// allowed to be exported in a "use server" file)にする(asset-limits.ts の
// 既存コメント・②-4a T4 の前例と同じ制約 — tsc/eslint はこの制約を検出せず
// `pnpm build` でのみ表面化する)。 `reconcileSniffedAndDecodedMime` のような
// sync pure 関数を 'use server' file から export すると build がここで落ちる
// ため、 pure/sync な検証ヘルパー・定数をこの file へ切り出し、
// source-asset-actions.ts からは import のみ行う(reserveSource/finalizeSource
// という async server action 2 つだけを export する形に保つ)。

export const IMAGE_MIME_ENUM = ['image/webp', 'image/png', 'image/jpeg'] as const
export type ImageMime = (typeof IMAGE_MIME_ENUM)[number]

export const MIME_EXT: Record<ImageMime, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

// Critical fix(Codex 指摘・2026-07-31): sharp 既定値(268,402,689px =
// 0x3FFF×0x3FFF)は本用途には高すぎる — 4 channel(RGBA)想定で ≈1GB の decode
// メモリを許してしまい、 5 MiB(MAX_ASSET_BYTES)以下の高圧縮単色 PNG/WebP でも
// 到達可能(認証済 client が serverless function を OOM させられる)。
// 代わりに「想定される試験ページ画像」に合わせた値を採る: A4 スキャン @600DPI
// ≈ 4960×7016 ≈ 34.8M px。 高解像度スキャンを十分許容しつつ decode bomb を
// 遮断する安全マージンとして **40,000,000px**(≈160MB decoded @RGBA)を採用する
// (MAX_IMAGE_DIMENSION(asset-limits.ts・Postgres integer overflow 防衛の
// 辺長上限)とは別目的の値 — 極端なアスペクト比(例: 1×10,000,000)は総
// ピクセル数では小さくても辺長では MAX_IMAGE_DIMENSION 超になりうるため、
// 両チェックを独立に課す)。
export const DECODE_MAX_PIXELS = 40_000_000

// magic-byte signature(先頭バイト判定)。 sharp へ渡す前の高速 reject +
// sharp decode 結果の format との突合せ(2 経路一致で defense-in-depth —
// sharp 自体は gif/tiff/heif 等 enum 外の形式もデコードしうるため、 sniff で
// enum 内 3 種のみに絞ってから decode 結果と一致させる)。
export function sniffMagicBytes(bytes: Buffer): ImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
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
  return null
}

const SHARP_FORMAT_TO_MIME: Partial<Record<string, ImageMime>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export type VerifiedImage = { mime: ImageMime; width: number; height: number }

/**
 * magic-byte sniff の結果と sharp decode 結果の format を突合せる(pure・
 * defense-in-depth の2本目)。 3 形式のシグネチャ先頭バイトは相互排他
 * (0x89/0xFF/0x52 で重複なし)かつ sharp 自身の format dispatch も magic-byte
 * 起点のため、 実バイトでこの分岐が不一致になることは実質ない(実測: 先頭 8
 * バイトを PNG 署名にし残りを別形式の実バイトにした frankenstein buffer は
 * sharp が「corrupt header」で decode 自体に失敗する — 一致した decoder が
 * 選ばれるので「別 format として成功裏に decode される」ケースは作れない)。
 * それでも構造的な保証として明示チェックする。 pure 関数として分離し、 sharp
 * を mock せずにこの分岐を直接 pin できるようにする(unit test 参照)。
 */
export function reconcileSniffedAndDecodedMime(
  sniffed: ImageMime,
  decodedFormat: string,
): ImageMime | null {
  const decodedMime = SHARP_FORMAT_TO_MIME[decodedFormat]
  if (!decodedMime || decodedMime !== sniffed) return null
  return decodedMime
}

/**
 * 実バイトから mime/寸法を検証・算出する(client 申告値は一切参照しない)。
 * 失敗は null に正規化(呼出側は headObject 同様「検証不能」を一律扱えばよい)。
 *
 * 手順: ① magic-byte sniff(enum 外形式を早期 reject)② sharp `metadata()`
 * (ヘッダのみ読込・圧縮ピクセルデータは decode しない)で width×height を取得し
 * `DECODE_MAX_PIXELS` 超過を明示 reject(Critical fix・defense-in-depth: sharp
 * の `limitInputPixels` は OpenInput = ヘッダ読込時点で同じ判定を行い
 * `toBuffer()` 単体呼出でも decode 前に throw する実測済みだが、 「寸法確認は
 * 必ず重い decode より先に行う」契約をコード上でも明示するため、 metadata()
 * の結果を使い同じ上限を自前でも検査する)③ sharp decode(`toBuffer()`。
 * 出力先を指定しないため入力と同一 format へ再エンコードされ、 実ピクセル
 * デコードが強制される=「decodeability」検証を兼ねる。 truncated body は
 * ここで throw する)④ sniff と decode format の一致
 * (reconcileSniffedAndDecodedMime)⑤ MAX_IMAGE_DIMENSION(辺長)上限。 promote
 * するのは GET で取得した元バイトそのもの(sharp の再エンコード出力は使わない
 * — 「検証済バイト」= 実在確認済みの元バイト)。
 */
export async function verifyImageBytes(bytes: Buffer): Promise<VerifiedImage | null> {
  const sniffed = sniffMagicBytes(bytes)
  if (sniffed === null) return null

  const pipeline = sharp(bytes, { limitInputPixels: DECODE_MAX_PIXELS })

  let meta: { width?: number; height?: number }
  try {
    meta = await pipeline.metadata()
  } catch {
    // corrupt / limitInputPixels 超過(sharp が OpenInput 時点で throw する —
    // 実ピクセルデコードは行われていない)。
    return null
  }
  if (
    meta.width === undefined ||
    meta.height === undefined ||
    meta.width * meta.height > DECODE_MAX_PIXELS
  ) {
    // defense-in-depth: metadata() が例外を投げなかった場合でも、 ここで
    // toBuffer() の重い decode に進む前に明示的に遮断する。
    return null
  }

  let info: { format: string; width: number; height: number }
  try {
    const result = await pipeline.toBuffer({ resolveWithObject: true })
    info = result.info
  } catch {
    // corrupt / truncated / limitInputPixels 超過
    return null
  }

  const decodedMime = reconcileSniffedAndDecodedMime(sniffed, info.format)
  if (!decodedMime) return null
  if (info.width > MAX_IMAGE_DIMENSION || info.height > MAX_IMAGE_DIMENSION) return null

  return { mime: decodedMime, width: info.width, height: info.height }
}
