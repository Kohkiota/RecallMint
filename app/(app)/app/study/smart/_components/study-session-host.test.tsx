// @vitest-environment jsdom
// StudySessionHost test (S-local-3 Task 3 / Dash-1 Home v1 §8.5 で試験スコープ化)。
// Dexie cards (local mirror) → fallback (server cards) の hybrid 切替と、
// 「試験が解決してから選定する」流れを verify。
// Dexie helper / 共通 resolver / SessionLauncher を mock し、 props で受け渡される
// cards が「Dexie 由来」 か「server 由来」 かを assertion する。
// exams mirror だけは実 Dexie (fake-indexeddb) を使い、 resolver に渡る examIds が
// owner scope の実読み出しであることも同時に見る。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup, screen, waitFor } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import type { SelectedExamResolution } from '@/lib/dashboard/selected-exam'
import type { Card } from '@/lib/db/schema'

const {
  mockGetDueCardsFromDexie,
  mockSessionLauncher,
  mockUseSelectedExam,
  pullSettleState,
} = vi.hoisted(() => ({
  mockGetDueCardsFromDexie: vi.fn(),
  mockSessionLauncher: vi.fn(),
  mockUseSelectedExam: vi.fn(),
  // 初回 pull settle シグナル(実 context を mock して test から駆動する)。
  pullSettleState: { settled: true },
}))

vi.mock('@/app/(app)/app/_components/pull-settle-context', () => ({
  useFirstPullSettled: () => pullSettleState.settled,
}))

vi.mock('@/lib/cards/get-dexie-session-cards', () => ({
  getDueCardsFromDexie: mockGetDueCardsFromDexie,
}))
// 解決ロジック自体の pin は lib/dashboard/{selected-exam,use-selected-exam}.test.ts。
// ここでは「host が共通 resolver に何を渡し、その結果でどう選定するか」を見る。
vi.mock('@/lib/dashboard/use-selected-exam', () => ({
  useSelectedExam: mockUseSelectedExam,
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
    // cards が空のときは emptyState を render し、 non-empty のときは stub runner を返す。
    if (props.cards.length === 0) {
      return <>{props.emptyState}</>
    }
    return <div data-testid="session-launcher">launcher</div>
  },
}))

import { StudySessionHost } from './study-session-host'

const USER = 'user-1'
const EXAM = 'exam-1'

function fakeCard(overrides?: Partial<Card>): Card {
  return {
    id: 'server-card-1',
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
    contentVersion: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    ...overrides,
  } as Card
}

function resolved(examId: string): SelectedExamResolution {
  return {
    outcome: 'resolved',
    examId,
    source: 'url',
    urlNeedsUpdate: false,
    storeNeedsUpdate: false,
  }
}

// rerender で props を差し替える test 用 (選定のやり直し条件を見る describe)。
function hostEl(props: {
  cards: Card[]
  examId: string | undefined
  origin?: 'home_today' | 'smart'
  fsrsMode?: boolean
}) {
  return (
    <StudySessionHost
      cards={props.cards}
      fsrsMode={props.fsrsMode ?? false}
      userId={USER}
      sessionLimit={20}
      examId={props.examId}
      origin={props.origin ?? 'smart'}
    />
  )
}

function lastLauncherCardIds(): string[] {
  const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
  return lastCall.cards.map((c) => c.id)
}

function renderHost(props?: {
  cards?: Card[]
  examId?: string | undefined
  origin?: 'home_today' | 'smart'
  sessionLimit?: number | null
}) {
  return render(
    <StudySessionHost
      cards={props?.cards ?? [fakeCard()]}
      fsrsMode={false}
      userId={USER}
      sessionLimit={props?.sessionLimit ?? 20}
      examId={'examId' in (props ?? {}) ? props?.examId : EXAM}
      origin={props?.origin ?? 'smart'}
    />,
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  // 既定は「初回 pull 済」= 従来どおりの経路。未 settle 経路は該当 test 内で false にする。
  pullSettleState.settled = true
  mockGetDueCardsFromDexie.mockResolvedValue([])
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
    {
      id: 'exam-other-owner',
      user_id: 'user-2',
      name: 'Exam of another owner',
      content_version: 0,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    },
  ])
})

afterEach(() => {
  cleanup()
})

