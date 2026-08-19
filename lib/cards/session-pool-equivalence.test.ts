// client(Dexie)/ server(fallback)同値性 pin(Dash-1 Home v1 §8.5「client / server
// fallback の同値性」・§13.2)。
//
// 同一 fixture・**同一 now を両経路に注入**して、返るカード列が一致することを pin する。
// now を両者に注入するのは「選定ロジックが一致すること」を見たいからで、2 つの時計が
// 一致することを見たいのではない(実運用では client と server の now は別々に取られる)。
//
// **mirror 鮮度差は意図的に対象外**: Dexie mirror は最後に成功した pull の snapshot
// なので、実運用では server が見る行と client が見る行がそもそも違いうる。本 pin が
// 主張するのは「同じ行集合を渡せば同じ答えになる」ことだけで、行集合の鮮度が揃うこと
// ではない。
//
// 行の**読み方**が両経路で違うこと(Dexie の compound index vs SQL の述語 + LIMIT)も
// 意図した設計であり、それぞれの経路の test で個別に pin する。ここでは server 側に
// 「SQL が返すはずの上位集合」を state で分けて与える。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { toCard } from '@/lib/db/cards-mapper'
import type { Card } from '@/lib/db/schema'
import type { TenantDb } from '@/lib/db/tenant-tx'
import { getDueCardsFromDexie } from './get-dexie-session-cards'
import { getSessionCards } from './get-session-cards'

// JST 2026-08-18 12:00。今日の JST 範囲 = [2026-08-17T15:00Z, 2026-08-18T15:00Z)。
const NOW = new Date('2026-08-18T03:00:00.000Z')
const USER = 'user-1'
const EXAM = 'exam-1'
const DAILY_NEW_TARGET = 2

function fakeClient(overrides: Partial<ClientCard> & { id: string }): ClientCard {
  return {
    user_id: USER,
    exam_id: EXAM,
    source_document_id: null,
    title: 'Q',
    question_label: null,
    base_order: 1024,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-08-17T03:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 2,
    learning_steps: 0,
    last_review: null,
    first_reviewed_at: null,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

// 全 state・全境界(当日 later-due / 未到来 step / 翌日 due / 当日導入 / 前日導入 /
// 別試験 / 別 owner)を 1 つに畳んだ fixture。
const FIXTURE: ClientCard[] = [
  fakeClient({ id: 'r-old', state: 2, due: '2026-08-16T00:00:00.000Z' }),
  fakeClient({ id: 'rl-ready', state: 3, due: '2026-08-17T20:00:00.000Z' }),
  fakeClient({ id: 'l-ready', state: 1, due: '2026-08-18T00:00:00.000Z' }),
  fakeClient({ id: 'r-later', state: 2, due: '2026-08-18T09:00:00.000Z' }),
  fakeClient({ id: 'l-later', state: 1, due: '2026-08-18T10:00:00.000Z' }),
  fakeClient({ id: 'r-tomorrow', state: 2, due: '2026-08-19T00:00:00.000Z' }),
  // 当日導入 → K の枠を 1 消費する(due は翌日なのでプールには入らない)
  fakeClient({
    id: 'introduced-today',
    state: 2,
    due: '2026-08-19T00:00:00.000Z',
    first_reviewed_at: '2026-08-18T00:00:00.000Z',
  }),
  // 前日導入 → 枠を消費しない
  fakeClient({
    id: 'introduced-yesterday',
    state: 2,
    due: '2026-08-19T00:00:00.000Z',
    first_reviewed_at: '2026-08-17T03:00:00.000Z',
  }),
  fakeClient({ id: 'n1', state: 0, base_order: 1024 }),
  fakeClient({ id: 'n2', state: 0, base_order: 2048 }),
  fakeClient({ id: 'n3', state: 0, base_order: 3072 }),
  fakeClient({ id: 'other-exam', exam_id: 'exam-2', state: 2 }),
  fakeClient({ id: 'other-user', user_id: 'user-2', state: 2 }),
]

const OWN_ROWS = FIXTURE.filter(
  (c) => c.user_id === USER && c.exam_id === EXAM,
).map(toCard)

// SQL は「復習候補」と「新規候補」を別 SELECT で読む。上位集合を与えれば選定側が
// 同じ答えを出すべき、という契約なので state で分けるだけにする(SQL 述語そのものの
// pin は get-session-cards.test.ts)。
function serverDb(): TenantDb {
  const queue: unknown[][] = [
    [{ dailyNewTarget: DAILY_NEW_TARGET }],
    OWN_ROWS.filter((c) => c.state !== 0),
    OWN_ROWS.filter((c) => c.state === 0).sort(
      (a, b) => a.baseOrder - b.baseOrder,
    ),
  ]
  function chain() {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'limit']) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(queue.shift() ?? []).then(onFulfilled, onRejected)
    return obj
  }
  return { select: () => chain() } as unknown as TenantDb
}

function ids(cards: Card[]): string[] {
  return cards.map((c) => c.id)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  const db = getClientDb()
  await db.cards.clear()
  await db.exams.clear()
  await db.cards.bulkPut(FIXTURE)
  await db.exams.put({
    id: EXAM,
    user_id: USER,
    name: 'Exam',
    daily_new_target: DAILY_NEW_TARGET,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
  } satisfies ClientExam)
})

describe('client / server 同値性(同一 fixture・同一 now)', () => {
  it('上限なし(limit=null)で同じカード列を返す', async () => {
    const client = await getDueCardsFromDexie(USER, EXAM, null, NOW)
    const server = await getSessionCards(USER, EXAM, null, serverDb(), NOW)

    // 空同士の一致で通ってしまわないよう、期待値そのものも固定する
    // (復習部 due ASC → 新規部 base_order ASC、u=1 ゆえ新規は k=1 件)。
    expect(ids(client)).toEqual([
      'r-old',
      'rl-ready',
      'l-ready',
      'r-later',
      'n1',
    ])
    expect(ids(server)).toEqual(ids(client))
  })

  it('session_limit cap 下でも同じカード列を返す', async () => {
    const client = await getDueCardsFromDexie(USER, EXAM, 3, NOW)
    const server = await getSessionCards(USER, EXAM, 3, serverDb(), NOW)
    expect(ids(client)).toEqual(['r-old', 'rl-ready', 'l-ready'])
    expect(ids(server)).toEqual(ids(client))
  })
})
