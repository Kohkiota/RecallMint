// @vitest-environment jsdom
// QuickSessionHost test (design doc §7)。
//
// study-session-host.test.tsx と同型の mock 戦略(Dexie query は mock、exams
// mirror だけ実 Dexie〈fake-indexeddb〉)だが、quick は server fallback が無いため
// hybrid 切替の分岐は無い。本 file 固有の観点:
// - preset の enum 検証(不正 → home 送還、Dexie を待たない)
// - tag entry の population=0(invalid outcome)→ home 送還
// - 4 preset の population=0 → empty UI(home 送還しない)
// - cold-mirror gate(Task 6 の教訓): 有効な ?exam= を未 settle 中に剥がさない
// - origin の導出(preset ごと・tag 優先)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor, act } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import type { SelectedExamResolution } from '@/lib/dashboard/selected-exam'
import type { Card } from '@/lib/db/schema'

const {
  mockGetQuickPresetCardsFromDexie,
  mockSessionLauncher,
  mockUseSelectedExam,
  mockRouterReplace,
  pullSettleState,
} = vi.hoisted(() => ({
  mockGetQuickPresetCardsFromDexie: vi.fn(),
  mockSessionLauncher: vi.fn(),
  mockUseSelectedExam: vi.fn(),
  mockRouterReplace: vi.fn(),
  pullSettleState: { settled: true },
}))

vi.mock('@/app/(app)/app/_components/pull-settle-context', () => ({
  useFirstPullSettled: () => pullSettleState.settled,
}))

vi.mock('@/lib/cards/get-quick-preset-cards', () => ({
  getQuickPresetCardsFromDexie: mockGetQuickPresetCardsFromDexie,
}))

vi.mock('@/lib/dashboard/use-selected-exam', () => ({
  useSelectedExam: mockUseSelectedExam,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
}))

vi.mock('../../_components/session-launcher', () => ({
  SessionLauncher: (props: {
    cards: Card[]
    userId: string
    origin: string
    heading: string
    emptyState: React.ReactNode
  }) => {
    mockSessionLauncher(props)
    if (props.cards.length === 0) {
      return <>{props.emptyState}</>
    }
    return <div data-testid="session-launcher">launcher</div>
  },
}))

import { QuickSessionHost } from './quick-session-host'

const USER = 'user-1'
const EXAM = 'exam-1'

function resolved(examId: string): SelectedExamResolution {
  return {
    outcome: 'resolved',
    examId,
    source: 'url',
    urlNeedsUpdate: false,
    storeNeedsUpdate: false,
  }
}

function fakeCard(id: string): Card {
  return {
    id,
    userId: USER,
    examId: EXAM,
    sourceDocumentId: null,
    title: 'Q',
    questionLabel: null,
    baseOrder: 1024,
    questionText: 'Q?',
    options: [],
    correctAnswerIds: [],
    explanationText: null,
    memo: null,
    images: [],
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    due: new Date('2026-05-26T10:00:00.000Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    firstReviewedAt: null,
    contentVersion: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
  } as Card
}

function renderHost(props?: {
  examId?: string | undefined
  preset?: string | undefined
  tagOptionId?: string | undefined
  sessionLimit?: number | null
}) {
  return render(
    <QuickSessionHost
      userId={USER}
      sessionLimit={props?.sessionLimit ?? 20}
      fsrsMode={false}
      examId={'examId' in (props ?? {}) ? props?.examId : EXAM}
      preset={'preset' in (props ?? {}) ? props?.preset : 'mistakes'}
      tagOptionId={props?.tagOptionId}
    />,
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  pullSettleState.settled = true
  mockGetQuickPresetCardsFromDexie.mockResolvedValue({ kind: 'cards', cards: [] })
  mockUseSelectedExam.mockReturnValue(resolved(EXAM))
  const db = getClientDb()
  await db.exams.clear()
  await db.exams.bulkPut([
    {
      id: EXAM,
      user_id: USER,
      name: 'Exam 1',
      content_version: 0,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    },
  ])
})

afterEach(() => {
  cleanup()
})

describe('QuickSessionHost — 選定(preset 分岐)', () => {
  it('母集合あり → SessionLauncher に Card[] が渡る', async () => {
    mockGetQuickPresetCardsFromDexie.mockResolvedValueOnce({
      kind: 'cards',
      cards: [fakeCard('a'), fakeCard('b')],
    })
    renderHost({ preset: 'mistakes' })
    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('getQuickPresetCardsFromDexie に userId / examId / preset / tag / sessionLimit を渡す', async () => {
    renderHost({ preset: 'weak', sessionLimit: 7 })
    await waitFor(() => expect(mockGetQuickPresetCardsFromDexie).toHaveBeenCalled())
    expect(mockGetQuickPresetCardsFromDexie).toHaveBeenCalledWith(
      USER,
      EXAM,
      'weak',
      undefined,
      7,
    )
  })

  it('userId を SessionLauncher に転送する(flush の owner-scope 供給)', async () => {
    renderHost()
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER }),
      ),
    )
  })

  it('Dexie helper が throw → silent fallback(cards=[] で empty UI)', async () => {
    mockGetQuickPresetCardsFromDexie.mockRejectedValueOnce(new Error('dexie boom'))
    renderHost()
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ cards: [] }),
      ),
    )
    expect(mockRouterReplace).not.toHaveBeenCalled()
  })
})

