// Discover mode OCR response JSON Schema (Gemini 2.5、 @google/genai SDK)。
//
// 由来: scripts/ocr-poc/schema.ts (commit 26a1c4e、 commit 0a5ec0d で削除済)。
// `buildDiscoverResponseJsonSchema` のみ移植 (schema mode `buildResponseSchema` /
// `buildCustomPropsSchema` / `PropertyType` 等は本実装では非採用、 v1.x で
// 必要になったら git history から復元する)。
//
// 重要: discover mode は `custom_props` を任意キーで許すため、 OpenAPI subset
// (`responseSchema`) ではなく、 full JSON Schema (`responseJsonSchema`) 経路を使う。
// SDK 側 (@google/genai dist/genai.d.ts) で additionalProperties / anyOf を
// そのまま受ける実装が確認できる。

// 抽出済 card 1 件の構造 (DB 側 cards.options / cards.images の TS 型 と整合)。
export type ExtractedOption = {
  id: string
  text: string
  is_correct: boolean
  explanation?: string
}

export type ExtractedImage = {
  key: string
  target: string
  alt: string
  source_ref?: string
}

export type ExtractedCard = {
  title: string
  sort_key?: string
  question_text: string
  options: ExtractedOption[]
  correct_answer_ids: string[]
  explanation_text?: string
  images: ExtractedImage[]
  custom_props?: Record<string, string | string[]>
}

export type DiscoverResponse = {
  cards: ExtractedCard[]
}

// responseJsonSchema 用の JSON Schema (full JSON Schema 標準、 OpenAPI subset
// ではない)。 cards 必須、 各 card 内 fields の必須 / optional は PoC と一致。
export function buildDiscoverResponseJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            sort_key: { type: 'string' },
            question_text: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  is_correct: { type: 'boolean' },
                  explanation: { type: 'string' },
                },
                required: ['id', 'text', 'is_correct'],
                additionalProperties: false,
              },
            },
            correct_answer_ids: {
              type: 'array',
              items: { type: 'string' },
            },
            explanation_text: { type: 'string' },
            images: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  target: { type: 'string' },
                  alt: { type: 'string' },
                  source_ref: { type: 'string' },
                },
                required: ['key', 'target', 'alt'],
                additionalProperties: false,
              },
            },
            custom_props: {
              type: 'object',
              additionalProperties: {
                anyOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
            },
          },
          required: [
            'title',
            'question_text',
            'options',
            'correct_answer_ids',
            'images',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['cards'],
    additionalProperties: false,
  }
}
