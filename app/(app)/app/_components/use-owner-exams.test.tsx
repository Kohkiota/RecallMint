// @vitest-environment jsdom
// useOwnerExams — home / smart / quick が共有する cold-mirror gate(spec §5 の前段
// 制御状態①)。3 消費者に verbatim コピーを増やさないために抽出した hook なので、
// 「undefined = まだ判定できない」の 4 経路(query 未完了 / 未 settle の空 mirror /
// 確定した空 / 読み直し失敗)をここで pin する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { getClientDb, type ClientExam } from '@/lib/client-db'

const { pullSettleState } = vi.hoisted(() => ({
  pullSettleState: { settled: true },
}))

vi.mock('./pull-settle-context', () => ({
  useFirstPullSettled: () => pullSettleState.settled,
}))

import { useOwnerExams } from './use-owner-exams'

const USER = 'user-1'

function exam(overrides: Partial<ClientExam> = {}): ClientExam {
  return {
    id: 'exam-1',
    user_id: USER,
    name: '簿記2級',
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

// examIds の参照が render をまたいで安定していることも観測する(不安定だと
// useSelectedExam の useMemo が毎 render 再計算し、resolution の同一性が壊れる)。
const seenIdArrays: (readonly string[] | undefined)[] = []

function Probe({ userId = USER }: { userId?: string }) {
  const { exams, examIds } = useOwnerExams(userId)
  seenIdArrays.push(examIds)
  return (
    <div data-testid="probe">
      {examIds === undefined
        ? 'undecided'
        : `ids=${examIds.join(',')}|names=${(exams ?? []).map((e) => e.name).join(',')}`}
    </div>
  )
}

beforeEach(async () => {
  pullSettleState.settled = true
  seenIdArrays.length = 0
  await getClientDb().exams.clear()
})

afterEach(() => {
  cleanup()
})

describe('useOwnerExams', () => {
  it('Dexie query が未完了の間は undefined(判定材料なし)', () => {
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('undecided')
  })

  it('mirror に行があれば settle を待たずに返す', async () => {
    pullSettleState.settled = false
    await getClientDb().exams.bulkPut([exam(), exam({ id: 'exam-2', name: '簿記1級' })])

    render(<Probe />)
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent(
        'ids=exam-1,exam-2|names=簿記2級,簿記1級',
      ),
    )
  })

  it('未 settle の空 mirror は「試験 0 件」と確定しない(cold mirror gate)', async () => {
    pullSettleState.settled = false

    render(<Probe />)
    // liveQuery が空配列を配信し終えるだけの時間を与えても undefined のまま。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('undecided')
    // 「一度も確定値を出していない」ことを履歴で見る(時点比較では素通りする)。
    expect(seenIdArrays.every((ids) => ids === undefined)).toBe(true)
  })

  it('settle 済 + 読み直しても 0 件 → 確定した空配列を返す', async () => {
    pullSettleState.settled = true

    render(<Probe />)
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('ids=|names='),
    )
  })

  it('未 settle → settle で確定に切り替わる', async () => {
    pullSettleState.settled = false
    const { rerender } = render(<Probe />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('undecided')

    pullSettleState.settled = true
    rerender(<Probe />)
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('ids=|names='),
    )
  })

  it('settle 後の読み直しが失敗しても確定扱いにする(skeleton で固まらない)', async () => {
    pullSettleState.settled = true
    const collectionProto = Object.getPrototypeOf(
      getClientDb().exams.where('user_id').equals(USER),
    ) as { count: () => Promise<number> }
    const countSpy = vi
      .spyOn(collectionProto, 'count')
      .mockRejectedValue(new Error('DatabaseClosedError'))

    try {
      render(<Probe />)
      await waitFor(() =>
        expect(screen.getByTestId('probe')).toHaveTextContent('ids=|names='),
      )
    } finally {
      countSpy.mockRestore()
    }
  })

  it('他 owner の試験は含めない', async () => {
    await getClientDb().exams.bulkPut([
      exam(),
      exam({ id: 'other-exam', user_id: 'user-2', name: '他人の試験' }),
    ])

    render(<Probe />)
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('ids=exam-1|names=簿記2級'),
    )
  })

  it('examIds は再 render をまたいで同一参照を保つ', async () => {
    await getClientDb().exams.bulkPut([exam()])
    const { rerender } = render(<Probe />)
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('ids=exam-1'),
    )
    rerender(<Probe />)

    const settled = seenIdArrays.filter((ids) => ids !== undefined)
    expect(settled.length).toBeGreaterThan(1)
    expect(new Set(settled).size).toBe(1)
  })
})