describe('QuickSessionHost — origin 導出(§7 / §11.1)', () => {
  it.each([
    ['mistakes', 'home_quick_mistakes'],
    ['unanswered', 'home_quick_unanswered'],
    ['weak', 'home_quick_weak'],
    ['ten_min', 'home_quick_10min'],
  ])('preset=%s → origin=%s', async (preset, expectedOrigin) => {
    mockGetQuickPresetCardsFromDexie.mockResolvedValueOnce({
      kind: 'cards',
      cards: [fakeCard('a')],
    })
    renderHost({ preset })
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ origin: expectedOrigin }),
      ),
    )
  })

  it('tag が与えられたら preset の値によらず home_weak_tags', async () => {
    mockGetQuickPresetCardsFromDexie.mockResolvedValueOnce({
      kind: 'cards',
      cards: [fakeCard('a')],
    })
    renderHost({ preset: 'mistakes', tagOptionId: 'opt-1' })
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'home_weak_tags' }),
      ),
    )
  })
})

describe('QuickSessionHost — 不正入力(§7)', () => {
  it('未知 preset(tag 無し)→ Dexie を待たず home へ replace する', async () => {
    renderHost({ preset: 'not-a-real-preset' })
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/app'))
    expect(mockGetQuickPresetCardsFromDexie).not.toHaveBeenCalled()
  })

  it('preset 不在・tag も無し → home へ replace する', async () => {
    renderHost({ preset: undefined })
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/app'))
  })

  // fix round 1/5 M-2: useSelectedExam の URL 正規化(window.location.href を
  // 基準に issue する非同期 replace)が後着してこの route の URL へ書き戻す
  // レースでは、pathname が一度も変わらないため RedirectHome は unmount せず、
  // 1 回だけの replace だと Loading のまま孤立する。 bound 付き retry が
  // 「まだ quick route に留まっている」限り再送還することを確認する。
  describe('home 送還のレース耐性(fix round 1/5 M-2)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('replace 後も pathname が quick route のまま(= レースで戻された)→ bound 付きで再送還する', async () => {
      window.history.pushState({}, '', '/app/study/quick?preset=not-a-real-preset')
      act(() => {
        renderHost({ preset: 'not-a-real-preset' })
      })

      // 初回 replace(mount 直後・同期)
      expect(mockRouterReplace).toHaveBeenCalledTimes(1)
      expect(mockRouterReplace).toHaveBeenLastCalledWith('/app')

      // mock なので実ナビゲーションは起きない = window.location は quick route の
      // まま(=レースで戻された状態を模す)。 retry 間隔ぶん進めると再送還される。
      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(mockRouterReplace).toHaveBeenCalledTimes(2)

      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(mockRouterReplace).toHaveBeenCalledTimes(3)
    })

    it('離脱に成功(pathname が /app に変わる)→ それ以上 replace しない', async () => {
      window.history.pushState({}, '', '/app/study/quick?preset=not-a-real-preset')
      act(() => {
        renderHost({ preset: 'not-a-real-preset' })
      })
      expect(mockRouterReplace).toHaveBeenCalledTimes(1)

      // 実際に /app へ遷移できた状態を模す(レースに負けなかったケース)。
      window.history.pushState({}, '', '/app')
      act(() => {
        vi.advanceTimersByTime(150)
      })
      // pathname チェックで retry chain が止まり、2 回目は発行されない。
      expect(mockRouterReplace).toHaveBeenCalledTimes(1)
    })
  })

  it('preset 不在でも tag があれば早期送還しない(tag entry が有効)', async () => {
    mockGetQuickPresetCardsFromDexie.mockResolvedValueOnce({
      kind: 'cards',
      cards: [fakeCard('a')],
    })
    renderHost({ preset: undefined, tagOptionId: 'opt-1' })
    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    expect(mockRouterReplace).not.toHaveBeenCalled()
  })

  it("tag が存在しない / 選択試験内に付いていない(outcome='invalid')→ home へ replace する", async () => {
    mockGetQuickPresetCardsFromDexie.mockResolvedValueOnce({ kind: 'invalid' })
    renderHost({ tagOptionId: 'no-such-option' })
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/app'))
    // invalid の間はセッションを開始しない
    expect(mockSessionLauncher).not.toHaveBeenCalled()
  })

  it('4 preset の母集合 0 件は home へ送還せず empty UI(SessionLauncher の emptyState)', async () => {
    mockGetQuickPresetCardsFromDexie.mockResolvedValueOnce({ kind: 'cards', cards: [] })
    renderHost({ preset: 'mistakes' })
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ cards: [] }),
      ),
    )
    expect(mockRouterReplace).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// cold-mirror gate(Task 6 の教訓・study-session-host.tsx と同じ懸念)。
