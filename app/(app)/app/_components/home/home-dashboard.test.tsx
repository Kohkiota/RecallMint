// @vitest-environment jsdom
// HomeDashboard — Home の共有集計 root。個々のウィジェットの表示規則はそれぞれの
// test file にあり、ここでは **root にしか無い責務**を pin する:
//   - §5 の前段 2 制御状態(初回 pull 未 settle の skeleton / 試験未選択)
//   - §5 の空状態 4 種のうち、ウィジェットの出し分けを伴う 3 つ
//   - 1 mount 1 now / 1 query で全ウィジェットへ配る配線(値が widget 間で矛盾しない)
//   - 試験切替が URL を書き換える(URL が正・spec §6)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import type { SelectedExamResolution } from '@/lib/dashboard/selected-exam'

const { pullSettleState, mockUseSelectedExam, mockRouterReplace } = vi.hoisted(() => ({
  pullSettleState: { settled: true },
  mockUseSelectedExam: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

vi.mock('../pull-settle-context', () => ({
  useFirstPullSettled: () => pullSettleState.settled,
}))
vi.mock('@/lib/dashboard/use-selected-exam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dashboard/use-selected-exam')>()
  return { ...actual, useSelectedExam: mockUseSelectedExam }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
}))

import { HomeDashboard } from './home-dashboard'

const USER = 'user-1'
const EXAM = '11111111-2222-3333-4444-555555555555'
const EXAM2 = '22222222-3333-4444-5555-666666666666'
// JST 2026-08-19(水)12:00
const NOW = new Date('2026-08-19T03:00:00Z')

function exam(id: string, name: string, dailyNewTarget?: number | null): ClientExam {
  return {
    id,
    user_id: USER,
    name,
    daily_new_target: dailyNewTarget,
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

let cardSeq = 0
function card(overrides: Partial<ClientCard> = {}): ClientCard {
  cardSeq += 1
  return {
    id: `card-${cardSeq}`,
    user_id: USER,
    exam_id: EXAM,
    source_document_id: null,
    title: 'Q',
    question_label: null,
    base_order: cardSeq * 1024,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: true,
    last_correct: true,
    current_streak: 0,
    due: '2026-08-19T09:00:00+09:00',
    stability: 1,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 1,
    lapses: 0,
    state: 2,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
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

beforeEach(async () => {
  cardSeq = 0
  pullSettleState.settled = true
  mockUseSelectedExam.mockReset()
  mockUseSelectedExam.mockReturnValue(resolved(EXAM))
  mockRouterReplace.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ owner_user_id: USER, exam_id: EXAM, weak_tags: [] }),
    }),
  )
  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.study_days.clear()
  await db.answer_events.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderHome(urlExamId: string | undefined = EXAM) {
  return render(<HomeDashboard userId={USER} urlExamId={urlExamId} now={NOW} />)
}

describe('HomeDashboard — 前段の制御状態(§5)', () => {
  it('初回 pull が settle するまでは skeleton(空 mirror を「試験 0」と断定しない)', async () => {
    pullSettleState.settled = false
    renderHome()
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '読み込み中' })).toHaveAttribute(
        'aria-busy',
        'true',
      ),
    )
    expect(screen.queryByText(/画像や PDF から問題集を作る/)).toBeNull()
  })

  it('試験が解決できないときはウィジェットを出さず試験選択だけを出す', async () => {
    await getClientDb().exams.bulkPut([exam(EXAM, '簿記2級'), exam(EXAM2, '簿記1級')])
    mockUseSelectedExam.mockReturnValue({
      outcome: 'selection-required',
      urlNeedsUpdate: false,
    })
    renderHome(undefined)
    expect(await screen.findByText('学習する試験を選んでください')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '今日の学習' })).toBeNull()
    expect(screen.queryByRole('heading', { name: /今週/ })).toBeNull()
  })

  it('試験選択から選ぶと URL の exam が書き換わる(URL が正)', async () => {
    await getClientDb().exams.bulkPut([exam(EXAM, '簿記2級'), exam(EXAM2, '簿記1級')])
    mockUseSelectedExam.mockReturnValue({
      outcome: 'selection-required',
      urlNeedsUpdate: false,
    })
    renderHome(undefined)
    fireEvent.click(await screen.findByRole('button', { name: '簿記1級' }))
    expect(mockRouterReplace).toHaveBeenCalledWith(expect.stringContaining(`exam=${EXAM2}`))
  })
})

