// get-quick-preset-cards test。 fake-indexeddb で実 Dexie を動かし、 preset/tag
// 母集合選定(design doc §7)を Dexie 読み込み〜server Card 型変換まで通しで verify
// する。 選定条件そのもの(述語 / 並び順 / cap / 10分の件数計算)の網羅は
// `lib/cards/domain/quick-preset-selection.test.ts` が持つ。 本 file は「Dexie の
// 行を正しい scope(owner / 試験)で読み、 tag 分岐と preset 分岐を正しく振り分け、
// server Card 型で返す」ことを pin する。

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getClientDb,
  type ClientCard,
  type ClientExam,
  type ClientTagOption,
  type ClientTagCategory,
  type ClientCardTag,
  type ClientAnswerEvent,
} from '@/lib/client-db'
import { getQuickPresetCardsFromDexie } from './get-quick-preset-cards'

// JST 2026-08-18 12:00。今日の JST 範囲 = [2026-08-17T15:00Z, 2026-08-18T15:00Z)。
const NOW = new Date('2026-08-18T03:00:00.000Z')
const YESTERDAY = '2026-08-17T03:00:00.000Z'
const TODAY_EARLY = '2026-08-18T00:00:00.000Z'

const USER = 'user-1'
const EXAM = 'exam-1'
const OTHER_EXAM = 'exam-2'

function fakeCard(overrides?: Partial<ClientCard>): ClientCard {
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
    due: YESTERDAY,
    stability: 30,
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

function fakeCategory(overrides?: Partial<ClientTagCategory>): ClientTagCategory {
  return {
    id: 'cat-1',
    user_id: USER,
    name: 'Category',
    select_type: 'single',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function fakeOption(overrides?: Partial<ClientTagOption>): ClientTagOption {
  return {
    id: 'opt-1',
    user_id: USER,
    category_id: 'cat-1',
    name: 'Option',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function fakeCardTag(overrides?: Partial<ClientCardTag>): ClientCardTag {
  return {
    card_id: 'card-1',
    option_id: 'opt-1',
    user_id: USER,
    created_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function fakeAnswerEvent(overrides?: Partial<ClientAnswerEvent>): ClientAnswerEvent {
  return {
    event_id: 'ev-1',
    user_id: USER,
    session_id: 'session-1',
    card_id: 'card-1',
    selected_answer_ids: [],
    is_correct: true,
    rating: 3,
    answered_at: '2026-08-18T00:00:00.000Z',
    elapsed_ms: 30_000,
    sync_status: 'synced',
    ...overrides,
  }
}

beforeEach(async () => {
  const db = getClientDb()
  await db.cards.clear()
  await db.exams.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.answer_events.clear()
  await db.exams.bulkPut([fakeExam(), fakeExam({ id: OTHER_EXAM })])
})

describe('getQuickPresetCardsFromDexie — preset 分岐', () => {
  it('mistakes: 述語に一致するカードのみ Card 型で返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'mistake', answered: true, last_correct: false }),
      fakeCard({ id: 'correct', answered: true, last_correct: true }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, null, NOW)
    expect(out.kind).toBe('cards')
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['mistake'])
    // server Card 型(camelCase + Date)への変換を確認
    expect(out.cards[0]?.due).toBeInstanceOf(Date)
    expect(out.cards[0]?.examId).toBe(EXAM)
  })

  it('unanswered: base_order ASC で並ぶ(due/id ではなく base_order で決まることを id を逆相関させて確認)', async () => {
    // id の辞書順と base_order の順を意図的に逆にする: due が同値だと
    // due-ASC+id-tiebreak でも偶然 base_order と同じ並びになり、並び替えの根拠を
    // 取り違えても pin が green のままになってしまう(実際にこの取り違いで一度
    // すり抜けた — red 検証で発覚)。
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'a-high-base-order', answered: false, base_order: 2048, due: YESTERDAY }),
      fakeCard({ id: 'z-low-base-order', answered: false, base_order: 1024, due: YESTERDAY }),
    ])
    const out = await getQuickPresetCardsFromDexie(
      USER,
      EXAM,
      'unanswered',
      undefined,
      null,
      NOW,
    )
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual([
      'z-low-base-order',
      'a-high-base-order',
    ])
  })

  it('weak: lapses>=2 && !定着 のみ', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'weak', lapses: 2, state: 1, stability: 5 }),
      fakeCard({ id: 'mature', lapses: 5, state: 2, stability: 30 }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'weak', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['weak'])
  })

  it('母集合が既定件数(10)未満 → 全件返す', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'm1', answered: true, last_correct: false, due: YESTERDAY }),
      fakeCard({ id: 'm2', answered: true, last_correct: false, due: TODAY_EARLY }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards).toHaveLength(2)
  })

  it('session_limit が既定件数より小さい → session_limit で truncate', async () => {
    const cards = Array.from({ length: 15 }, (_, i) =>
      fakeCard({
        id: `m${i}`,
        answered: true,
        last_correct: false,
        due: new Date(2026, 7, 1 + i).toISOString(),
      }),
    )
    await getClientDb().cards.bulkPut(cards)
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, 3, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards).toHaveLength(3)
  })

  it('session_limit が既定件数(10)より大きい → 既定件数で打ち切る(cap は制限しない)', async () => {
    const cards = Array.from({ length: 15 }, (_, i) =>
      fakeCard({
        id: `m${i}`,
        answered: true,
        last_correct: false,
        due: new Date(2026, 7, 1 + i).toISOString(),
      }),
    )
    await getClientDb().cards.bulkPut(cards)
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, 20, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards).toHaveLength(10)
  })

  it('選択試験外のカードは混ざらない', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'mine', exam_id: EXAM, answered: true, last_correct: false }),
      fakeCard({ id: 'other', exam_id: OTHER_EXAM, answered: true, last_correct: false }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['mine'])
  })

  it('他 user の card は含まれない(tenant isolation)', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'mine', user_id: USER, answered: true, last_correct: false }),
      fakeCard({ id: 'others', user_id: 'user-2', answered: true, last_correct: false }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['mine'])
  })

  it('未知 preset(tag 無し)→ invalid', async () => {
    const out = await getQuickPresetCardsFromDexie(
      USER,
      EXAM,
      'not-a-preset',
      undefined,
      null,
      NOW,
    )
    expect(out).toEqual({ kind: 'invalid' })
  })

  it('preset 不在(tag 無し)→ invalid', async () => {
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, undefined, undefined, null, NOW)
    expect(out).toEqual({ kind: 'invalid' })
  })

  it('母集合 0 件 → invalid にせず cards=[] を返す(host の empty UI に委ねる)', async () => {
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'mistakes', undefined, null, NOW)
    expect(out).toEqual({ kind: 'cards', cards: [] })
  })
})

