import { describe, it, expect } from 'vitest'
import { imagesSchema } from './card'

// imagesSchema の unit test (画像フェーズ A Task 5)。
//
// spec: docs/superpowers/specs/2026-07-12-image-phase-a-design.md §2.2 / §3.3
//
// 観点:
//   - 正常: UUID key + target 'question_text' / 'option:...' → pass
//   - url 非空 → reject / url='' or 未指定 → pass
//   - 配列 > 10 件 → reject
//   - UUID key + 不正 target → reject
//   - 非 UUID key (legacy OCR 参照) は target 形式強制の対象外 (passthrough)

const UUID_KEY = '11111111-1111-4111-a111-111111111111'

describe('imagesSchema', () => {
  it('正常: UUID key + target=question_text → pass', () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'question_text', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('正常: UUID key + target=option:xxx → pass', () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'option:a', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  // Sprint I W2: 解説/メモへの画像添付を許容する target widen。
  it('正常: UUID key + target=explanation_text → pass (Sprint I W2 widen)', () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'explanation_text', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('正常: UUID key + target=memo → pass (Sprint I W2 widen)', () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'memo', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('url が非空 → reject', () => {
    const result = imagesSchema.safeParse([
      {
        key: UUID_KEY,
        target: 'question_text',
        alt: '',
        url: 'https://example.com/x.png',
      },
    ])
    expect(result.success).toBe(false)
  })

  it("url='' → pass", () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'question_text', alt: '', url: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('url 未指定 → pass', () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'question_text', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('11 件 (>10) → reject', () => {
    const entries = Array.from({ length: 11 }, (_, i) => ({
      key: UUID_KEY,
      target: 'question_text',
      alt: `${i}`,
    }))
    const result = imagesSchema.safeParse(entries)
    expect(result.success).toBe(false)
  })

  it('10 件 (境界値) → pass', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      key: UUID_KEY,
      target: 'question_text',
      alt: `${i}`,
    }))
    const result = imagesSchema.safeParse(entries)
    expect(result.success).toBe(true)
  })

  it('UUID key + 不正 target (foo) → reject', () => {
    const result = imagesSchema.safeParse([
      { key: UUID_KEY, target: 'foo', alt: '' },
    ])
    expect(result.success).toBe(false)
  })

  it('非 UUID key (legacy OCR 参照) は target 形式強制なし → 任意 target で pass', () => {
    const result = imagesSchema.safeParse([
      { key: 'legacy-ocr-ref-1', target: 'foo', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('非 v4 UUID key (v1) は legacy 扱い → target 形式強制なし (spec §2.2 は UUIDv4 限定)', () => {
    // v1 UUID (version nibble = 1)。 z.uuid() なら誤って asset 扱いになるが、
    // isAssetKey は v4 厳密ゆえ legacy passthrough とし任意 target で pass する。
    const result = imagesSchema.safeParse([
      { key: '11111111-1111-1111-8111-111111111111', target: 'foo', alt: '' },
    ])
    expect(result.success).toBe(true)
  })

  it('key が空文字 → reject (min 1)', () => {
    const result = imagesSchema.safeParse([
      { key: '', target: 'question_text', alt: '' },
    ])
    expect(result.success).toBe(false)
  })

  it('空配列 → pass (画像なし card は許容)', () => {
    const result = imagesSchema.safeParse([])
    expect(result.success).toBe(true)
  })
})
