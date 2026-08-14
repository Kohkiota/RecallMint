// get-custom-session-cards.test.ts (S2.3 T3)
// fake-indexeddb で実 Dexie を動かして getCustomSessionCards を検証。
// mirror: lib/cards/get-dexie-session-cards.test.ts の fakeClient + beforeEach パターン。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import {
  getCustomSessionCards,
  selectCustomSessionRows,
} from './get-custom-session-cards'
import type { CustomSessionCriteria } from '@/lib/cards/custom-session-criteria'

// ---------------------------------------------------------------------------
// ファクトリ
// ---------------------------------------------------------------------------

let _cardSeq = 0

function fakeClient(overrides?: Partial<ClientCard>): ClientCard {
  _cardSeq++
  return {
    id: `card-${_cardSeq}`,
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: `Q${_cardSeq}`,
    question_label: null,
    base_order: 1024,
    question_text: `question ${_cardSeq}`,
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    // past due (no due gate: even future-due cards must be returned)
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
    created_at: `2026-01-${String(_cardSeq).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

// デフォルト criteria (全件・全 exam・絞り込みなし・sequential)
function baseCriteria(overrides?: Partial<CustomSessionCriteria>): CustomSessionCriteria {
  return {
    userId: 'user-1',
    examIds: [],
    tagFilter: {},
    answerState: 'all',
    streakFilter: null,
    order: 'sequential',
    limit: null,
    ...overrides,
  }
}

beforeEach(async () => {
  _cardSeq = 0
  const db = getClientDb()
  await db.cards.clear()
  await db.card_tags.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
})

// ---------------------------------------------------------------------------
// 基本
// ---------------------------------------------------------------------------

describe('getCustomSessionCards', () => {
  it('空テーブル → 空配列', async () => {
    const out = await getCustomSessionCards(baseCriteria())
    expect(out).toEqual([])
  })

  it('出力は camelCase server Card (questionText / currentStreak / due: Date)', async () => {
    await getClientDb().cards.bulkPut([fakeClient({ id: 'c1' })])
    const out = await getCustomSessionCards(baseCriteria())
    expect(out).toHaveLength(1)
    // camelCase フィールド存在確認
    expect(out[0]).toHaveProperty('questionText')
    expect(out[0]).toHaveProperty('currentStreak')
    // due は Date 型
    expect(out[0]?.due).toBeInstanceOf(Date)
    // snake_case フィールドは存在しない
    expect(out[0]).not.toHaveProperty('question_text')
    expect(out[0]).not.toHaveProperty('current_streak')
  })

  // ---------------------------------------------------------------------------
  // cross-exam (due gate なし)
  // ---------------------------------------------------------------------------

  it('cross-exam: 複数 exam の card を全て返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'c-exam1', exam_id: 'exam-1' }),
      fakeClient({ id: 'c-exam2', exam_id: 'exam-2' }),
    ])
    const out = await getCustomSessionCards(baseCriteria())
    expect(out.map((c) => c.id).sort()).toEqual(['c-exam1', 'c-exam2'])
  })

  it('due gate なし: future-due card も返す', async () => {
    // far future due — due gate があれば除外されるはず
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'future', due: '2099-12-31T00:00:00.000Z' }),
    ])
    const out = await getCustomSessionCards(baseCriteria())
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('future')
  })

  // ---------------------------------------------------------------------------
  // tenant isolation
  // ---------------------------------------------------------------------------

  it('tenant isolation: 他ユーザーの card は除外される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'mine', user_id: 'user-1' }),
      fakeClient({ id: 'others', user_id: 'user-2' }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ userId: 'user-1' }))
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('mine')
  })

  // ---------------------------------------------------------------------------
  // 述語 AND 絞り込み
  // ---------------------------------------------------------------------------

  it('examIds 非空: 指定 exam の card のみ返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'in-exam', exam_id: 'exam-A' }),
      fakeClient({ id: 'out-exam', exam_id: 'exam-B' }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ examIds: ['exam-A'] }))
    expect(out.map((c) => c.id)).toEqual(['in-exam'])
  })

  it('answerState=unanswered: answered=true の card を除外', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'unans', answered: false }),
      fakeClient({ id: 'answered', answered: true }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ answerState: 'unanswered' }))
    expect(out.map((c) => c.id)).toEqual(['unans'])
  })

  it('answerState=correct: last_correct=true のみ返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'correct', answered: true, last_correct: true }),
      fakeClient({ id: 'incorrect', answered: true, last_correct: false }),
      fakeClient({ id: 'never', answered: false, last_correct: null }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ answerState: 'correct' }))
    expect(out.map((c) => c.id)).toEqual(['correct'])
  })

  it('streakFilter lte: 上限以下の streak のみ返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'low', current_streak: 1 }),
      fakeClient({ id: 'high', current_streak: 5 }),
    ])
    const out = await getCustomSessionCards(
      baseCriteria({ streakFilter: { op: 'lte', value: 2 } }),
    )
    expect(out.map((c) => c.id)).toEqual(['low'])
  })

  it('複数述語 AND: examIds × answerState 組み合わせ', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'hit', exam_id: 'exam-A', answered: false }),
      fakeClient({ id: 'wrong-exam', exam_id: 'exam-B', answered: false }),
      fakeClient({ id: 'answered-A', exam_id: 'exam-A', answered: true }),
    ])
    const out = await getCustomSessionCards(
      baseCriteria({ examIds: ['exam-A'], answerState: 'unanswered' }),
    )
    expect(out.map((c) => c.id)).toEqual(['hit'])
  })

  // ---------------------------------------------------------------------------
  // tag フィルタ
  // ---------------------------------------------------------------------------

  it('tagFilter: 指定 option を持つ card のみ返す', async () => {
    const db = getClientDb()
    // tag master
    await db.tag_categories.bulkPut([
      { id: 'cat-1', user_id: 'user-1', name: 'Cat', select_type: 'single', created_at: '', updated_at: '' },
    ])
    await db.tag_options.bulkPut([
      { id: 'opt-A', user_id: 'user-1', category_id: 'cat-1', name: 'A', created_at: '', updated_at: '' },
      { id: 'opt-B', user_id: 'user-1', category_id: 'cat-1', name: 'B', created_at: '', updated_at: '' },
    ])
    await db.cards.bulkPut([
      fakeClient({ id: 'tagged-A' }),
      fakeClient({ id: 'tagged-B' }),
      fakeClient({ id: 'no-tag' }),
    ])
    await db.card_tags.bulkPut([
      { card_id: 'tagged-A', option_id: 'opt-A', user_id: 'user-1', created_at: '' },
      { card_id: 'tagged-B', option_id: 'opt-B', user_id: 'user-1', created_at: '' },
    ])

    const out = await getCustomSessionCards(
      baseCriteria({ tagFilter: { 'cat-1': ['opt-A'] } }),
    )
    expect(out.map((c) => c.id)).toEqual(['tagged-A'])
  })

  // ---------------------------------------------------------------------------
  // order = sequential
  // ---------------------------------------------------------------------------

  it('order=sequential → 基準順 (exam_id → base_order → id)。番号ラベルと created_at は順序に影響しない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      // base_order を昇順の期待と食い違う順で投入し、ラベル / created_at が
      // 順序に効かないことを同時に押さえる (ラベルは降順・created_at も降順)。
      fakeClient({
        id: 'c-3',
        exam_id: 'exam-1',
        base_order: 3072,
        question_label: '001',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
      fakeClient({
        id: 'c-1',
        exam_id: 'exam-1',
        base_order: 1024,
        question_label: '003',
        created_at: '2026-01-03T00:00:00.000Z',
      }),
      fakeClient({
        id: 'c-2',
        exam_id: 'exam-1',
        base_order: 2048,
        question_label: '002',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ order: 'sequential' }))
    expect(out.map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3'])
  })

  it('order=sequential (複数 exam) → exam でグループ化し各 exam 内が基準順', async () => {
    const db = getClientDb()
    // base_order は exam 内でしか意味を持たないため、exam をまたぐ比較は
    // exam_id が第 1 キーになる (spec §2.5)。'exam-1' < 'exam-2' の文字列順。
    await db.cards.bulkPut([
      fakeClient({ id: 'e2-b', exam_id: 'exam-2', base_order: 2048 }),
      fakeClient({ id: 'e1-b', exam_id: 'exam-1', base_order: 2048 }),
      fakeClient({ id: 'e2-a', exam_id: 'exam-2', base_order: 1024 }),
      fakeClient({ id: 'e1-a', exam_id: 'exam-1', base_order: 1024 }),
    ])
    const out = await getCustomSessionCards(
      baseCriteria({ order: 'sequential', examIds: ['exam-1', 'exam-2'] }),
    )
    expect(out.map((c) => c.id)).toEqual(['e1-a', 'e1-b', 'e2-a', 'e2-b'])
  })

  it('order=sequential: base_order 同値は id 昇順で決定的に解決する', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClient({ id: 'zz', base_order: 1024 }),
      fakeClient({ id: 'aa', base_order: 1024 }),
      fakeClient({ id: 'mm', base_order: 1024 }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ order: 'sequential' }))
    expect(out.map((c) => c.id)).toEqual(['aa', 'mm', 'zz'])
  })

  // ---------------------------------------------------------------------------
  // order = random
  // ---------------------------------------------------------------------------

  it('order=random: 注入した決定論的 rng で確定的な順列を返す', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClient({ id: 'c1' }),
      fakeClient({ id: 'c2' }),
      fakeClient({ id: 'c3' }),
    ])

    // Fisher-Yates を固定 rng で予測:
    // i=2: j=floor(0.9*(2+1))=floor(2.7)=2 → swap(2,2): [c1,c2,c3]
    // i=1: j=floor(0.1*(1+1))=floor(0.2)=0 → swap(1,0): [c2,c1,c3]
    const rngValues = [0.9, 0.1]
    let rngIdx = 0
    const deterministicRng = () => rngValues[rngIdx++] ?? 0

    const out = await getCustomSessionCards(baseCriteria({ order: 'random' }), deterministicRng)
    // sequential order で c1,c2,c3 (sort_key=null, created_at 増加順) → 素の ordered は [c1,c2,c3]
    // shuffle 後: [c2,c1,c3]
    expect(out.map((c) => c.id)).toEqual(['c2', 'c1', 'c3'])
  })

  // ---------------------------------------------------------------------------
  // limit
  // ---------------------------------------------------------------------------

  it('limit: 指定件数に cap される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', question_label: '001' }),
      fakeClient({ id: 'b', question_label: '002' }),
      fakeClient({ id: 'c', question_label: '003' }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ limit: 2 }))
    expect(out).toHaveLength(2)
    // sequential なので先頭 2 件
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('limit=null: 全件返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a' }),
      fakeClient({ id: 'b' }),
      fakeClient({ id: 'c' }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ limit: null }))
    expect(out).toHaveLength(3)
  })

  it('limit が件数を超える場合は全件返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a' }),
      fakeClient({ id: 'b' }),
    ])
    const out = await getCustomSessionCards(baseCriteria({ limit: 10 }))
    expect(out).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// selectCustomSessionRows — CardWithTags[] を返すコア選定関数
// ---------------------------------------------------------------------------

describe('selectCustomSessionRows', () => {
  it('タグありカードで tags が保持される (CardWithTags[])', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      { id: 'cat-1', user_id: 'user-1', name: 'Cat', select_type: 'single', created_at: '', updated_at: '' },
    ])
    await db.tag_options.bulkPut([
      { id: 'opt-A', user_id: 'user-1', category_id: 'cat-1', name: 'A', created_at: '', updated_at: '' },
    ])
    await db.cards.bulkPut([fakeClient({ id: 'tagged' })])
    await db.card_tags.bulkPut([
      { card_id: 'tagged', option_id: 'opt-A', user_id: 'user-1', created_at: '' },
    ])

    const rows = await selectCustomSessionRows(baseCriteria())
    expect(rows).toHaveLength(1)
    // CardWithTags 型: .card と .tags を持つ
    expect(rows[0]).toHaveProperty('card')
    expect(rows[0]).toHaveProperty('tags')
    // tags が正しく join されている
    expect(rows[0]!.tags).toHaveLength(1)
    expect(rows[0]!.tags[0]!.option.id).toBe('opt-A')
    expect(rows[0]!.tags[0]!.category.id).toBe('cat-1')
    // toCard していないため snake_case ClientCard
    expect(rows[0]!.card).toHaveProperty('question_text')
    expect(rows[0]!.card).not.toHaveProperty('questionText')
  })

  it('タグなしカードは tags: [] で返る', async () => {
    await getClientDb().cards.bulkPut([fakeClient({ id: 'no-tag' })])
    const rows = await selectCustomSessionRows(baseCriteria())
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tags).toEqual([])
  })

  it('order=sequential → 基準順 (CardWithTags[] の card で比較)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClient({ id: 'c-3', base_order: 3072 }),
      fakeClient({ id: 'c-1', base_order: 1024 }),
      fakeClient({ id: 'c-2', base_order: 2048 }),
    ])
    const rows = await selectCustomSessionRows(baseCriteria({ order: 'sequential' }))
    expect(rows.map((r) => r.card.id)).toEqual(['c-1', 'c-2', 'c-3'])
  })

  it('order=random: 注入した決定論的 rng で確定的な順列を返す (tags 保持)', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      { id: 'cat-1', user_id: 'user-1', name: 'Cat', select_type: 'single', created_at: '', updated_at: '' },
    ])
    await db.tag_options.bulkPut([
      { id: 'opt-X', user_id: 'user-1', category_id: 'cat-1', name: 'X', created_at: '', updated_at: '' },
    ])
    await db.cards.bulkPut([
      fakeClient({ id: 'c1' }),
      fakeClient({ id: 'c2' }),
      fakeClient({ id: 'c3' }),
    ])
    await db.card_tags.bulkPut([
      { card_id: 'c1', option_id: 'opt-X', user_id: 'user-1', created_at: '' },
    ])

    // Fisher-Yates: i=2 j=floor(0.9*3)=2→swap noop; i=1 j=floor(0.1*2)=0→swap(1,0)
    const rngValues = [0.9, 0.1]
    let rngIdx = 0
    const deterministicRng = () => rngValues[rngIdx++] ?? 0

    const rows = await selectCustomSessionRows(baseCriteria({ order: 'random' }), deterministicRng)
    expect(rows.map((r) => r.card.id)).toEqual(['c2', 'c1', 'c3'])
    // c1 のタグが c2 の位置に移動した後も c1 の tags は保持されている
    const c1Row = rows.find((r) => r.card.id === 'c1')
    expect(c1Row!.tags).toHaveLength(1)
    expect(c1Row!.tags[0]!.option.id).toBe('opt-X')
  })

  it('limit cap が CardWithTags[] に適用される', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', question_label: '001' }),
      fakeClient({ id: 'b', question_label: '002' }),
      fakeClient({ id: 'c', question_label: '003' }),
    ])
    const rows = await selectCustomSessionRows(baseCriteria({ limit: 2 }))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.card.id)).toEqual(['a', 'b'])
  })

  it('getCustomSessionCards の出力 id/順序 と一致する (regression)', async () => {
    // selectCustomSessionRows と getCustomSessionCards が同一 rng で同一順序を保証
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'x1', question_label: '001' }),
      fakeClient({ id: 'x2', question_label: '002' }),
      fakeClient({ id: 'x3', question_label: '003' }),
    ])
    const c = baseCriteria({ limit: 2, order: 'sequential' })
    const rows = await selectCustomSessionRows(c)
    const cards = await getCustomSessionCards(c)
    expect(rows.map((r) => r.card.id)).toEqual(cards.map((card) => card.id))
  })
})
