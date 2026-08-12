// exams-pull mapper test (S-local-2 Task 3)。
// pure な toClientExam mapper の verify。 DB query 部分は route 統合 test で
// mock 化。 Date → ISO 文字列 / camelCase → snake_case rename を assert。

import { describe, it, expect } from 'vitest'
import { toClientExam } from './exams-pull'
import type { exams } from './schema'

type ExamRow = typeof exams.$inferSelect

function fakeRow(overrides?: Partial<ExamRow>): ExamRow {
  return {
    id: 'exam-1',
    userId: 'user-1',
    name: 'Test Exam',
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
  })

  it('camelCase → snake_case の field rename', () => {
    const out = toClientExam(
      fakeRow({
        userId: 'u',
        contentVersion: 4,
      }),
    )
    expect(out.user_id).toBe('u')
    expect(out.content_version).toBe(4)
  })

  // Sprint B (DB 全体掃除) 置換 pin: card_count / question_no_format は両側 dead
  // (server 読み手ゼロ / client mirror 撤去) につき mapper 出力から撤去し、DB 列自体も
  // migration 0036 で drop 済。出力 shape にこの 2 key が復活しないことを pin する。
  it('mapper 出力に card_count / question_no_format キーが含まれない', () => {
    const out = toClientExam(fakeRow())
    expect(out).not.toHaveProperty('card_count')
    expect(out).not.toHaveProperty('question_no_format')
  })
})