describe('getQuickPresetCardsFromDexie — ten_min(定義 doc §4-N + W5)', () => {
  it('標本 0 件(既定値 20秒)→ floor(600000/20000)=30 件を上限に母集合を返す', async () => {
    // 母集合 2 件のみ(30 に満たない)なので全件返る = 「既定値で計算した」ことの
    // 直接検証ではなく「default 値パスでも動く」ことの検証(件数境界は pure test 側)。
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'r1', state: 2, due: YESTERDAY }),
      fakeCard({ id: 'r2', state: 2, due: TODAY_EARLY }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['r1', 'r2'])
  })

  it('自 owner の実測中央値(100秒・有効上限 120秒以内)が反映される(floor(600000/100000)=6)', async () => {
    // 定義 doc §4-N: elapsed_ms は 120,000ms 超だと標本から除外される(clamp では
    // ない)ため、「遅い中央値」の到達可能な最大は 120,000ms(→ tenMinCount=5)。
    // 1 件の床(max(1,…))自体は `tenMinCount(700_000)` として pure test 側
    // (`quick-preset-selection.test.ts`)で直接 pin する — このレイヤーでは
    // 「実測標本が正しく効くこと」を有効域内の値で確認する。
    const cards = Array.from({ length: 8 }, (_, i) =>
      fakeCard({ id: `r${i}`, state: 2, due: new Date(2026, 7, 1 + i).toISOString() }),
    )
    await getClientDb().cards.bulkPut(cards)
    await getClientDb().answer_events.bulkAdd([
      fakeAnswerEvent({ event_id: 'e1', elapsed_ms: 100_000 }),
      fakeAnswerEvent({ event_id: 'e2', elapsed_ms: 100_000 }),
      fakeAnswerEvent({ event_id: 'e3', elapsed_ms: 100_000 }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    // floor(600000/100000) = 6 件(母集合 8 件のうち due 昇順の先頭 6 件)
    expect(out.cards).toHaveLength(6)
    expect(out.cards.map((c) => c.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
  })

  it('他 owner の answer_events は標本に混ざらない(既定値に落ちる)', async () => {
    // elapsed_ms=700,000(有効上限 120,000ms 超)のような「除外されて当然」の値では
    // owner フィルタが効いていなくても偶然 green になる(estimateMedianMs 自身が
    // 上限超過を弾くため)。owner フィルタそのものを red 検証するには、他 owner の
    // 標本を**有効域内**にし、それが漏れ入ったら結果が変わる母集合サイズにする。
    const cards = Array.from({ length: 8 }, (_, i) =>
      fakeCard({ id: `r${i}`, state: 2, due: new Date(2026, 7, 1 + i).toISOString() }),
    )
    await getClientDb().cards.bulkPut(cards)
    await getClientDb().answer_events.bulkAdd([
      // 有効域内(100秒)。漏れ入れば中央値=100,000 → floor(600000/100000)=6 件に
      // truncate される。正しく除外されれば自 owner 標本 0 件 → 既定値(20秒)経路
      // → floor(600000/20000)=30 件上限(母集合 8 件なので全件)。
      fakeAnswerEvent({ event_id: 'e1', user_id: 'user-2', elapsed_ms: 100_000 }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards).toHaveLength(8)
  })

  it('exams.daily_new_target が新規部の件数上限になる(母集合への反映)', async () => {
    await getClientDb().exams.put(fakeExam({ daily_new_target: 1 }))
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'n1', state: 0, base_order: 1024, due: YESTERDAY }),
      fakeCard({ id: 'n2', state: 0, base_order: 2048, due: YESTERDAY }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['n1'])
  })

  it('他 owner の exams 行の daily_new_target は採用しない(既定 K に落ちる)', async () => {
    await getClientDb().exams.put(fakeExam({ user_id: 'user-2', daily_new_target: 0 }))
    await getClientDb().cards.bulkPut([fakeCard({ id: 'n1', state: 0 })])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['n1'])
  })

  // fix round 1/5 I-1: 混合母集合(復習 + 新規)で全体を due ASC に再ソートすると、
  // 新規カードの due(= 作成時刻)が既存復習の due より必ず古くなり(R-5)、新規が
  // 復習より先頭に来て §8.4/§8.5 が定めた順序(復習部→新規部の連結)が壊れる。
  // 復習・新規のみの単色母集合ではこの bug を検出できない(このバグが混入した
  // 状態で従来 test が green のまま通っていた実例)ため、必ず両方を含める。
  it('復習 + 新規の混合母集合は selectSessionPool の順序(復習部 due ASC → 新規部 base_order ASC)を保つ(再ソートしない)', async () => {
    const THREE_WEEKS_AGO = '2026-07-28T00:00:00.000Z' // 新規カードの due(=作成時刻)。復習の due より古い
    await getClientDb().cards.bulkPut([
      // 新規部を先に insert して「Dexie の行順 = 挿入順」に依存した誤通過を防ぐ
      fakeCard({ id: 'n1', state: 0, base_order: 1024, due: THREE_WEEKS_AGO }),
      fakeCard({ id: 'n2', state: 0, base_order: 2048, due: THREE_WEEKS_AGO }),
      fakeCard({ id: 'r1', state: 2, due: YESTERDAY }),
      fakeCard({ id: 'r2', state: 2, due: TODAY_EARLY }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    // 復習部(due ASC: r1 < r2)が先、新規部(base_order ASC: n1 < n2)が後 —
    // due だけで全体を再ソートすると due が最古の新規 2 件が先頭に来てしまう。
    expect(out.cards.map((c) => c.id)).toEqual(['r1', 'r2', 'n1', 'n2'])
  })

  it('session_limit cap は保たれた順序(復習→新規)のまま先頭から truncate する', async () => {
    const THREE_WEEKS_AGO = '2026-07-28T00:00:00.000Z'
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'n1', state: 0, base_order: 1024, due: THREE_WEEKS_AGO }),
      fakeCard({ id: 'n2', state: 0, base_order: 2048, due: THREE_WEEKS_AGO }),
      fakeCard({ id: 'r1', state: 2, due: YESTERDAY }),
      fakeCard({ id: 'r2', state: 2, due: TODAY_EARLY }),
    ])
    // sessionLimit=3: 復習 2 件 + 新規部の先頭 1 件(n1)。もし全体が due で
    // 再ソートされていれば新規 2 件(n1,n2)+ 復習 1 件(r1)になってしまう。
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, 'ten_min', undefined, 3, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['r1', 'r2', 'n1'])
  })
})

