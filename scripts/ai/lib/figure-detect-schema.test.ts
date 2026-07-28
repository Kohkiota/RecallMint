import { describe, it, expect } from 'vitest'
import {
  buildArmBResponseSchema,
  buildArmBPromptSuffix,
  buildBox2dVizSchema,
  buildBox2dVizPrompt,
} from './figure-detect-schema'

// pure 関数のみ (mock 不要)。 brief がハード制約とした不変条件を pin する:
// - figure_regions は各 card の properties に存在するが required には無い (optional)
// - figure_regions の item shape (box_2d/target/label + required)
// - 2 回の buildArmBResponseSchema() 呼び出しが figure_regions.items を共有しない
//   (module 定数 FIGURE_REGION_ITEM_SCHEMA の structuredClone が真に load-bearing。
//   review 2026-07-28 round-2: 「本番 buildDiscoverResponseJsonSchema() への
//   mutate 非漏れ」を検証する test は、当該 factory がそもそも呼び出しごとに新規
//   object を返す stateless 関数のため、 outer clone の有無に関わらず常に green
//   になる vacuous test だった (regressed 実装でも pass する = 検出力ゼロ) ため削除。
//   figure-detect-schema.ts 冒頭コメント参照。)
// - buildBox2dVizSchema() は brief 指定の shape ({regions:[{box_2d,target,label}]})

type CardsSchema = {
  properties: {
    cards: {
      items: {
        properties: Record<string, unknown>
        required: string[]
      }
    }
  }
}

describe('buildArmBResponseSchema', () => {
  it('figure_regions は各 card の properties に存在するが required には含まれない (optional)', () => {
    const armB = buildArmBResponseSchema() as unknown as CardsSchema
    const cardItem = armB.properties.cards.items
    expect(cardItem.properties.figure_regions).toBeDefined()
    expect(cardItem.required).not.toContain('figure_regions')
  })

  it('figure_regions の item shape は box_2d(number[])/target(string)/label(string) + required=[box_2d,target]', () => {
    const armB = buildArmBResponseSchema() as unknown as CardsSchema
    const figureRegions = armB.properties.cards.items.properties.figure_regions as {
      type: string
      items: unknown
    }
    expect(figureRegions.type).toBe('array')
    expect(figureRegions.items).toEqual({
      type: 'object',
      properties: {
        box_2d: { type: 'array', items: { type: 'number' } },
        target: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['box_2d', 'target'],
      additionalProperties: false,
    })
  })

  it('2 回呼び出しても figure_regions.items は互いに独立した object (共有 reference しない)', () => {
    const armB1 = buildArmBResponseSchema() as unknown as CardsSchema
    const armB2 = buildArmBResponseSchema() as unknown as CardsSchema
    const items1 = (
      armB1.properties.cards.items.properties.figure_regions as { items: unknown }
    ).items
    const items2 = (
      armB2.properties.cards.items.properties.figure_regions as { items: unknown }
    ).items
    expect(items1).not.toBe(items2)
    expect(items1).toEqual(items2)
  })
})

describe('buildArmBPromptSuffix', () => {
  it('空でない文字列を返す', () => {
    expect(typeof buildArmBPromptSuffix()).toBe('string')
    expect(buildArmBPromptSuffix().length).toBeGreaterThan(0)
  })
})

describe('buildBox2dVizSchema', () => {
  it('{ regions: [{box_2d,target,label}] } の shape・required=[regions]・item required=[box_2d,target]', () => {
    const schema = buildBox2dVizSchema()
    expect(schema).toEqual({
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              box_2d: { type: 'array', items: { type: 'number' } },
              target: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['box_2d', 'target'],
            additionalProperties: false,
          },
        },
      },
      required: ['regions'],
      additionalProperties: false,
    })
  })
})

describe('buildBox2dVizPrompt', () => {
  it('空でない文字列を返す', () => {
    expect(typeof buildBox2dVizPrompt()).toBe('string')
    expect(buildBox2dVizPrompt().length).toBeGreaterThan(0)
  })
})
