// exams-pull mapper test (S-local-2 Task 3)。
// pure な toClientExam mapper の verify。 DB query 部分は route 統合 test で
// mock 化。 Date → ISO 文字列 / archived_at null 取扱い / camelCase → snake_case
// rename を assert。

import { describe, it, expect } from 'vitest'
import { toClientExam } from './exams-pull'
import type { exams } from './schema'

type ExamRow = typeof exams.$inferSelect

function fakeRow(overrides?: Partial<ExamRow>): ExamRow {
  return {
    id: 'exam-1',
    userId: 'user-1',
    name: 'Test Exam',
    questionNoFormat: null,
    archivedAt: null,
    cardCount: 0,
    contentVersion: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    ...overrides,
  } as ExamRow
}

describe('toClientExam', () => {
  it('Date 系を ISO 文字列化、 null は null のまま', () => {
    const out = toClientExam(fakeRow())
    expect(out.created_at).toBe('2026-05-01T00:00:00.000Z')
    expect(out.updated_at).toBe('2026-05-02T00:00:00.000Z')
    expect(out.archived_at).toBeNull()
    expect(out.question_no_format).toBeNull()
  })

  it('archivedAt が Date のとき ISO 文字列化', () => {
    const out = toClientExam(
      fakeRow({ archivedAt: new Date('2026-05-10T03:00:00.000Z') }),
    )
    expect(out.archived_at).toBe('2026-05-10T03:00:00.000Z')
  })

  it('camelCase → snake_case の field rename', () => {
    const out = toClientExam(
      fakeRow({
        userId: 'u',
        questionNoFormat: 'numeric',
        cardCount: 12,
        contentVersion: 4,
      }),
    )
    expect(out.user_id).toBe('u')
    expect(out.question_no_format).toBe('numeric')
    expect(out.card_count).toBe(12)
    expect(out.content_version).toBe(4)
  })
})
