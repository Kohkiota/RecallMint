// @vitest-environment jsdom
// DashboardStats client component test (S-perf-3 で IDB 化、 fake-indexeddb seed
// 形式に書き換え)。
//
// 検証観点:
// - props は userId (DB UUID) + test 注入用 now
// - useLiveQuery が undefined 中は skeleton (layout shift 防止、 aria-busy)
// - Dexie study_days seed 後、 todayCardCount / streak が表示される
// - 他 user の study_days は混入しない (tenant 分離)
// - JST 境界 (UTC 14:59 / 15:00)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { DashboardStats } from './dashboard-stats'

function fakeStudyDay(overrides?: Partial<ClientStudyDay>): ClientStudyDay {
  return {
    user_id: 'user-1',
    day: '2026-04-22',
    review_count: 5,
    correct_count: 3,
    distinct_card_count: 4,
    ...overrides,
  }
}

beforeEach(async () => {
  await getClientDb().study_days.clear()
})

afterEach(() => {
  cleanup()
})

describe('DashboardStats (Dexie)', () => {
  it('mount 直後 (useLiveQuery undefined): skeleton aria-busy を表示', () => {
    render(<DashboardStats userId="user-1" />)
    expect(screen.getByRole('status', { name: /読み込み中/ })).toBeInTheDocument()
  })

  it('Dexie 空: todayCardCount=0 + streak=0 を表示', async () => {
    render(
      <DashboardStats
        userId="user-1"
        now={new Date('2026-04-22T12:00:00Z')}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('今日の学習問題数')).toBeInTheDocument()
      // 今日と streak で 0 が 2 箇所、 streak は "0 日" 表記
      expect(screen.getByText('0', { selector: '.text-3xl' })).toBeInTheDocument()
      expect(screen.getByText(/0\s*日/)).toBeInTheDocument()
    })
    // skeleton は消える
    expect(
      screen.queryByRole('status', { name: /読み込み中/ }),
    ).not.toBeInTheDocument()
  })

  it('今日 1 行: todayCardCount = distinct_card_count, streak = 1', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-22',
        review_count: 5,
        distinct_card_count: 7,
      }),
    ])
    render(
      <DashboardStats
        userId="user-1"
        now={new Date('2026-04-22T12:00:00Z')}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('7')).toBeInTheDocument()
      expect(screen.getByText(/1\s*日/)).toBeInTheDocument()
    })
  })

  it('連続 3 日 → streak = 3', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-22', distinct_card_count: 4 }),
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-21' }),
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-20' }),
    ])
    render(
      <DashboardStats
        userId="user-1"
        now={new Date('2026-04-22T12:00:00Z')}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('4')).toBeInTheDocument()
      expect(screen.getByText(/3\s*日/)).toBeInTheDocument()
    })
  })

  it('他 user の行は混入しない (tenant 分離)', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({
        user_id: 'other-user',
        day: '2026-04-22',
        distinct_card_count: 99,
      }),
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-22',
        distinct_card_count: 4,
      }),
    ])
    render(
      <DashboardStats
        userId="user-1"
        now={new Date('2026-04-22T12:00:00Z')}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('4')).toBeInTheDocument()
    })
    expect(screen.queryByText('99')).not.toBeInTheDocument()
  })

  it('JST 境界 UTC 15:00 (= JST 翌日 00:00): today は翌日扱い', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-22',
        distinct_card_count: 8,
      }),
    ])
    render(
      <DashboardStats
        userId="user-1"
        now={new Date('2026-04-22T15:00:00Z')}
      />,
    )
    // today = '2026-04-23' → 行なし → 0
    // yesterday = '2026-04-22' (review_count > 0) → streak = 1 (yesterday 起点)
    await waitFor(() => {
      expect(screen.getByText('0', { selector: '.text-3xl' })).toBeInTheDocument()
      expect(screen.getByText(/1\s*日/)).toBeInTheDocument()
    })
  })
})