describe('StudySessionHost (S-local-3 hybrid)', () => {
  it('Dexie cards 1 件以上 → Dexie cards で SessionLauncher が呼ばれる', async () => {
    const dexieCards = [fakeCard({ id: 'dexie-a' }), fakeCard({ id: 'dexie-b' })]
    mockGetDueCardsFromDexie.mockResolvedValueOnce(dexieCards)

    renderHost({ cards: [fakeCard({ id: 'server-a' })] })

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    // server cards は使われていない (= dexie で上書き)
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['dexie-a', 'dexie-b'])
  })

  it('Dexie cards 0 件 → server cards で fallback render', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    renderHost({
      cards: [fakeCard({ id: 'server-a' }), fakeCard({ id: 'server-b' })],
    })

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['server-a', 'server-b'])
  })

  it('Dexie helper が throw → silent fallback (server cards で render)', async () => {
    mockGetDueCardsFromDexie.mockRejectedValueOnce(new Error('dexie boom'))
    renderHost({ cards: [fakeCard({ id: 'server-only' })] })

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['server-only'])
  })

  it('getDueCardsFromDexie が userId / 解決した examId / sessionLimit で呼ばれる', async () => {
    renderHost({ sessionLimit: 42 })
    await waitFor(() => expect(mockGetDueCardsFromDexie).toHaveBeenCalled())
    expect(mockGetDueCardsFromDexie).toHaveBeenCalledWith(USER, EXAM, 42)
  })

  it('userId を SessionLauncher に転送する (flush の owner-scope 供給・spec §4.6)', async () => {
    renderHost()
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER }),
      ),
    )
  })
})