// ---------------------------------------------------------------------------
describe('QuickSessionHost — 初回 pull 未 settle の制御状態', () => {
  function realisticResolver() {
    mockUseSelectedExam.mockImplementation(
      (input: { urlExamId: string | undefined; examIds: readonly string[] }) =>
        input.examIds.length === 0
          ? {
              outcome: 'selection-required' as const,
              urlNeedsUpdate: input.urlExamId !== undefined,
            }
          : resolved(input.urlExamId ?? input.examIds[0]),
    )
  }

  function ExamsProbe() {
    const ids = useLiveQuery(
      async () =>
        (await getClientDb().exams.where('user_id').equals(USER).toArray()).map(
          (row) => row.id,
        ),
      [],
    )
    return (
      <div data-testid="exams-probe">
        {ids === undefined ? 'pending' : `n=${ids.length}`}
      </div>
    )
  }

  it('cold mirror + 有効な ?exam=X → 未 settle の間は解決させず、settle 後にセッションを出す(?exam= を剥がさない)', async () => {
    realisticResolver()
    pullSettleState.settled = false
    await getClientDb().exams.clear()
    mockGetQuickPresetCardsFromDexie.mockResolvedValue({
      kind: 'cards',
      cards: [fakeCard('deep-link-card')],
    })

    const tree = (
      <>
        <ExamsProbe />
        <QuickSessionHost
          userId={USER}
          sessionLimit={20}
          fsrsMode={false}
          examId={EXAM}
          preset="mistakes"
          tagOptionId={undefined}
        />
      </>
    )
    const { rerender } = render(tree)

    await waitFor(() =>
      expect(screen.getByTestId('exams-probe')).toHaveTextContent('n=0'),
    )
    await act(async () => {})
    // 未 settle の間はまだセッションを組まない
    expect(screen.queryByTestId('session-launcher')).toBeNull()
    // 剥がれていないことの構造的証拠: この間 resolver は空 examIds で呼ばれた
    // 履歴を残すが、settle 後は URL の exam を保持したまま呼ばれる(下で検証)。

    pullSettleState.settled = true
    await act(async () => {
      await getClientDb().exams.put({
        id: EXAM,
        user_id: USER,
        name: 'Exam 1',
        content_version: 0,
        created_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-05-01T00:00:00.000Z',
      })
    })
    rerender(tree)

    await waitFor(() => expect(screen.queryByTestId('session-launcher')).not.toBeNull())
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['deep-link-card'])
    expect(mockUseSelectedExam).toHaveBeenCalledWith({
      userId: USER,
      urlExamId: EXAM,
      examIds: [EXAM],
    })
    // 決定的な discriminator(study-session-host.test.tsx と同型): cold mirror
    // (空 examIds)で resolver に判断させた瞬間が 1 度でもあれば、実 resolver は
    // ?exam=X を「実在しない」と捨てる。呼出履歴に空 examIds が現れないことが
    // その不在の証拠。
    expect(mockUseSelectedExam).not.toHaveBeenCalledWith(
      expect.objectContaining({ examIds: [] }),
    )
    // router.replace('/app') が呼ばれていない(?exam= を剥がして home に落ちて
    // いない)ことも合わせて確認する。
    expect(mockRouterReplace).not.toHaveBeenCalled()
  })

  it('settle 済 + 本当に試験 0 件 → 従来どおり選択要求(空 mirror を握り潰さない)', async () => {
    realisticResolver()
    pullSettleState.settled = true
    await getClientDb().exams.clear()

    render(
      <QuickSessionHost
        userId={USER}
        sessionLimit={20}
        fsrsMode={false}
        examId={EXAM}
        preset="mistakes"
        tagOptionId={undefined}
      />,
    )

    await waitFor(() =>
      expect(mockUseSelectedExam).toHaveBeenCalledWith({
        userId: USER,
        urlExamId: EXAM,
        examIds: [],
      }),
    )
    expect(mockGetQuickPresetCardsFromDexie).not.toHaveBeenCalled()
  })
})
