import { describe, it, expect } from 'vitest'
import type { CardOption } from '@/lib/db/schema'
import type { EmptyCard } from './empty-card'
import {
  NULLABLE_TEXT_FIELDS,
  normalizeNullableTextField,
  buildNewCardMutationPatch,
  deriveCorrectAnswerIds,
} from './card-write'

describe('normalizeNullableTextField', () => {
  it('nullable 列は空文字を null にする', () => {
    expect(normalizeNullableTextField('sort_key', '')).toBeNull()
    expect(normalizeNullableTextField('explanation_text', '')).toBeNull()
    expect(normalizeNullableTextField('memo', '')).toBeNull()
  })

  it('nullable 列でも非空値は素通し', () => {
    expect(normalizeNullableTextField('sort_key', 'A-1')).toBe('A-1')
    expect(normalizeNullableTextField('memo', ' ')).toBe(' ') // trim しない (strict === '')
  })

  it('非 nullable 列は空文字でも素通し', () => {
    expect(normalizeNullableTextField('title', '')).toBe('')
    expect(normalizeNullableTextField('question_text', '')).toBe('')
  })

  it('NULLABLE_TEXT_FIELDS は sort_key / explanation_text / memo の 3 列', () => {
    expect([...NULLABLE_TEXT_FIELDS].sort()).toEqual([
      'explanation_text',
      'memo',
      'sort_key',
    ])
  })
})

describe('buildNewCardMutationPatch', () => {
  const empty: EmptyCard = {
    title: '新しいカード',
    sortKey: 'A-2',
    questionText: '(問題文を入力してください)',
    options: [
      { id: '1', text: '(選択肢1)', is_correct: false },
      { id: '2', text: '正解', is_correct: true, explanation: 'なぜなら' },
    ],
    correctAnswerIds: ['2'],
  }

  it('snake_case patch + camelCase options に写像し explanation_text / memo は null', () => {
    expect(buildNewCardMutationPatch({ examId: 'exam-1', empty })).toEqual({
      exam_id: 'exam-1',
      title: '新しいカード',
      sort_key: 'A-2',
      question_text: '(問題文を入力してください)',
      options: [
        { id: '1', text: '(選択肢1)', isCorrect: false },
        { id: '2', text: '正解', isCorrect: true, explanation: 'なぜなら' },
      ],
      explanation_text: null,
      memo: null,
    })
  })

  it('explanation 空は options から省く', () => {
    const patch = buildNewCardMutationPatch({ examId: 'e', empty })
    expect('explanation' in patch.options[0]!).toBe(false)
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
