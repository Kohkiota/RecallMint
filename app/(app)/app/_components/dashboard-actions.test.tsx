// @vitest-environment jsdom
// DashboardActions client component tests (S-perf-3 で IDB 化、 fake-indexeddb seed
// 形式に書き換え)。
//
// 検証観点:
// - props 不要 (userId のみ)、 dueCount は Dexie cards から useLiveQuery で算出
// - 未 pull (Dexie 空 → undefined / 0 件) の境界
// - mount 直後の skeleton (layout shift 防止)
// - tenant 分離 (他 user の cards は混入しない)
// - due 判定は `card.due <= now` (ISO8601 lexicographic compare)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

import { DashboardActions } from './dashboard-actions'

function fakeCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'Q',
    sort_key: null,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-04-22T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

beforeEach(async () => {
  await getClientDb().cards.clear()
})

afterEach(() => {
  cleanup()
})

describe('DashboardActions (Dexie)', () => {
  it('Dexie 空 (mount 直後): スマート復習 link 不在 + 復習完了！ で render 安定する', async () => {
    render(<DashboardActions userId="user-1" />)
    // useLiveQuery は undefined → 数値確定までは skeleton。 fake-indexeddb の
    // microtask 経過後、 空 collection → 0 件 → 復習完了！ に落ち着く。
    await waitFor(() => {
      expect(screen.getByText('復習完了！')).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('link', { name: /スマート復習/ }),
    ).not.toBeInTheDocument()
  })

  it('due card 3 件: スマート復習 link が href=/app/study/smart で件数を表示', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'a', due: '2026-04-21T00:00:00.000Z' }),
      fakeCard({ id: 'b', due: '2026-04-22T00:00:00.000Z' }),
      fakeCard({ id: 'c', due: '2026-04-22T00:00:00.000Z' }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveAttribute('href', '/app/study/smart')
      expect(btn).toHaveTextContent('スマート復習（3件）')
    })
  })

  it('future due (> now) の card は dueCount に含めない', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'past', due: '2026-04-20T00:00:00.000Z' }),
      fakeCard({ id: 'future', due: '2026-05-01T00:00:00.000Z' }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveTextContent('スマート復習（1件）')
    })
  })

  it('他 user の cards は dueCount に含めない (tenant 分離)', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({
        id: 'mine',
        user_id: 'user-1',
        due: '2026-04-20T00:00:00.000Z',
      }),
      fakeCard({
        id: 'theirs',
        user_id: 'other-user',
        due: '2026-04-20T00:00:00.000Z',
      }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveTextContent('スマート復習（1件）')
    })
  })

  it('右 button は「カスタム演習（準備中）」 label で常に disabled', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ due: '2026-04-20T00:00:00.000Z' }),
    ])
    render(<DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />)
    // dueCount 確定を待つ (右 button は常時 disabled だが、 await で render 確定後の
    // 状態を verify する)
    await waitFor(() => {
      expect(
        screen.queryByText('読み込み中', { exact: false }),
      ).not.toBeInTheDocument()
    })
    const btn = screen.getByRole('button', { name: 'カスタム演習（準備中）' })
    expect(btn).toBeDisabled()
  })

  it('useLiveQuery 結果未確定 (undefined) の瞬間は skeleton (aria-busy) を出す', () => {
    // mount 直後 1 tick 以内: useLiveQuery は undefined を返す
    render(<DashboardActions userId="user-1" />)
    expect(screen.getByRole('status', { name: /読み込み中/ })).toBeInTheDocument()
  })

  it('旧「問題演習」link は存在しない', async () => {
    render(<DashboardActions userId="user-1" />)
    await waitFor(() => {
      expect(screen.getByText('復習完了！')).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('link', { name: '問題演習' }),
    ).not.toBeInTheDocument()
  })

  // T-B6 (v7): 旧 `where('user_id').equals(uid).toArray() + JS filter` 経路を撤去し、
  // compound index `[user_id+due]` の range count に置換した path 切替を構造保証する。
  // (b-i) tenant isolation も index 第 1 要素 user_id の equals fix で構造保証されるため、
  // 本 spy 系 test と既存 line 110-128 の dueCount 一致 test で二重に守る。
  // wall-clock 比較は jsdom/fake-indexeddb で意味がないため stg 実測 (sessions/) を正本とする
  // policy (T-B5 と同型、 plan L148 (b-ii))。
  it('T-B6: compound index `[user_id+due]` で .count() を呼び、 旧 user_id getAll/toArray 経路を 0 回 (構造保証 regression)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeCard({ id: 'a', user_id: 'user-1', due: '2026-04-21T00:00:00.000Z' }),
      fakeCard({ id: 'b', user_id: 'user-1', due: '2026-04-22T00:00:00.000Z' }),
    ])

    const whereSpy = vi.spyOn(db.cards, 'where')

    render(
      <DashboardActions userId="user-1" now={new Date('2026-04-22T12:00:00Z')} />,
    )

    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveTextContent('スマート復習（2件）')
    })

    // Dexie `where` overload (string / string[] / equality object) で vi.spyOn の型推論は
    // equality object 側に寄るため、 mock.calls を unknown 経由で再解釈する。
    const firstArgs = (whereSpy.mock.calls as unknown as unknown[][]).map(
      (c) => c[0],
    )
    const stringFirstArgs = firstArgs.filter(
      (a): a is string => typeof a === 'string',
    )
    const compoundCalls = stringFirstArgs.filter((a) => a === '[user_id+due]')
    expect(compoundCalls.length).toBeGreaterThanOrEqual(1)

    // 旧 materialize 経路 (`where('user_id').equals(uid).toArray()`) は撤去済 → 0 回。
    const oldUserIdCalls = stringFirstArgs.filter((a) => a === 'user_id')
    expect(oldUserIdCalls.length).toBe(0)

    whereSpy.mockRestore()
  })

  it('T-B6: large multi-exam fixture で dueCount が全 scan JS filter 経路と完全一致 (a)', async () => {
    // 大規模 (200 cards × 4 exams) で index 経路と JS filter (ground truth) の一致を assert。
    // fixture は valid ISO のみ (欠損行は §補-D で非論点確定のため混ぜない)。
    const now = new Date('2026-04-22T12:00:00Z')
    const nowIso = now.toISOString()
    const examIds = ['exam-A', 'exam-B', 'exam-C', 'exam-D']
    const fixture: ClientCard[] = []
    for (let i = 0; i < 200; i++) {
      // due を now の前後 200 日に散らす。 owner 7 割、 他 user 3 割を混ぜる。
      const offsetDays = (i % 100) - 50
      const due = new Date(now.getTime() + offsetDays * 86_400_000).toISOString()
      const isOwner = i % 10 < 7
      fixture.push(
        fakeCard({
          id: `card-${i}`,
          user_id: isOwner ? 'user-1' : 'other-user',
          exam_id: examIds[i % examIds.length]!,
          due,
        }),
      )
    }
    await getClientDb().cards.bulkPut(fixture)

    // Ground truth (JS filter 経路、 旧コードと等価): user_id + due <= now のみ count
    const expected = fixture.filter(
      (c) => c.user_id === 'user-1' && c.due <= nowIso,
    ).length
    expect(expected).toBeGreaterThan(0) // sanity: 0 だと test が空回り

    render(<DashboardActions userId="user-1" now={now} />)

    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      expect(btn).toHaveTextContent(`スマート復習（${expected}件）`)
    })
  })

  it('T-B6: due == nowIso ぴったり境界の card が dueCount に含まれる (Dexie .between default includeUpper=false 罠を test で守る)', async () => {
    // §補-E で発覚: Dexie `.between(lower, upper, includeLower=true, includeUpper=false)`
    // の default `includeUpper=false` で upper exclusive のため、 第 4 引数 `true` を
    // 明示しないと `due == nowIso` ぴったり行が落ちる (元コード `c.due <= nowIso` は
    // inclusive)。 本 test は境界 1 行を明示して semantics を守る形。
    const now = new Date('2026-04-22T12:00:00Z')
    const nowIsoExact = now.toISOString()
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'just-past', user_id: 'user-1', due: '2026-04-22T11:59:59.999Z' }),
      fakeCard({ id: 'now-exact', user_id: 'user-1', due: nowIsoExact }),
      fakeCard({ id: 'just-future', user_id: 'user-1', due: '2026-04-22T12:00:00.001Z' }),
    ])
    render(<DashboardActions userId="user-1" now={now} />)
    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      // just-past + now-exact = 2 件、 just-future は除外
      expect(btn).toHaveTextContent('スマート復習（2件）')
    })
  })

  it('T-B6: 他 user の due-now row は index 経路で count に含めない (tenant isolation 構造 b-i)', async () => {
    // 既存 line 110-128 の tenant 分離 test を補強。 user-1 / user-2 / user-3 の三者で
    // due も exam も同一の cards を seed し、 index 経路の range 上限 (= 第 1 要素
    // userId の equals fix) が他 user を構造的に弾くことを assert。
    const now = new Date('2026-04-22T12:00:00Z')
    const dueIso = '2026-04-20T00:00:00.000Z' // 全員 due ≤ now
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'm1', user_id: 'user-1', exam_id: 'shared', due: dueIso }),
      fakeCard({ id: 'm2', user_id: 'user-1', exam_id: 'shared', due: dueIso }),
      fakeCard({ id: 'm3', user_id: 'user-1', exam_id: 'shared', due: dueIso }),
      fakeCard({ id: 't1', user_id: 'user-2', exam_id: 'shared', due: dueIso }),
      fakeCard({ id: 't2', user_id: 'user-2', exam_id: 'shared', due: dueIso }),
      fakeCard({ id: 'u1', user_id: 'user-3', exam_id: 'shared', due: dueIso }),
    ])

    render(<DashboardActions userId="user-1" now={now} />)

    await waitFor(() => {
      const btn = screen.getByRole('link', { name: /スマート復習/ })
      // 3 (user-1) のみ、 user-2 + user-3 の計 3 件は count に含まれない
      expect(btn).toHaveTextContent('スマート復習（3件）')
    })
    // 5 / 6 件にならないこと (= 他 user 混入なし) を念のため明示
    expect(screen.queryByText(/スマート復習（5件）/)).not.toBeInTheDocument()
    expect(screen.queryByText(/スマート復習（6件）/)).not.toBeInTheDocument()
  })
})
