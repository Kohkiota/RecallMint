// ②-4a 探索用プロンプト = 本番 `buildDiscoverPrompt()` (lib/ai/prompts/ocr-extract.ts)
// を変更せず import し、 図版検出の追加指示 (suffix) を末尾に連結したもの (spec §5.1)。
//
// 本番 prompt を書き換えず「合成」する理由: ②-4a は未公開の探索段階であり、
// 本番 OCR pipeline (lib/ai/ocr.ts) の抽出品質に影響を与えてはならない
// (task brief: 本番 schema/prompt 不触)。

import { buildDiscoverPrompt } from './ocr-extract'

// figure_regions 検出の追加指示。 座標契約は spec §4.1 (0-1000 正規化、
// [y_min,x_min,y_max,x_max]) / §4.2 (crop 元はモデルに送ったバイトと同一) /
// §5.2 (source_id は client 発行・画像直前の text ラベルをモデルに書き写させる) に従う。
export function buildFigureDetectionSuffix(): string {
  return [
    '【figure_regions (②-4a 探索: 図版領域の検出、追加指示)】',
    '',
    '上記の抽出に加え、各 card について、添付された画像内にある図・写真・グラフ等の',
    '**図版領域のみ** を検出し、figure_regions[] として返すこと。',
    '文字のみの領域 (表・本文) は対象外、座標を返さないこと。',
    '',
    '- source_id: この図版が写っている画像の source_id。',
    '  各画像の直前に "source_id=X" というテキストラベルが与えられているので、',
    '  その X の値をそのまま書き写すこと (推測や別画像の source_id の流用は禁止)。',
    '- box_2d: [y_min, x_min, y_max, x_max]',
    '  (その画像 1 枚を 0-1000 に軸別正規化した座標、y が先)。',
    '  **座標を確信を持って決定できない場合は推測せず、必ず box_2d: null を返すこと**',
    '  (誤った座標を返すより null の方が安全)。',
    '- target: 図が属する箇所。 "question" / "option_{id}"',
    '  ({id} はその card の options[].id と完全一致) / "explanation" のいずれか。',
    '- label: 図の簡潔な説明 (optional)。',
    '- 図版が無い card は figure_regions を省略するか空配列で返してよい。',
  ].join('\n')
}

// 本番 prompt + 図版検出 suffix の合成 (連結のみ、本番側の文言は一切変更しない)。
export function buildImageCropExplorationPrompt(): string {
  return [buildDiscoverPrompt(), buildFigureDetectionSuffix()].join('\n\n')
}
