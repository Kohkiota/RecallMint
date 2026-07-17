// study-days-pull mapper test (S-perf-3)。
// cards-pull.test.ts と同 pattern: pure な mapper + 日付閾値 helper を verify。
//
// 監査 2026-07-17 G2 追加対処: getAllStudyDaysForUser の owner-scope pin を追加
// (本 module は getDeltaRows を経由しない独立 inline query のため pull-delta.test.ts
// では被覆されない)。eq-spy は構造の pin でありテナント隔離の証明ではない —
// 限界の詳細と実効検証(実 PostgreSQL 2 テナント統合テスト)の follow-up は
// lib/db/pull-delta.test.ts 冒頭コメント + docs/audit/2026-07-17-test-quality-audit.md。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRows } = vi.hoisted(() => ({
  mockRows: { value: [] as unknown[] },
}))

// drizzle-orm: eq / gte をスパイ化し、実動作は real に委譲(cards-delta.test.ts 前例)。
// mapper / 日付 helper の既存 test は drizzle を使わないため挙動不変。
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  const spyGte = vi.fn(
    (...args: Parameters<typeof real.gte>) => real.gte(...args),
  )
  return { ...real, eq: spyEq, gte: spyGte }
})

vi.mock('@/lib/db', () => {
  function makeSelectChain(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj['from'] = (_table: unknown) => ({
      where: (_cond: unknown) => Promise.resolve(mockRows.value),
    })
    return obj
  }
  return { getDb: () => ({ select: () => makeSelectChain() }) }
})

async function getSpies() {
  const { eq, gte } = await import('drizzle-orm')
  return { spyEq: vi.mocked(eq), spyGte: vi.mocked(gte) }
}

import {
  toClientStudyDay,
  studyDaysLowerBound,
  STUDY_DAYS_WINDOW,
} from './study-days-pull'
import type { studyDays } from './schema'

type StudyDayRow = typeof studyDays.$inferSelect

function fakeRow(overrides?: Partial<StudyDayRow>): StudyDayRow {
  return {
    userId: 'user-1',
    day: '2026-05-26',
    reviewCount: 5,
    correctCount: 3,
    distinctCardCount: 4,
    ...overrides,
  }
}

describe('toClientStudyDay', () => {
  it('camelCase → snake_case 変換 (PK [user_id+day] を保持)', () => {
    const out = toClientStudyDay(fakeRow())
    expect(out).toEqual({
      user_id: 'user-1',
      day: '2026-05-26',
      review_count: 5,
      correct_count: 3,
      distinct_card_count: 4,
    })
  })

  it('count が 0 の day も忠実に変換 (server 側で WHERE review_count > 0 は streak 側責任)', () => {
    const out = toClientStudyDay(
      fakeRow({ reviewCount: 0, correctCount: 0, distinctCardCount: 0 }),
    )
    expect(out.review_count).toBe(0)
    expect(out.correct_count).toBe(0)
    expect(out.distinct_card_count).toBe(0)
  })
})

describe('studyDaysLowerBound', () => {
  it('today を含む 90 日 window → today - 89 日 を下限に返す', () => {
    // 2026-05-26 JST 基準で 2026-02-26 (今日含めて 90 日)
    const now = new Date('2026-05-26T03:00:00.000Z') // = 12:00 JST
    expect(studyDaysLowerBound(now)).toBe('2026-02-26')
  })

  it('月跨ぎ / 年跨ぎでも UTC 算術で正しく計算', () => {
    // 2026-01-15 JST から 89 日前 = 2025-10-18
    const now = new Date('2026-01-15T03:00:00.000Z')
    expect(studyDaysLowerBound(now)).toBe('2025-10-18')
  })

  it('JST 境界: UTC 14:59 (= JST 23:59) と UTC 15:00 (= JST 翌 00:00) で day が変わる', () => {
    expect(studyDaysLowerBound(new Date('2026-05-26T14:59:59.000Z'))).toBe(
      '2026-02-26',
    )
    expect(studyDaysLowerBound(new Date('2026-05-26T15:00:00.000Z'))).toBe(
      '2026-02-27',
    )
  })

  it('STUDY_DAYS_WINDOW = 90 (今日含む day 数) の export を提供', () => {
    expect(STUDY_DAYS_WINDOW).toBe(90)
  })
})

describe('getAllStudyDaysForUser (owner-scope pin)', () => {
  beforeEach(async () => {
    const { spyEq, spyGte } = await getSpies()
    spyEq.mockClear()
    spyGte.mockClear()
    mockRows.value = []
  })

  it('eq(studyDays.userId, userId) が必ず呼ばれる (owner-scope)', async () => {
    const { getAllStudyDaysForUser } = await import('./study-days-pull')
    const { studyDays: studyDaysTable } = await import('./schema')
    await getAllStudyDaysForUser(
      'user-1',
      new Date('2026-05-26T03:00:00.000Z'),
    )
    expect((await getSpies()).spyEq).toHaveBeenCalledWith(
      studyDaysTable.userId,
      'user-1',
    )
  })

  it('gte(studyDays.day, 90 日 window 下限) が呼ばれる', async () => {
    const { getAllStudyDaysForUser } = await import('./study-days-pull')
    const { studyDays: studyDaysTable } = await import('./schema')
    await getAllStudyDaysForUser(
      'user-1',
      new Date('2026-05-26T03:00:00.000Z'),
    )
    expect((await getSpies()).spyGte).toHaveBeenCalledWith(
      studyDaysTable.day,
      '2026-02-26',
    )
  })

  it('rows は toClientStudyDay 適用済で返る / 0 行で []', async () => {
    const { getAllStudyDaysForUser } = await import('./study-days-pull')
    mockRows.value = [
      {
        userId: 'user-1',
        day: '2026-05-25',
        reviewCount: 5,
        correctCount: 3,
        distinctCardCount: 4,
      },
    ]
    const rows = await getAllStudyDaysForUser(
      'user-1',
      new Date('2026-05-26T03:00:00.000Z'),
    )
    expect(rows).toEqual([
      {
        user_id: 'user-1',
        day: '2026-05-25',
        review_count: 5,
        correct_count: 3,
        distinct_card_count: 4,
      },
    ])

    mockRows.value = []
    expect(
      await getAllStudyDaysForUser('user-1', new Date('2026-05-26T03:00:00.000Z')),
    ).toEqual([])
  })
})
