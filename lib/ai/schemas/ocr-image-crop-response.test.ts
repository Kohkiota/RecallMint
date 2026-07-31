import { describe, it, expect } from 'vitest'
import { buildDiscoverResponseJsonSchema } from './ocr-response'
import { buildImageCropResponseJsonSchema } from './ocr-image-crop-response'

// 型を緩く扱う (JSON Schema の Record<string, unknown> を都度 narrow するのは冗長)。
type JsonSchemaObject = {
  properties: {
    cards: {
      items: {
        properties: Record<string, unknown> & {
          figure_regions?: {
            type: string
            items: {
              type: string
              properties: Record<string, unknown>
              required: string[]
              additionalProperties: boolean
            }
          }
        }
        required: string[]
        additionalProperties: boolean
      }
    }
  }
  required: string[]
  additionalProperties: boolean
}

function build(): JsonSchemaObject {
  return buildImageCropResponseJsonSchema() as unknown as JsonSchemaObject
}

describe('buildImageCropResponseJsonSchema', () => {
  it('本番 buildDiscoverResponseJsonSchema を触らない (production schema 不変)', () => {
    const before = buildDiscoverResponseJsonSchema()
    build()
    const after = buildDiscoverResponseJsonSchema()
    expect(after).toEqual(before)
    // figure_regions が production 側に紛れ込んでいないことを明示的に確認。
    const cardProps = (
      after as { properties: { cards: { items: { properties: Record<string, unknown> } } } }
    ).properties.cards.items.properties
    expect(cardProps).not.toHaveProperty('figure_regions')
  })

  it('card に figure_regions を注入するが、card の required には追加しない (optional)', () => {
    const schema = build()
    const cardSchema = schema.properties.cards.items
    expect(cardSchema.properties.figure_regions).toBeDefined()
    expect(cardSchema.required).not.toContain('figure_regions')
    // 既存の必須 field はそのまま維持されている (production と同一内容)。
    expect(cardSchema.required).toEqual([
      'title',
      'question_text',
      'options',
      'correct_answer_ids',
      'images',
    ])
  })

  it('figure_regions 要素は source_id / box_2d / target を required とする', () => {
    const schema = build()
    const itemSchema = schema.properties.cards.items.properties.figure_regions!.items
    expect(itemSchema.required).toEqual(
      expect.arrayContaining(['source_id', 'box_2d', 'target']),
    )
    expect(itemSchema.additionalProperties).toBe(false)
  })

  it('box_2d は required だが値として null を許容する (nullable を anyOf で明示、推測禁止契約)', () => {
    const schema = build()
    const itemSchema = schema.properties.cards.items.properties.figure_regions!.items
    const box2d = itemSchema.properties.box_2d as {
      anyOf: Array<{ type: string; items?: { type: string }; minItems?: number; maxItems?: number }>
    }
    expect(box2d.anyOf).toBeDefined()
    // 配列 branch: 4 要素の number 配列
    const arrayBranch = box2d.anyOf.find((b) => b.type === 'array')
    expect(arrayBranch).toBeDefined()
    expect(arrayBranch!.items).toEqual({ type: 'number' })
    expect(arrayBranch!.minItems).toBe(4)
    expect(arrayBranch!.maxItems).toBe(4)
    // null branch: 座標を確信できない場合はここに落ちる契約
    const nullBranch = box2d.anyOf.find((b) => b.type === 'null')
    expect(nullBranch).toBeDefined()
    // required に box_2d 自体は含まれる (フィールド省略は不可、値として null は可)
    expect(itemSchema.required).toContain('box_2d')
  })

  it('label と page は optional (required に含まれない)', () => {
    const schema = build()
    const itemSchema = schema.properties.cards.items.properties.figure_regions!.items
    expect(itemSchema.properties.label).toBeDefined()
    expect(itemSchema.properties.page).toBeDefined()
    expect(itemSchema.required).not.toContain('label')
    expect(itemSchema.required).not.toContain('page')
  })

  it('target は raw string (dynamic option_{id} を enum で表現しない)', () => {
    const schema = build()
    const itemSchema = schema.properties.cards.items.properties.figure_regions!.items
    expect(itemSchema.properties.target).toEqual({ type: 'string' })
  })

  it('毎回新規 object を返す (mutate が呼び出し間で漏れない)', () => {
    const a = build()
    const b = build()
    expect(a).not.toBe(b)
    expect(a.properties.cards.items.properties.figure_regions).not.toBe(
      b.properties.cards.items.properties.figure_regions,
    )
  })
})
