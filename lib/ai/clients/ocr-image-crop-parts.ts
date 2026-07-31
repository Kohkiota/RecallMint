// ②-4a 探索用: source_id-interleaved Gemini parts 組立 (spec §5.2)。
//
// 本番 pipeline (lib/ai/ocr.ts) の default parts 組立 ([...files, prompt]、
// source_id ラベル無し) は変更しない。 この pure builder は
// `[text "source_id=X1", image1, text "source_id=X2", image2, …, text prompt]`
// の順で parts を組み立て、 callGemini({ ..., parts }) (lib/ai/clients/gemini.ts の
// optional override) 経由でそのまま Gemini に渡す。
//
// 目的: client 発行の source_id を画像の直前に text ラベルとして挟むことで、
// モデルに figure_regions[].source_id として書き写させ、 複数画像入稿でも
// どの図版がどの画像由来かを一意に解決できるようにする (source_id は
// source_document 内 unique、送信順 index には依存しない)。

import type { GeminiContentPart, GeminiInputFile } from './gemini'

export type SourceIdImage = {
  sourceId: string
  file: GeminiInputFile
}

export function buildSourceIdInterleavedParts(
  sources: SourceIdImage[],
  prompt: string,
): GeminiContentPart[] {
  const parts: GeminiContentPart[] = []
  for (const { sourceId, file } of sources) {
    // 画像の直前に "source_id=X" ラベルを置き、 モデルに書き写させる (spec §5.2)。
    parts.push({ text: `source_id=${sourceId}` })
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } })
  }
  parts.push({ text: prompt })
  return parts
}
