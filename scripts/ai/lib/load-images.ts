// 画像/PDF ファイルをファイルパスから読み込み、 GeminiInputFile (base64 inlineData) に
// 変換する。 拡張子 allowlist で mime を決定し、 未知拡張子は throw する (推測しない、
// loud に落とす)。 ②-0 OCR regression 基盤 (capture / model-compare / box_2d-viz が共有)。

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { GeminiInputFile } from '@/lib/ai/clients/gemini'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

export function loadImageInline(path: string): GeminiInputFile {
  const ext = extname(path).toLowerCase()
  const mimeType = MIME_BY_EXT[ext]
  if (!mimeType) {
    throw new Error(
      `loadImageInline: unsupported extension "${ext}" for ${path} (allowlist: ${Object.keys(MIME_BY_EXT).join(', ')})`,
    )
  }
  const data = readFileSync(path).toString('base64')
  return { mimeType, data }
}