describe('HomeDashboard — 空状態(§5)', () => {
  it('試験 0 件: hero CTA のみでウィジェットを描画しない', async () => {
    renderHome(undefined)
    const cta = await screen.findByRole('link', { name: '画像や PDF から問題集を作る' })
    expect(cta).toHaveAttribute('href', '/app/upload')
    expect(screen.queryByRole('heading', { name: '今日の学習' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'カードの状態' })).toBeNull()
  })

  it('試験あり・カード 0: W2 を差し替え、カード由来の他ウィジェットは出さない', async () => {
    await getClientDb().exams.bulkPut([exam(EXAM, '簿記2級')])
    renderHome()
    expect(await screen.findByText('この試験にはまだ問題がありません。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'カードの状態' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '今後 7 日' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'さっと演習' })).toBeNull()
  })

  it('現在の対象なし(y=0): W2 だけ空状態で、他ウィジェットは通常描画する', async () => {
    await getClientDb().exams.bulkPut([exam(EXAM, '簿記2級', 0)])
    await getClientDb().cards.bulkPut([
      // 明後日 due の Review → n = 0
      card({ due: '2026-08-21T09:00:00+09:00' }),
    ])
    renderHome()
    expect(await screen.findByText(/いま解く対象はありません/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'カードの状態' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '今後 7 日' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'さっと演習' })).toBeInTheDocument()
  })

  it('W6 は母集合(state≠0)が 0 ならウィジェットごと出さない', async () => {
    await getClientDb().exams.bulkPut([exam(EXAM, '簿記2級')])
    await getClientDb().cards.bulkPut([card({ state: 0, answered: false, last_correct: null })])
    renderHome()
    expect(await screen.findByRole('heading', { name: 'カードの状態' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '今後 7 日' })).toBeNull()
  })
})

describe('HomeDashboard — 実プール 0 の配線(spec §13.2)', () => {
  // leaf (today-study.test.tsx) は props 注入で pin しているため、
  // 「root が何を poolSize / nextAvailableAt として渡すか」は別に pin が要る
  // (ここを y (= 今日の復習対象数) に取り違えると pool 0 分岐が構造的に到達不能になり、
  //  leaf の test は全て green のまま user が空セッションに入る)。
  async function seedFutureLearningOnly() {
    const db = getClientDb()
    // K=0 で新規を出さない。 今日 due だが「まだ来ていない」Learning step のみ
    // → y > 0 (今日が対象) だが実プールは 0。
    await db.exams.put(exam(EXAM, '簿記2級', 0))
    await db.cards.bulkPut([
      card({ state: 1, learning_steps: 1, due: '2026-08-19T21:30:00+09:00' }),
      card({ state: 1, learning_steps: 1, due: '2026-08-19T22:00:00+09:00' }),
    ])
  }

  it('y > 0 でも実プール 0 なら CTA を無効にし、空セッションへ遷移させない', async () => {
    await seedFutureLearningOnly()
    renderHome()
    // 案内文の存在 = y > 0 の分岐 (④) に居ることの印。 y === 0 の空状態 (③) は
    // 別文言 + 「さっと演習を選ぶ」導線なので、 fixture の取り違えはここで落ちる。
    expect(
      await screen.findByText(/いま出題できる問題はありません/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '学習を始める' })).toBeDisabled()
    expect(document.querySelector('a[href^="/app/study/smart"]')).toBeNull()
  })

  it('nextAvailableAt を渡している(案内文が実データの時刻になる)', async () => {
    await seedFutureLearningOnly()
    renderHome()
    expect(
      await screen.findByText(
        'いま出題できる問題はありません。次の復習は 21 時頃です。',
      ),
    ).toBeInTheDocument()
  })

  it('検出器: 同じ fixture で due を過去にすると CTA が有効になる', async () => {
    // 上の 2 件が fixture の不備 (何も出ていないだけ) で通っていないことの対照。
    const db = getClientDb()
    await db.exams.put(exam(EXAM, '簿記2級', 0))
    await db.cards.bulkPut([
      card({ state: 1, learning_steps: 1, due: '2026-08-19T09:00:00+09:00' }),
    ])
    renderHome()
    expect(
      await screen.findByRole('link', { name: '学習を始める' }),
    ).toBeInTheDocument()
  })
})

