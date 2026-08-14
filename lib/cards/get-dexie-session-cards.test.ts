// get-dexie-session-cards test (S-local-3 Task 2、 Y-2 T-B7 で index 経路に置換)。
// fake-indexeddb で実 Dexie を動かし、 `[user_id+due]` compound index の range
// cursor + .limit(N) 経路 + tenant 絞りを verify。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { getDueCardsFromDexie } from './get-dexie-session-cards'

function fakeClient(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
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
    due: '2026-05-26T10:00:00.000Z',
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
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

beforeEach(async () => {
  await getClientDb().cards.clear()
})

afterEach(() => {
  // spy 後の cleanup (構造 unit test で where を spy するため)。
  vi.restoreAllMocks()
})

describe('getDueCardsFromDexie', () => {
  const NOW = new Date('2026-05-26T12:00:00.000Z')

  it('空 table → 空配列', async () => {
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toEqual([])
  })

  it('全て future due → 空配列', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-05-27T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-05-28T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toEqual([])
  })

  it('due <= now のみ返却、 Card 型 (camelCase + Date) に変換済', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'past', due: '2026-05-25T00:00:00.000Z' }),
      fakeClient({ id: 'future', due: '2026-05-27T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('past')
    // Date 型 (Card 型) であることを確認
    expect(out[0]?.due).toBeInstanceOf(Date)
    expect(out[0]?.due.toISOString()).toBe('2026-05-25T00:00:00.000Z')
    // camelCase field 名 (Card 型) であることを確認
    expect(out[0]?.userId).toBe('user-1')
    expect(out[0]?.examId).toBe('exam-1')
  })

  it('sort by due asc (古い順)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'middle', due: '2026-05-24T00:00:00.000Z' }),
      fakeClient({ id: 'oldest', due: '2026-05-20T00:00:00.000Z' }),
      fakeClient({ id: 'newest', due: '2026-05-25T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('limit 超え → limit 件で truncate', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-05-20T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-05-21T00:00:00.000Z' }),
      fakeClient({ id: 'c', due: '2026-05-22T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 2, NOW)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('他 user の cards は含まれない (tenant isolation)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'mine', user_id: 'user-1' }),
      fakeClient({ id: 'others', user_id: 'user-2' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('mine')
  })

  it('now 省略時は new Date() (= 現在時刻、 通常 future due は除外)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'past', due: '2020-01-01T00:00:00.000Z' }),
      // 100 年先は除外される
      fakeClient({ id: 'far-future', due: '2126-01-01T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10)
    expect(out.map((c) => c.id)).toEqual(['past'])
  })

  // (A) Y-2 T-B7 regression test: Dexie `.between()` 第 4 引数 (includeUpper) の
  // default は false (upper exclusive) — `true` を明示しないと `due == nowIso`
  // ぴったりの card が session から落ちる real bug を起こす (T-B6 §補-E.3)。
  it('due == nowIso ぴったりの card を結果に含む (Dexie .between() 第 4 引数 true regression)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'on-boundary', due: '2026-05-26T12:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('on-boundary')
  })

  // (B) Y-2 T-B7 構造改善 unit test: [user_id+due] index between+limit 経路を
  // 通っているか / 旧 where('user_id').equals().toArray() 経路に逆戻りしてない
  // かを `where` 引数の spy で検知 (T-B4 / T-B6 precedent と同 pattern)。
  it('構造: [user_id+due] index between+limit 経路を使い、 旧 where(user_id).equals.toArray() 経路を呼ばない', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'past', due: '2026-05-25T00:00:00.000Z' }),
    ])
    const whereSpy = vi.spyOn(getClientDb().cards, 'where')
    await getDueCardsFromDexie('user-1', 10, NOW)
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
      stringFirstArgs.filter((a) => a === '[user_id+due]'),
    ).toHaveLength(1)
    expect(stringFirstArgs.filter((a) => a === 'user_id')).toHaveLength(0)
  })

  it('limit=null → .limit() を呼ばずに全件返す (上限なし)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-05-20T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-05-21T00:00:00.000Z' }),
      fakeClient({ id: 'c', due: '2026-05-22T00:00:00.000Z' }),
    ])
    // limit=null: .limit() を chain しないので 3 件すべて返る
    const out = await getDueCardsFromDexie('user-1', null, NOW)
    expect(out).toHaveLength(3)
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  // (C) Y-2 T-B7 tenant isolation 構造保証: [user_id+due] index の第 1 要素
  // user_id equals fix で他 user の cards に index 経路で到達不能であることを
  // 独立 case で守る (旧 test #6 と意図的に重複、 (B) と組み合わせて新経路でも
  // tenant 漏れない構造を確証する)。
  it('別 user の due card は結果に混ざらない ([user_id+due] 第 1 要素 equals fix の構造保証)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({
        id: 'mine-past',
        user_id: 'user-1',
        due: '2026-05-25T00:00:00.000Z',
      }),
      fakeClient({
        id: 'others-past',
        user_id: 'user-2',
        due: '2026-05-25T00:00:00.000Z',
      }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('mine-past')
  })
})