describe('getQuickPresetCardsFromDexie — tag entry(W4「この分野を10問」)', () => {
  it('タグが付く選択試験内カードを due ASC で返す(preset は無視される)', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'tagged-a', due: TODAY_EARLY }),
      fakeCard({ id: 'tagged-b', due: YESTERDAY }),
      fakeCard({ id: 'untagged', due: YESTERDAY }),
    ])
    await getClientDb().tag_categories.put(fakeCategory())
    await getClientDb().tag_options.put(fakeOption())
    await getClientDb().card_tags.bulkPut([
      fakeCardTag({ card_id: 'tagged-a' }),
      fakeCardTag({ card_id: 'tagged-b' }),
    ])
    // preset に不正値を与えても tag が優先される(§7 の設計判断)ことを同時に確認
    const out = await getQuickPresetCardsFromDexie(
      USER,
      EXAM,
      'not-a-preset',
      'opt-1',
      null,
      NOW,
    )
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['tagged-b', 'tagged-a'])
  })

  // fix round 1/5 M-5(c): tag 分岐(get-quick-preset-cards.ts)は due ASC を
  // 直書きしており `quickOrderKindFor` を経由しない。preset='unanswered' は
  // 単独なら base_order ASC になる値なので、この preset を tag と併用した時に
  // 誤って base_order 分岐へ切り替わっていないかを、id と base_order を意図的に
  // 逆相関させた fixture(due 同値)で判別する。
  it('preset=unanswered を伴っても tag 分岐は base_order ではなく due ASC を使う', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({
        id: 'a-high-base-order',
        answered: false,
        base_order: 2048,
        due: YESTERDAY,
      }),
      fakeCard({
        id: 'z-low-base-order',
        answered: false,
        base_order: 1024,
        due: YESTERDAY,
      }),
    ])
    await getClientDb().tag_categories.put(fakeCategory())
    await getClientDb().tag_options.put(fakeOption())
    await getClientDb().card_tags.bulkPut([
      fakeCardTag({ card_id: 'a-high-base-order' }),
      fakeCardTag({ card_id: 'z-low-base-order' }),
    ])
    const out = await getQuickPresetCardsFromDexie(
      USER,
      EXAM,
      'unanswered',
      'opt-1',
      null,
      NOW,
    )
    if (out.kind !== 'cards') throw new Error('unreachable')
    // due 同値なので compareByDue の id tiebreak が効く場合 ['a-high-base-order',
    // 'z-low-base-order'](辞書順)。base_order ASC が誤って使われていれば
    // ['z-low-base-order', 'a-high-base-order'] になる — この 2 つを区別する。
    expect(out.cards.map((c) => c.id)).toEqual([
      'a-high-base-order',
      'z-low-base-order',
    ])
  })

  it('タグは付いているが別試験のカードは除外される', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'in-exam', exam_id: EXAM }),
      fakeCard({ id: 'other-exam', exam_id: OTHER_EXAM }),
    ])
    await getClientDb().tag_categories.put(fakeCategory())
    await getClientDb().tag_options.put(fakeOption())
    await getClientDb().card_tags.bulkPut([
      fakeCardTag({ card_id: 'in-exam' }),
      fakeCardTag({ card_id: 'other-exam' }),
    ])
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, undefined, 'opt-1', null, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards.map((c) => c.id)).toEqual(['in-exam'])
  })

  it('存在しない tag(option_id が card_tags に無い)→ invalid', async () => {
    await getClientDb().cards.bulkPut([fakeCard({ id: 'a' })])
    const out = await getQuickPresetCardsFromDexie(
      USER,
      EXAM,
      undefined,
      'no-such-option',
      null,
      NOW,
    )
    expect(out).toEqual({ kind: 'invalid' })
  })

  it('tag は実在するが選択試験内のどのカードにも付いていない → invalid', async () => {
    await getClientDb().cards.bulkPut([
      fakeCard({ id: 'in-exam', exam_id: EXAM }),
      fakeCard({ id: 'other-exam', exam_id: OTHER_EXAM }),
    ])
    await getClientDb().tag_categories.put(fakeCategory())
    await getClientDb().tag_options.put(fakeOption())
    // タグは別試験のカードにのみ付いている
    await getClientDb().card_tags.put(fakeCardTag({ card_id: 'other-exam' }))
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, undefined, 'opt-1', null, NOW)
    expect(out).toEqual({ kind: 'invalid' })
  })

  it('session_limit が既定件数(10)より小さい → tag 母集合にも cap が効く', async () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      fakeCard({ id: `t${i}`, due: new Date(2026, 7, 1 + i).toISOString() }),
    )
    await getClientDb().cards.bulkPut(cards)
    await getClientDb().tag_categories.put(fakeCategory())
    await getClientDb().tag_options.put(fakeOption())
    await getClientDb().card_tags.bulkPut(
      cards.map((c) => fakeCardTag({ card_id: c.id })),
    )
    const out = await getQuickPresetCardsFromDexie(USER, EXAM, undefined, 'opt-1', 2, NOW)
    if (out.kind !== 'cards') throw new Error('unreachable')
    expect(out.cards).toHaveLength(2)
  })
})