describe('StudySessionHost — 試験スコープ(Dash-1 Home v1 §8.5 / §6)', () => {
  it('共通 resolver に URL の exam と owner scope の examIds を渡す', async () => {
    renderHost({ examId: EXAM })
    await waitFor(() => expect(mockGetDueCardsFromDexie).toHaveBeenCalled())
    // 他 owner の exam 行は examIds に混ざらない
    expect(mockUseSelectedExam).toHaveBeenCalledWith({
      userId: USER,
      urlExamId: EXAM,
      examIds: [EXAM],
    })
  })

  it('exam 未指定 (bookmark 直行) でも resolver の解決結果で選定する', async () => {
    mockUseSelectedExam.mockReturnValue(resolved('exam-from-store'))
    renderHost({ examId: undefined, cards: [] })
    await waitFor(() =>
      expect(mockGetDueCardsFromDexie).toHaveBeenCalledWith(
        USER,
        'exam-from-store',
        20,
      ),
    )
    expect(mockUseSelectedExam).toHaveBeenCalledWith(
      expect.objectContaining({ urlExamId: undefined }),
    )
  })

  it('解決した試験が URL の exam と違う → server cards は使わない (他試験のカードを出さない)', async () => {
    // server は URL の exam のカードを取っている。解決が別試験に落ちた場合、
    // その cards を出すと選択試験外のカードを出題してしまう。
    mockUseSelectedExam.mockReturnValue(resolved('exam-other'))
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { getByText } = renderHost({
      examId: EXAM,
      cards: [fakeCard({ id: 'server-of-url-exam' })],
    })
    await waitFor(() =>
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument(),
    )
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards).toEqual([])
  })

  it('試験を解決できない (選択要求) → セッションを開始せず empty UI', async () => {
    mockUseSelectedExam.mockReturnValue({
      outcome: 'selection-required',
      urlNeedsUpdate: false,
    })
    const { getByText } = renderHost({ cards: [fakeCard({ id: 'server-a' })] })
    await waitFor(() =>
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument(),
    )
    expect(mockGetDueCardsFromDexie).not.toHaveBeenCalled()
  })

  it('resolver 結果が未確定 (保存値の読込中) の間は選定しない', async () => {
    mockUseSelectedExam.mockReturnValue(undefined)
    renderHost()
    await waitFor(() => expect(mockUseSelectedExam).toHaveBeenCalled())
    expect(mockGetDueCardsFromDexie).not.toHaveBeenCalled()
    expect(mockSessionLauncher).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// fix round 1/5 Critical: 選定のやり直し条件。「一度でも走ったか」で止めると、
// 後から正しくなった入力(URL 正規化後に届く server cards / 試験切替)を永久に
// 無視する。やり直す条件は「解決した試験」と「その試験の server cards の到着」の
// 2 つに限り、それ以外の再 render では選定を据え置く(1 session = 1 選定)。
// ---------------------------------------------------------------------------
describe('StudySessionHost — 選定のやり直し条件(fix round 1/5)', () => {
  it('exam 無し bookmark → URL 正規化後に届いた server cards で選定し直す', async () => {
    // 1) exam param 無し = server は試験を絞れず cards=[]、Dexie もまだ空。
    mockUseSelectedExam.mockReturnValue(resolved(EXAM))
    mockGetDueCardsFromDexie.mockResolvedValue([])
    const { rerender, getByText } = render(
      hostEl({ cards: [], examId: undefined }),
    )
    await waitFor(() =>
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument(),
    )

    // 2) resolver が URL を ?exam=X に正規化 → RSC 再取得で server cards が後から届く。
    rerender(
      hostEl({ cards: [fakeCard({ id: 'server-after-normalize' })], examId: EXAM }),
    )

    await waitFor(() =>
      expect(lastLauncherCardIds()).toEqual(['server-after-normalize']),
    )
  })

  it('同一試験で既に非空のプールが出ていたら、server cards が届いても差し替えない', async () => {
    // fix round 2/5 I-1: exam 無しの入口では「server cards 到着」が 1 回の訪問中に
    // 必ず false→true と動く。ここで選定し直すと、SessionRunner は cards を snapshot
    // せず idx も維持されるため、回答中に出題列だけが入れ替わって 1 問飛ぶ。
    mockUseSelectedExam.mockReturnValue(resolved(EXAM))
    mockGetDueCardsFromDexie
      .mockResolvedValueOnce([fakeCard({ id: 'first-pick' })])
      // 2 回目が走ってしまったら別の並びが返る = 差し替えを検知できる
      .mockResolvedValue([fakeCard({ id: 'second-pick' })])

    const { rerender } = render(hostEl({ cards: [], examId: undefined }))
    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['first-pick']))

    // URL 正規化後の RSC 再取得で server cards が届く
    rerender(hostEl({ cards: [fakeCard({ id: 'server-late' })], examId: EXAM }))

    await waitFor(() => expect(mockUseSelectedExam).toHaveBeenCalled())
    expect(lastLauncherCardIds()).toEqual(['first-pick'])
    expect(mockGetDueCardsFromDexie).toHaveBeenCalledTimes(1)
  })

  it('試験が切り替わったら選定し直し、前の試験のカードを残さない', async () => {
    mockGetDueCardsFromDexie.mockImplementation(
      async (_userId: string, examIdArg: string) =>
        examIdArg === EXAM
          ? [fakeCard({ id: 'card-of-exam-1' })]
          : [fakeCard({ id: 'card-of-exam-2' })],
    )
    mockUseSelectedExam.mockReturnValue(resolved(EXAM))
    const { rerender } = render(hostEl({ cards: [], examId: EXAM }))
    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['card-of-exam-1']))

    mockUseSelectedExam.mockReturnValue(resolved('exam-2'))
    rerender(hostEl({ cards: [], examId: EXAM }))

    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['card-of-exam-2']))
    expect(mockGetDueCardsFromDexie).toHaveBeenCalledWith(USER, 'exam-2', 20)
  })

  it('試験切替の選定が終わるまで前の試験のカードを表示しない (Loading に落とす)', async () => {
    let releaseSecond: (cards: Card[]) => void = () => {}
    mockGetDueCardsFromDexie.mockImplementation(
      async (_userId: string, examIdArg: string) =>
        examIdArg === EXAM
          ? [fakeCard({ id: 'card-of-exam-1' })]
          : new Promise<Card[]>((resolve) => {
              releaseSecond = resolve
            }),
    )
    mockUseSelectedExam.mockReturnValue(resolved(EXAM))
    const { rerender, queryByTestId } = render(hostEl({ cards: [], examId: EXAM }))
    await waitFor(() => expect(queryByTestId('session-launcher')).not.toBeNull())

    mockUseSelectedExam.mockReturnValue(resolved('exam-2'))
    rerender(hostEl({ cards: [], examId: EXAM }))

    // 新試験の選定が in-flight の間は launcher を出さない (= 旧試験のカードが残らない)
    await waitFor(() => expect(queryByTestId('session-launcher')).toBeNull())
    await act(async () => {
      releaseSecond([fakeCard({ id: 'card-of-exam-2' })])
    })
    expect(lastLauncherCardIds()).toEqual(['card-of-exam-2'])
  })

  it('古い試験の選定が遅れて着地しても新しい選定を上書きしない (遅着 guard)', async () => {
    let releaseFirst: (cards: Card[]) => void = () => {}
    mockGetDueCardsFromDexie.mockImplementation(
      async (_userId: string, examIdArg: string) =>
        examIdArg === EXAM
          ? new Promise<Card[]>((resolve) => {
              releaseFirst = resolve
            })
          : [fakeCard({ id: 'card-of-exam-2' })],
    )
    mockUseSelectedExam.mockReturnValue(resolved(EXAM))
    const { rerender } = render(hostEl({ cards: [], examId: EXAM }))
    await waitFor(() => expect(mockGetDueCardsFromDexie).toHaveBeenCalled())

    mockUseSelectedExam.mockReturnValue(resolved('exam-2'))
    rerender(hostEl({ cards: [], examId: EXAM }))
    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['card-of-exam-2']))

    // 旧試験の Dexie 読みがここで完了しても、新試験の結果を潰さない。
    await act(async () => {
      releaseFirst([fakeCard({ id: 'card-of-exam-1' })])
    })
    // 画面で確認する: 旧試験の結果が state を上書きすると、表示 gate(試験一致)に
    // 弾かれて launcher が消え Loading に戻る = セッションが始まらない。
    expect(screen.queryByTestId('session-launcher')).not.toBeNull()
    expect(lastLauncherCardIds()).toEqual(['card-of-exam-2'])
  })

  it('解決試験が同じままの再 render では選定し直さない (1 session = 1 選定)', async () => {
    mockGetDueCardsFromDexie.mockResolvedValue([fakeCard({ id: 'dexie-a' })])
    mockUseSelectedExam.mockReturnValue(resolved(EXAM))
    const serverCards = [fakeCard({ id: 'server-a' })]
    const { rerender } = render(hostEl({ cards: serverCards, examId: EXAM }))
    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['dexie-a']))

    // 内容が同じ別インスタンスの配列 + 無関係な prop 変化では走り直さない
    // (配列の同一性で判定していたら毎 render 選定し直してしまう)。
    rerender(
      hostEl({
        cards: [fakeCard({ id: 'server-a' })],
        examId: EXAM,
        fsrsMode: true,
      }),
    )
    rerender(
      hostEl({
        cards: [fakeCard({ id: 'server-a' })],
        examId: EXAM,
        fsrsMode: true,
      }),
    )

    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['dexie-a']))
    expect(mockGetDueCardsFromDexie).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// fix round 3/5 Critical: 「mirror が空」には 2 つ意味がある —「まだ同期していない」と
