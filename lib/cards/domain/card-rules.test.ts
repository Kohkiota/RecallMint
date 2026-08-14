import { describe, it, expect } from 'vitest'
import type { CardOption } from '@/lib/db/schema'
import {
  NULLABLE_TEXT_FIELDS,
  normalizeNullableTextField,
  deriveCorrectAnswerIds,
} from './card-rules'

describe('normalizeNullableTextField', () => {
  it('nullable 列は空文字を null にする', () => {
    expect(normalizeNullableTextField('question_label', '')).toBeNull()
    expect(normalizeNullableTextField('explanation_text', '')).toBeNull()
    expect(normalizeNullableTextField('memo', '')).toBeNull()
  })

  it('nullable 列でも非空値は素通し', () => {
    expect(normalizeNullableTextField('question_label', 'A-1')).toBe('A-1')
    expect(normalizeNullableTextField('memo', ' ')).toBe(' ') // trim しない (strict === '')
  })

  it('非 nullable 列は空文字でも素通し', () => {
    expect(normalizeNullableTextField('title', '')).toBe('')
    expect(normalizeNullableTextField('question_text', '')).toBe('')
  })

  it('null 入力は null のまま素通し (widened signature D-1)', () => {
    expect(normalizeNullableTextField('memo', null)).toBeNull()
    expect(normalizeNullableTextField('title', null)).toBeNull()
  })

  it('NULLABLE_TEXT_FIELDS は question_label / explanation_text / memo の 3 列', () => {
    expect([...NULLABLE_TEXT_FIELDS].sort()).toEqual([
      'explanation_text',
      'memo',
      'question_label',
    ])
  })
})

describe('deriveCorrectAnswerIds', () => {
  it('is_correct な option の id を順序保存で返す', () => {
    const options: CardOption[] = [
      { id: 'a', text: '', is_correct: true },
      { id: 'b', text: '', is_correct: false },
      { id: 'c', text: '', is_correct: true },
    ]
    expect(deriveCorrectAnswerIds(options)).toEqual(['a', 'c'])
  })

  it('正解なしは空配列', () => {
    expect(
      deriveCorrectAnswerIds([{ id: 'a', text: '', is_correct: false }]),
    ).toEqual([])
  })
})
