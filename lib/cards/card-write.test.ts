import { describe, it, expect } from 'vitest'
import type { EmptyCard } from './empty-card'
import { buildNewCardMutationPatch } from './card-write'

describe('buildNewCardMutationPatch', () => {
  const empty: EmptyCard = {
    title: '新しいカード',
    sortKey: 'A-2',
    questionText: '(問題文を入力してください)',
    options: [
      { id: '1', uid: '11111111-1111-4111-8111-111111111111', text: '(選択肢1)', is_correct: false },
      { id: '2', uid: '22222222-2222-4222-8222-222222222222', text: '正解', is_correct: true, explanation: 'なぜなら' },
    ],
    correctAnswerIds: ['2'],
  }

  it('snake_case patch + camelCase options に写像し explanation_text / memo は null(uid 透過)', () => {
    expect(buildNewCardMutationPatch({ examId: 'exam-1', empty })).toEqual({
      exam_id: 'exam-1',
      title: '新しいカード',
      sort_key: 'A-2',
      question_text: '(問題文を入力してください)',
      options: [
        { id: '1', uid: '11111111-1111-4111-8111-111111111111', text: '(選択肢1)', isCorrect: false },
        { id: '2', uid: '22222222-2222-4222-8222-222222222222', text: '正解', isCorrect: true, explanation: 'なぜなら' },
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