// 「本当に試験 0 件」。前者で resolver を動かすと URL の ?exam= を捨て、server が
// 持って来たカードごと空セッションに落ちる(共有 deep link の初回訪問で自壊)。
// 判別は Task 5 の初回 pull settle シグナル(pull-settle-context)を消費して行う。
// ---------------------------------------------------------------------------
describe('StudySessionHost — 初回 pull 未 settle の制御状態(spec §5 / fix round 3/5)', () => {
  // 実 resolver の挙動を模す: examIds が空なら URL の exam は「実在しない」と判定され
  // selection-required + URL 正規化(= ?exam= の除去)になる。
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

  // host と同じ Dexie query を張る観測用 component。「mirror が空だと**判明した**」
  // 状態に確実に到達してから assert するために要る(到達前に assert すると、
  // gate を外した実装でも「まだ query 未解決」で素通りして pin にならない)。
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

  it('cold mirror + 有効な ?exam=X → 未 settle の間は解決させず、settle 後に server cards を出す', async () => {
    realisticResolver()
    pullSettleState.settled = false
    await getClientDb().exams.clear() // まだ何も pull していない mirror
    mockGetDueCardsFromDexie.mockResolvedValue([]) // cards mirror も空

    const deepLinkTree = (
      <>
        <ExamsProbe />
        {hostEl({ cards: [fakeCard({ id: 'server-deep-link' })], examId: EXAM })}
      </>
    )
    const { rerender } = render(deepLinkTree)

    // 「空だと判明した」状態に到達するまで待つ
    await waitFor(() =>
      expect(screen.getByTestId('exams-probe')).toHaveTextContent('n=0'),
    )
    await act(async () => {}) // 同 tick の他購読者(host 側)の反映も流す
    // 未 settle の間はまだセッションを組まない(判定材料が無い)。
    expect(screen.queryByTestId('session-launcher')).toBeNull()

    // 初回 pull が着地: exams mirror が満ちて settle
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
    rerender(
      <>
        <ExamsProbe />
        {hostEl({ cards: [fakeCard({ id: 'server-deep-link' })], examId: EXAM })}
      </>,
    )

    // server が持って来ていたカードでセッションが始まる(空セッションに落ちない)
    await waitFor(() => expect(lastLauncherCardIds()).toEqual(['server-deep-link']))
    // resolver には URL の exam が実在する状態で渡る → 実 resolver は URL を保持する
    expect(mockUseSelectedExam).toHaveBeenCalledWith({
      userId: USER,
      urlExamId: EXAM,
      examIds: [EXAM],
    })
    // 決定的な discriminator: cold mirror(空の examIds)で resolver に判断させた
    // 瞬間が 1 度でもあれば、実 resolver は URL の ?exam=X を「実在しない」と捨てて
    // 剥がしてしまう。呼び出し履歴に空 examIds が現れないことがその不在の証拠
    // (「呼ばれていない」を時間で待つ形にすると、query 未解決の一瞬でも成立して
    // しまい pin にならない — 履歴で見る)。
    expect(mockUseSelectedExam).not.toHaveBeenCalledWith(
      expect.objectContaining({ examIds: [] }),
    )
  })

  it('settle 後の読み直しが失敗しても Loading で固まらない(mirror 現状で判定する)', async () => {
    // fix round 4/5 N-1: 読み直しの reject を握り潰すと、再試行の契機が無いまま
    // Loading が residual state になる(本変更前には存在しなかった状態)。
    // spec §6「pull 失敗で settle した場合は mirror 現状で判定」と同じ扱いにする。
    realisticResolver()
    pullSettleState.settled = true
    await getClientDb().exams.clear()
    const collectionProto = Object.getPrototypeOf(
      getClientDb().exams.where('user_id').equals(USER),
    ) as { count: () => Promise<number> }
    const countSpy = vi
      .spyOn(collectionProto, 'count')
      .mockRejectedValue(new Error('DatabaseClosedError'))

    try {
      const { getByText } = render(
        hostEl({ cards: [fakeCard({ id: 'server-a' })], examId: EXAM }),
      )
      await waitFor(() =>
        expect(getByText(/現在復習する card はありません/)).toBeInTheDocument(),
      )
    } finally {
      countSpy.mockRestore()
    }
  })

  it('settle 済 + 本当に試験 0 件 → 従来どおり選択要求(空 mirror を握り潰さない)', async () => {
    realisticResolver()
    pullSettleState.settled = true
    await getClientDb().exams.clear()

    const { getByText } = render(
      hostEl({ cards: [fakeCard({ id: 'server-a' })], examId: EXAM }),
    )

    await waitFor(() =>
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument(),
    )
    expect(mockUseSelectedExam).toHaveBeenCalledWith({
      userId: USER,
      urlExamId: EXAM,
      examIds: [],
    })
    expect(mockGetDueCardsFromDexie).not.toHaveBeenCalled()
  })
})

