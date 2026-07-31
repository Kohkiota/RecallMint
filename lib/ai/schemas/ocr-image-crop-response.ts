// ②-4a 探索用 response JSON Schema (未公開・段階的探索の一部、本番非採用)。
//
// 本番 `buildDiscoverResponseJsonSchema()` (lib/ai/schemas/ocr-response.ts) は
// 変更しない (spec §5.1)。 この file はその出力を copy し、 各 card に
// `figure_regions` を **optional** で注入した探索 schema を提供する
// (card の `required` には追加しない — 図が無い card を壊さないため)。
//
// 由来: scripts/ai/lib/figure-detect-schema.ts (②-0 OCR regression 基盤の
// arm B probe) と同じ injection パターン。 相違点は figure_regions 要素に
// `source_id` (必須) を追加し、 `box_2d` を nullable 必須にしたこと
// (②-4a は複数画像入稿を source_id で束ねるため、 座標を確信できない場合に
// 推測せず null を返させる契約が要る。spec §4.1/§5.1/§5.2)。
//
// discover mode の `custom_props` が任意キーを許すため、 本番と同じく
// full JSON Schema (`responseJsonSchema`) 経路を使う (OpenAPI subset の
// `responseSchema` は additionalProperties を受けない)。 nullable の表現も
// OpenAPI subset の `nullable: true` ではなく、 responseJsonSchema がサポートする
// `anyOf` (SDK doc: type/items/anyOf/required/additionalProperties 等のみ対応、
// `nullable` は非対応) で `[type:'array'] | [type:'null']` として明示する。

import { buildDiscoverResponseJsonSchema } from './ocr-response'

export type FigureRegion = {
  source_id: string
  // 推測禁止: 座標を確信を持って決定できない場合はモデルが null を返す契約
  // (spec §5.1・§13の隔離ルールで「座標 null」除外理由に対応)。
  box_2d: [number, number, number, number] | null
  // "question" | "option_{id}" | "explanation" の生文字列。 option_{id} は
  // card ごとに動的なため JSON Schema の enum では表現しない (raw string のまま
  // 返し、 target→option:<uid> 等への変換は T8 の正規化層が担う。spec §13)。
  target: string
  label?: string
  // ②-4b (PDF ページ) 予約。 ②-4a (画像入稿) では未使用。
  page?: number
}

export type ImageCropExtractedCard = {
  title: string
  sort_key?: string
  question_text: string
  options: Array<{
    id: string
    text: string
    is_correct: boolean
    explanation?: string
  }>
  correct_answer_ids: string[]
  explanation_text?: string
  images: Array<{
    key: string
    target: string
    alt: string
    source_ref?: string
  }>
  custom_props?: Record<string, string | string[]>
  figure_regions?: FigureRegion[]
}

export type ImageCropDiscoverResponse = {
  cards: ImageCropExtractedCard[]
}

// figure_regions[] の 1 要素の schema。 box_2d の null 許容が本番 (arm B probe) との
// 唯一の構造差。
const FIGURE_REGION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    source_id: { type: 'string' },
    box_2d: {
      anyOf: [
        {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
        },
        { type: 'null' },
      ],
    },
    target: { type: 'string' },
    label: { type: 'string' },
    page: { type: 'number' },
  },
  // source_id / box_2d / target は必須 (box_2d は required だが値は null を許容 =
  // 「フィールド自体を省略してよい」ではなく「値として null を明示的に返す」契約)。
  required: ['source_id', 'box_2d', 'target'],
  additionalProperties: false,
} as const

export function buildImageCropResponseJsonSchema(): Record<string, unknown> {
  // buildDiscoverResponseJsonSchema() は呼び出しごとに新規 object を返す stateless
  // factory (ocr-response.ts 側コメント参照) のため、 ここで直接 mutate しても
  // 他の呼び出し元 (本番 pipeline 含む) には一切影響しない。
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
  // NOTE: card の required 配列には figure_regions を追加しない (optional・
  // 図が無い card を壊さないため。spec §5.1)。
  return schema
}
