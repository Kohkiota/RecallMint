// get-dexie-session-cards test。 fake-indexeddb で実 Dexie を動かし、 選択試験
// スコープの読み込み + 出題プール契約(Dash-1 Home v1 §8.5)+ Card 型変換を verify。
//
// 選定条件そのもの(state 別の切り方 / k 計算 / 順序)の網羅は
// `lib/cards/domain/session-pool.test.ts` が持つ。 本 file は「Dexie の行を欠落なく
// 渡し、K を正しい試験・正しい owner から取り、cap をかけて Card 型で返す」ことを pin する。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { getDueCardsFromDexie } from './get-dexie-session-cards'

// JST 2026-08-18 12:00。今日の JST 範囲 = [2026-08-17T15:00Z, 2026-08-18T15:00Z)。
const NOW = new Date('2026-08-18T03:00:00.000Z')
const LATER_TODAY = '2026-08-18T09:00:00.000Z'
const TOMORROW = '2026-08-18T15:00:00.000Z'
const PAST = '2026-08-17T03:00:00.000Z'

const USER = 'user-1'
const EXAM = 'exam-1'

function fakeClient(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
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
    due: PAST,
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

function fakeExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: EXAM,
    user_id: USER,
    name: 'Exam',
    daily_new_target: null,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  await getClientDb().cards.clear()
  await getClientDb().exams.clear()
  await getClientDb().exams.put(fakeExam())
})

afterEach(() => {
  // spy 後の cleanup (構造 unit test で where を spy するため)。
  vi.restoreAllMocks()
})

describe('getDueCardsFromDexie', () => {
  it('空 table → 空配列', async () => {
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out).toEqual([])
  })

  it('出題対象が無い (翌日 due の Review / 未到来の Learning のみ) → 空配列', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'r-tomorrow', state: 2, due: TOMORROW }),
      fakeClient({ id: 'l-later', state: 1, due: LATER_TODAY }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out).toEqual([])
  })

  it('プール契約どおりに選び、 Card 型 (camelCase + Date) に変換して返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'r-later', state: 2, due: LATER_TODAY }),
      fakeClient({ id: 'l-later', state: 1, due: LATER_TODAY }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['r-later'])
    // Date 型 (Card 型) であることを確認
    expect(out[0]?.due).toBeInstanceOf(Date)
    expect(out[0]?.due.toISOString()).toBe(LATER_TODAY)
    // camelCase field 名 (Card 型) であることを確認
    expect(out[0]?.userId).toBe(USER)
    expect(out[0]?.examId).toBe(EXAM)
  })

  it('復習部 (due ASC) → 新規部 (base_order ASC) の順で返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'new-b', state: 0, base_order: 2048, due: PAST }),
      fakeClient({ id: 'review-new', state: 2, due: LATER_TODAY }),
      fakeClient({ id: 'new-a', state: 0, base_order: 1024, due: PAST }),
      fakeClient({ id: 'review-old', state: 2, due: PAST }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual([
      'review-old',
      'review-new',
      'new-a',
      'new-b',
    ])
  })

  it('exams.daily_new_target が新規の件数上限になる', async () => {
    await getClientDb().exams.put(fakeExam({ daily_new_target: 1 }))
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'n1', state: 0, base_order: 1024 }),
      fakeClient({ id: 'n2', state: 0, base_order: 2048 }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['n1'])
  })

  it('他 owner の exams 行の daily_new_target は採用しない (既定 K に落ちる)', async () => {
    // mirror は owner scope で掃除される前提だが、K の読み出しも owner 固定にする
    // (query は必ず owner scope の絶対ルール)。
    await getClientDb().exams.put(
      fakeExam({ user_id: 'user-2', daily_new_target: 0 }),
    )
    await getClientDb().cards.bulkPut([fakeClient({ id: 'n1', state: 0 })])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['n1'])
  })

  it('別試験の card は混ざらない (試験スコープ)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'mine', due: PAST }),
      fakeClient({ id: 'others-exam', exam_id: 'exam-2', due: PAST }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['mine'])
  })

  it('limit 超え → limit 件で truncate', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-08-15T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-08-16T00:00:00.000Z' }),
      fakeClient({ id: 'c', due: '2026-08-17T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 2, NOW)
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('limit=null → 全件返す (上限なし)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-08-15T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-08-16T00:00:00.000Z' }),
      fakeClient({ id: 'c', due: '2026-08-17T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, null, NOW)
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('他 user の cards は含まれない (tenant isolation)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'mine', user_id: USER }),
      fakeClient({ id: 'others', user_id: 'user-2' }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['mine'])
  })

  it('now 省略時は new Date() (= 現在時刻、 未来日の Review は除外)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'past', state: 2, due: '2020-01-01T00:00:00.000Z' }),
      // 100 年先は除外される
      fakeClient({ id: 'far-future', state: 2, due: '2126-01-01T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10)
    expect(out.map((c) => c.id)).toEqual(['past'])
  })

  // 構造 unit test: `[user_id+exam_id]` compound index (v6) の equals 経路を通り、
  // 旧 `where('user_id')` の全 exam 走査に逆戻りしていないことを spy で検知
  // (T-B4 / T-B6 precedent と同 pattern)。 index 第 1 要素 user_id の equals fix が
  // tenant 漏れの構造保証でもある。
  it('構造: [user_id+exam_id] index の equals 経路を使い、 where(user_id) 全件走査に戻らない', async () => {
    await getClientDb().cards.bulkPut([fakeClient({ id: 'past', due: PAST })])
    const whereSpy = vi.spyOn(getClientDb().cards, 'where')
    await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    // Dexie `where` overload (string / string[] / equality object) で vi.spyOn の型推論は
    // equality object 側に寄るため、 mock.calls を unknown 経由で再解釈する
    // (dashboard-actions.test.tsx T-B6 precedent と同 pattern)。
    const firstArgs = (whereSpy.mock.calls as unknown as unknown[][]).map(
      (c) => c[0],
    )
    const stringFirstArgs = firstArgs.filter(
      (a): a is string => typeof a === 'string',
    )
    expect(
      stringFirstArgs.filter((a) => a === '[user_id+exam_id]'),
    ).toHaveLength(1)
    expect(stringFirstArgs.filter((a) => a === 'user_id')).toHaveLength(0)
  })

  it('別 user の card は index 経路で到達不能 ([user_id+exam_id] 第 1 要素 equals fix)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'mine-past', user_id: USER, due: PAST }),
      fakeClient({ id: 'others-past', user_id: 'user-2', due: PAST }),
    ])
    const out = await getDueCardsFromDexie(USER, EXAM, 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['mine-past'])
  })
})
