import { Type } from '@google/genai'

export type PropertyType =
  | 'single_select'
  | 'multi_select'
  | 'number'
  | 'boolean'
  | 'date'
  | 'text'

export type PropertyDef = {
  name: string
  type: PropertyType
  select_options?: string[]
  default_value?: unknown
  is_system?: boolean
  display_order: number
}

export type PropertySchema = PropertyDef[]

type GenaiSchema = Record<string, unknown>

function propertyDefToSchema(def: PropertyDef): GenaiSchema {
  switch (def.type) {
    case 'single_select': {
      const base: GenaiSchema = { type: Type.STRING }
      if (def.select_options?.length) base.enum = def.select_options
      return base
    }
    case 'multi_select': {
      const items: GenaiSchema = { type: Type.STRING }
      if (def.select_options?.length) items.enum = def.select_options
      return { type: Type.ARRAY, items }
    }
    case 'number':
      return { type: Type.NUMBER }
    case 'boolean':
      return { type: Type.BOOLEAN }
    case 'date':
      return { type: Type.STRING, format: 'date' }
    case 'text':
      return { type: Type.STRING }
  }
}

export function buildCustomPropsSchema(schema: PropertySchema): GenaiSchema {
  const properties: Record<string, GenaiSchema> = {}
  const ordered = [...schema].sort((a, b) => a.display_order - b.display_order)
  for (const def of ordered) properties[def.name] = propertyDefToSchema(def)
  return {
    type: Type.OBJECT,
    properties,
    propertyOrdering: ordered.map((d) => d.name),
  }
}

// 自由発見 (discover) モード用の JSON Schema。
// responseSchema (OpenAPI subset) では additionalProperties が未サポートのため、
// custom_props を任意キーで許す目的では responseJsonSchema 経路を使う。
// (cf. @google/genai dist/genai.d.ts: responseJsonSchema は JSON Schema 標準を受け、
//  additionalProperties / anyOf もそのまま使える)
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

export function buildResponseSchema(propertySchema: PropertySchema): GenaiSchema {
  return {
    type: Type.OBJECT,
    properties: {
      cards: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            sort_key: { type: Type.STRING },
            question_text: { type: Type.STRING },
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  text: { type: Type.STRING },
                  is_correct: { type: Type.BOOLEAN },
                  explanation: { type: Type.STRING },
                },
                propertyOrdering: ['id', 'text', 'is_correct', 'explanation'],
                required: ['id', 'text', 'is_correct'],
              },
            },
            correct_answer_ids: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            explanation_text: { type: Type.STRING },
            images: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  key: { type: Type.STRING },
                  target: { type: Type.STRING },
                  alt: { type: Type.STRING },
                  source_ref: { type: Type.STRING },
                },
                propertyOrdering: ['key', 'target', 'alt', 'source_ref'],
                required: ['key', 'target', 'alt'],
              },
            },
            custom_props: buildCustomPropsSchema(propertySchema),
          },
          propertyOrdering: [
            'title',
            'sort_key',
            'question_text',
            'options',
            'correct_answer_ids',
            'explanation_text',
            'images',
            'custom_props',
          ],
          required: [
            'title',
            'question_text',
            'options',
            'correct_answer_ids',
            'images',
          ],
        },
      },
    },
    propertyOrdering: ['cards'],
    required: ['cards'],
  }
}
