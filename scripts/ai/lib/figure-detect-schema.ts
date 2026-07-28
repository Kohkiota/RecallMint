// arm B (figure_regions 検出) の response schema / prompt suffix と、
// box_2d 単体 viz (T7) 用の standalone schema / prompt。 ②-0 OCR regression 基盤の一部。
//
// buildArmBResponseSchema は本番 buildDiscoverResponseJsonSchema() の出力に、
// 各 card へ figure_regions を optional field として注入する (target 語彙
// question / option_{id} / explanation は OCR ネイティブ、 DB 保存側 mapping は
// 本 task の範囲外 = ②-4 持ち越し)。
//
// buildDiscoverResponseJsonSchema() は呼び出しごとに新規 object literal を返す
// stateless factory (共有/キャッシュ状態を持たない) なので、 その出力をこの関数内で
// mutate しても他の呼び出し元には一切影響しない — outer 側の deep-clone は不要
// (YAGNI、 review 2026-07-28 round-2 で vacuous test ごと除去。 もし将来
// buildDiscoverResponseJsonSchema 側が結果をキャッシュするよう変わったら、
// その変更と同時に outer clone を足すこと)。
// 一方 FIGURE_REGION_ITEM_SCHEMA は module 定数で複数呼び出し・複数関数
// (buildArmBResponseSchema / buildBox2dVizSchema) 間で共有されるため、 こちらは
// 呼び出しごとに structuredClone して embed する (真に load-bearing、 テストで pin 済み)。

import { buildDiscoverResponseJsonSchema } from '@/lib/ai/schemas/ocr-response'

// figure_regions[] の 1 要素の schema。 box_2d は [y_min, x_min, y_max, x_max]
// (画像を 0-1000 に正規化、 y が先) で統一する。
const FIGURE_REGION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    box_2d: { type: 'array', items: { type: 'number' } },
    target: { type: 'string' },
    label: { type: 'string' },
  },
  required: ['box_2d', 'target'],
  additionalProperties: false,
} as const

export function buildArmBResponseSchema(): Record<string, unknown> {
  // buildDiscoverResponseJsonSchema() は呼ぶたびに新規 object を返すため、
  // ここで直接 mutate しても他の呼び出し元には影響しない (ファイル冒頭コメント参照)。
  const schema = buildDiscoverResponseJsonSchema() as {
    properties: {
      cards: {
        items: {
          properties: Record<string, unknown>
        }
      }
    }
  }
  schema.properties.cards.items.properties.figure_regions = {
    type: 'array',
    items: structuredClone(FIGURE_REGION_ITEM_SCHEMA),
  }
  // NOTE: card の required 配列には追加しない (figure_regions は optional)。
  return schema
}

export function buildArmBPromptSuffix(): string {
  return [
    '【figure_regions (図/写真領域の検出、追加指示)】',
    '',
    '上記の抽出に加え、各 card について図・写真・グラフ等の **図版領域のみ** を検出し、',
    'figure_regions[] として返すこと。 文字のみの領域は対象外、座標を返さないこと。',
    '',
    '- box_2d: [y_min, x_min, y_max, x_max] (ページ画像を 0-1000 に正規化した座標、y が先)',
    '- target: 図が属する箇所。 "question" / "option_{id}" ({id} はその card の',
    '  options[].id と完全一致) / "explanation" のいずれか',
    '- label: 図の簡潔な説明 (optional)',
    '- 図が無い card は figure_regions を省略するか空配列で返してよい',
  ].join('\n')
}

export function buildBox2dVizSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      regions: {
        type: 'array',
        items: structuredClone(FIGURE_REGION_ITEM_SCHEMA),
      },
    },
    required: ['regions'],
    additionalProperties: false,
  }
}

export function buildBox2dVizPrompt(): string {
  return [
    'このページ画像内の図・写真・グラフ等の図版領域を検出し、regions[] として返すこと。',
    '文字のみの領域は対象外、座標を返さないこと。',
    '',
    '- box_2d: [y_min, x_min, y_max, x_max] (画像を 0-1000 に正規化した座標、y が先)',
    '- target: 図が属する箇所。 "question" / "option_{id}" / "explanation" のいずれか',
    '- label: 図の簡潔な説明 (optional)',
  ].join('\n')
}