describe('HomeDashboard — 共有集計の配線', () => {
  beforeEach(async () => {
    await getClientDb().exams.bulkPut([exam(EXAM, '簿記2級', 20), exam(EXAM2, '簿記1級')])
    await getClientDb().cards.bulkPut([
      card({ due: '2026-08-10T09:00:00+09:00' }), // 持ち越し
      card({ due: '2026-08-19T20:00:00+09:00' }), // 今日
      card({ state: 0, answered: false, last_correct: null }), // 未学習(新規枠)
      card({ answered: true, last_correct: false }), // 間違い
      // 他試験の今日 due(他試験 1 行に入る / 選択試験の集計には入らない)
      card({ exam_id: EXAM2, due: '2026-08-19T09:00:00+09:00' }),
    ])
    await getClientDb().study_days.bulkPut([
      { user_id: USER, day: '2026-08-17', review_count: 40, correct_count: 30, distinct_card_count: 30 },
      { user_id: USER, day: '2026-08-19', review_count: 25, correct_count: 20, distinct_card_count: 18 },
    ])
  })

  it('W2 の内訳と W3 / W6 が同じ集計から出る(値が矛盾しない)', async () => {
    renderHome()
    // n = 3(持ち越し 1 + 今日 1 + 間違い 1〈due 既定 = 今日〉)、m = 1、k = 1 → y = 4
    await waitFor(() =>
      expect(screen.getByTestId('today-breakdown')).toHaveTextContent('復習 3'),
    )
    expect(screen.getByTestId('today-breakdown')).toHaveTextContent('持ち越し 1')
    expect(screen.getByTestId('today-breakdown')).toHaveTextContent('新規 1')
    expect(screen.getByTestId('today-remaining')).toHaveTextContent('4')
    // W6 の今日バーは n と一致する(持ち越し合算)
    expect(screen.getAllByTestId('forecast-bar')[0]).toHaveTextContent('3')
    // W3 の持ち越し別段も同じ m
    expect(screen.getByTestId('state-carryover')).toHaveTextContent('持ち越し 1 件')
  })

  it('他 owner の cards は集計に混ざらない(tenant 分離)', async () => {
    await getClientDb().cards.bulkPut([
      card({ id: 'other-owner-1', user_id: 'user-2', due: '2026-08-19T09:00:00+09:00' }),
      card({ id: 'other-owner-2', user_id: 'user-2', exam_id: EXAM2 }),
    ])
    renderHome()
    // 自 owner のみの n = 3 / 他試験 1 件のまま(他 owner を足すと 4 / 2 になる)
    await waitFor(() =>
      expect(screen.getByTestId('today-breakdown')).toHaveTextContent('復習 3'),
    )
    expect(screen.getByTestId('other-exams')).toHaveTextContent('他の試験: 復習 1 件')
  })

  it('他の試験の復習件数をヘッダ直下に出す(選択試験の集計には混ぜない)', async () => {
    renderHome()
    await waitFor(() =>
      expect(screen.getByTestId('other-exams')).toHaveTextContent('他の試験: 復習 1 件'),
    )
  })

  it('W7 は study_days(全試験)から今週を出す', async () => {
    renderHome()
    await waitFor(() =>
      expect(screen.getByTestId('week-answers')).toHaveTextContent('65'),
    )
    expect(screen.getByTestId('week-study-days')).toHaveTextContent('2 日')
    expect(screen.getByTestId('week-today')).toHaveTextContent('18')
  })

  it('W5 の件数は選択試験の母集合で、0 の preset だけ disable になる', async () => {
    renderHome()
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /間違い/ })).toHaveTextContent('1'),
    )
    // 苦手(lapses>=2)は 0 件 → disable
    expect(screen.getByRole('button', { name: /苦手/ })).toBeDisabled()
  })

  it('ヘッダの切替で URL の exam を書き換える', async () => {
    renderHome()
    const select = await screen.findByRole('combobox', { name: '試験を切り替える' })
    fireEvent.change(select, { target: { value: EXAM2 } })
    expect(mockRouterReplace).toHaveBeenCalledWith(expect.stringContaining(`exam=${EXAM2}`))
  })
})