describe('StudySessionHost — origin(Dash-1 Home v1 §11)', () => {
  it('page が正規化した origin をそのまま SessionLauncher に渡す (home_today)', async () => {
    renderHost({ origin: 'home_today' })
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'home_today' }),
      ),
    )
  })

  it('page が正規化した origin をそのまま SessionLauncher に渡す (smart)', async () => {
    renderHost({ origin: 'smart' })
    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'smart' }),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// S-local-4 (Phase γ): Dexie + server 両方 0 件 → empty UI 表示。 旧 page.tsx の
// 「ありません」 page を host 内に集約 (offline で server fetch fail → cards=[]
// 渡し + Dexie も 0 件のときの一元判断)。
// ---------------------------------------------------------------------------
describe('StudySessionHost — empty UI (S-local-4)', () => {
  it('Dexie 0 件 + server cards 0 件 → empty UI 表示', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { getByText, getByRole } = renderHost({ cards: [] })

    await waitFor(() => {
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument()
    })
    // ダッシュボードへ link が表示される
    expect(getByRole('link', { name: 'ダッシュボードへ' })).toHaveAttribute(
      'href',
      '/app',
    )
    // SessionLauncher には cards=[] が渡り、 emptyState が render される
    expect(mockSessionLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ cards: [] }),
    )
  })

  it('Dexie 0 件 + server cards 1 件以上 → server fallback で SessionLauncher (empty UI は出ない)', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { queryByText } = renderHost({
      cards: [fakeCard({ id: 'fallback-only' })],
    })

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    // empty UI は出ない (= server fallback で session 起動)
    expect(queryByText(/現在復習する card はありません/)).not.toBeInTheDocument()
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['fallback-only'])
  })

  it('Dexie throw + server cards 0 件 → silent fallback で empty UI', async () => {
    mockGetDueCardsFromDexie.mockRejectedValueOnce(new Error('dexie boom'))
    const { getByText } = renderHost({ cards: [] })

    await waitFor(() => {
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument()
    })
  })
})
