// @vitest-environment jsdom
// 試験詳細 page の選択肢 inline 編集 (`InlineOptionList` + 内部 `InlineOptionRow`)
// の基本動作 test (Stage 4 / Task 4.2 cutover 後)。 cell blur / checkbox toggle /
// add / delete の commit は mirror 直書き (Dexie cards.update に options +
// correct_answer_ids) + outbox enqueue (op='update_field', field='options',
// value=camelCase ZodOption[])。 ghost row (text='') は sanitize で payload から除外。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock、 mirror write は
// fake-indexeddb の実 Dexie で assert する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CardOption } from '@/lib/db/schema'
import { getClientDb } from '@/lib/client-db'

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  // Sprint I W5: handleAddOption が option uid を newId() で mint するため mock に含める。
  newId: () => crypto.randomUUID(),
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { InlineOptionList, InlineOptionCell } from './inline-option-row'

const CARD_ID = '33333333-3333-4333-8333-333333333333'
const TEST_USER_ID = 'user-opt-test'

const baseOptions: CardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

async function seedCard(options: CardOption[]) {
  await getClientDb().cards.put({
    id: CARD_ID,
    user_id: 'user-1',
    exam_id: 'exam-1',
    title: '',
    sort_key: null,
    question_text: '',
    options,
    correct_answer_ids: options.filter((o) => o.is_correct).map((o) => o.id),
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    current_streak: 0,
    due: '2026-01-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sync_status: 'synced',
  } as never)
}

beforeEach(async () => {
  // inline-text-field.test.tsx と同形の順序。 commit が void runOptimisticUpdate
  // (fire-and-forget) 経由なので、 前 test の transaction が settle 前に次 test が
  // 開始すると mockEnqueue に stale call が bleed する。 useRealTimers → cards.clear()
  // を mock 操作の前に置いて前 test の transaction を確実に drain する。
  vi.useRealTimers()
  await getClientDb().cards.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

function renderSingle(option: CardOption) {
  return render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={[option]} />)
}

describe('InlineOptionRow (via InlineOptionList) — 表示', () => {
  it('初期表示: id / text / is_correct=true checked / explanation を描画', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('is_correct=false の option は checkbox unchecked', () => {
    renderSingle(baseOptions[1]!)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('explanation 未設定 → placeholder 表示', () => {
    renderSingle(baseOptions[1]!)
    expect(screen.getByText('解説 (クリックで追加)')).toBeInTheDocument()
  })

  it('a11y: checkbox に aria-label が付与される', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'aria-label',
      '選択肢 正解フラグ 編集',
    )
  })
})

describe('InlineOptionList — cell edit → mirror + enqueue', () => {
  it('id 編集 + blur → options 全体を該当 index のみ書換えて enqueue', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 id 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 id 編集' }), {
      target: { value: 'A1' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 id 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'A1', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: false },
          ],
        },
      })
    })
  })

  it('text 編集 + blur → mirror cards.update に options + correct_answer_ids が書かれる', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: '選択肢A 改' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.options).toEqual([
        { id: 'a', text: '選択肢A 改', is_correct: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', is_correct: false },
      ])
      // correct_answer_ids は is_correct から derive して mirror に楽観反映
      expect(row?.correct_answer_ids).toEqual(['a'])
    })
  })

  it('explanation 編集 + blur → enqueue に explanation 含む', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[1]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 解説 編集' }), {
      target: { value: 'B 理由' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: false, explanation: 'B 理由' },
          ],
        },
      })
    })
  })

  it('explanation を空文字に → enqueue payload から explanation key が drop される', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 解説 編集' }), {
      target: { value: '' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true },
            { id: 'b', text: '選択肢B', isCorrect: false },
          ],
        },
      })
    })
  })

  it('該当 index の field のみ書換、 他 option は touch しない', async () => {
    const opts: CardOption[] = [
      { id: 'a', text: 'A', is_correct: false },
      { id: 'b', text: 'B', is_correct: true, explanation: 'B 理由' },
      { id: 'c', text: 'C', is_correct: false },
    ]
    await seedCard(opts)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={opts} />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[1]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: 'B 改' },
    })
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: 'A', isCorrect: false },
            { id: 'b', text: 'B 改', isCorrect: true, explanation: 'B 理由' },
            { id: 'c', text: 'C', isCorrect: false },
          ],
        },
      })
    })
  })

  it('値変更なし + blur → enqueue されない', async () => {
    await seedCard([baseOptions[0]!])
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 id 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 id 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// Sprint F G(= W2 #5 と同一 test): blur 済み後の unmount で追加 commit が起きない
// ことを pin する。現状(commit-on-unmount 無し)では自明に green だが、W2 で
// commit-on-unmount を付与した後も「blur→unmount 二重 commit ガード」が効いて
// enqueue 合計 1 回のまま = 挙動不変を保証する characterization。W2 で本 test を
// 書き直さず green を維持すること(plan §5 / §7.3・二重実装禁止)。
describe('InlineOptionCell — blur 後 unmount で二重 commit しない (Sprint F G / W2 #5)', () => {
  it('text cell 編集 → blur(enqueue 1 回)→ unmount → enqueue 合計 1 回のまま', async () => {
    await seedCard(baseOptions)
    const { unmount } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: '選択肢A 改' },
    })
    // blur → commit #1
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledTimes(1)
    })
    // blur 済み後に unmount → 追加 commit なし
    // (現状 = commit-on-unmount 無し / W2 後 = latestRef.editing=false で cleanup skip)
    unmount()
    // wall-clock でなく tx 直列化で同期する: 同一 table (cards + entity_mutations) への
    // 空 rw tx は、万一の commit-on-unmount 二重 commit が走らせた in-flight tx を Dexie の
    // rw 直列化で待ってから完了する。これで固定 sleep に依らず enqueue の落ち着き先を作る
    // (Codex P2)。非同期の非イベントを完全 deterministic に捕捉するには production hook が
    // 要り test scope 外 — 主防御は W2 の同期 editing guard(editing=false で cleanup は
    // 同期 short-circuit し async 経路に入らない)であり、本 assert はその回帰ガード。
    await getClientDb().transaction(
      'rw',
      getClientDb().cards,
      getClientDb().entity_mutations,
      async () => {},
    )
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith({
      entity_type: 'card',
      entity_id: CARD_ID,
      op: 'update_field',
      patch: {
        field: 'options',
        value: [
          { id: 'a', text: '選択肢A 改', isCorrect: true, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', isCorrect: false },
        ],
      },
    })
  })
})

// Sprint F W2: InlineOptionCell の commit-on-unmount(データ保全)。仮想化 scroll-out で
// 編集中の cell が blur を伴わず unmount した際に編集値を失わない。InlineTextField の
// commit-on-unmount(#1-#5)と対称。scroll-out 起因の unmount は jsdom で再現不可ゆえ
// RTL unmount() で代替(実 unmount ライフサイクルを通す・非真空)。#5 は G describe が担う。
describe('InlineOptionCell — commit-on-unmount (Sprint F W2)', () => {
  it('#1 保存核心: editing+dirty → unmount → mirror + outbox に更新後 options', async () => {
    await seedCard(baseOptions)
    const { unmount } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: '選択肢A 改' },
    })
    // blur させずに unmount(仮想化 scroll-out による unmount の代替)
    unmount()
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.options).toEqual([
        { id: 'a', text: '選択肢A 改', is_correct: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', is_correct: false },
      ])
    })
    expect(mockEnqueue).toHaveBeenCalledWith({
      entity_type: 'card',
      entity_id: CARD_ID,
      op: 'update_field',
      patch: {
        field: 'options',
        value: [
          { id: 'a', text: '選択肢A 改', isCorrect: true, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', isCorrect: false },
        ],
      },
    })
  })

  it('#2 guard(not editing): display のまま unmount → 書込なし', async () => {
    await seedCard(baseOptions)
    const { unmount } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    // 編集に入らずそのまま unmount
    unmount()
    // 存在 gate/commit の async を tx 直列化で待ってから確認
    await getClientDb().transaction(
      'rw',
      getClientDb().cards,
      getClientDb().entity_mutations,
      async () => {},
    )
    expect(mockEnqueue).not.toHaveBeenCalled()
    const row = await getClientDb().cards.get(CARD_ID)
    expect(row?.options).toEqual(baseOptions)
  })

  it('#3 guard(editing but clean): 値を変えずに unmount → 書込なし', async () => {
    await seedCard(baseOptions)
    const { unmount } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    // 編集に入るが値は変えない
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    unmount()
    await getClientDb().transaction(
      'rw',
      getClientDb().cards,
      getClientDb().entity_mutations,
      async () => {},
    )
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('#4 存在 gate: card 削除後に editing+dirty で unmount → enqueue なし(orphan なし)', async () => {
    await seedCard(baseOptions)
    const { unmount } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(screen.getByRole('textbox', { name: '選択肢 本文 編集' }), {
      target: { value: '選択肢A 改' },
    })
    // card を mirror から削除 → unmount 時の存在 gate が row 不在で commit を skip
    await getClientDb().cards.delete(CARD_ID)
    unmount()
    // gate は fire-and-forget な `cards.get → .then → (broken なら) commit tx → enqueue`。
    // 存在 gate が壊れて commit が走った場合の enqueue を確実に捕捉するため、read + rw tx
    // 直列化を数回挟んで chain を走り切らせてから「0 回」を確定する(1 tx だけでは gate の
    // read prefix 完了前に assert が走り、gate 有無に関わらず green = 空振りになる)。
    for (let i = 0; i < 4; i++) {
      await getClientDb().cards.get(CARD_ID)
      await getClientDb().transaction(
        'rw',
        getClientDb().cards,
        getClientDb().entity_mutations,
        async () => {},
      )
    }
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

describe('InlineOptionList — checkbox toggle', () => {
  it('checkbox change → 即時 mirror + enqueue (blur 待たず)', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // option b を ON
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: true },
          ],
        },
      })
    })
  })

  it('checkbox toggle → mirror の correct_answer_ids が即時更新される', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // b を ON
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.correct_answer_ids).toEqual(['a', 'b'])
    })
  })

  it('checkbox toggle → drain (flush) が即時叩かれる', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('checkbox toggle で正解サマリが即時更新 (optimistic)', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    expect(screen.getByText('○ 正解: a')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    await vi.waitFor(() => {
      expect(screen.getByText('○ 正解: a, b')).toBeInTheDocument()
    })
    expect(screen.queryByText('○ 正解: a')).not.toBeInTheDocument()
  })
})

describe('InlineOptionList — add / delete + ghost', () => {
  it('「+ 選択肢を追加」 button が list 末尾に描画される', () => {
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    expect(
      screen.getByRole('button', { name: '+ 選択肢を追加' }),
    ).toBeInTheDocument()
  })

  it('Sprint I W3/W5: 実選択肢(text 非空 + uid)は compact +画像 を持つが、未入力 ghost には出さない(空 ghost 孤児化防止)', async () => {
    // W5: gallery gate は text 非空 + uid あり。実 option は uid を持つ。
    const optsUid: CardOption[] = [
      { id: 'a', uid: 'a0000000-0000-4000-8000-00000000000a', text: '選択肢A', is_correct: false },
      { id: 'b', uid: 'b0000000-0000-4000-8000-00000000000b', text: '選択肢B', is_correct: false },
    ]
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={optsUid} />)
    // 実選択肢 a/b は compact +画像 affordance を持つ
    expect(
      screen.getByRole('button', { name: '選択肢 a に画像を追加' }),
    ).toBeInTheDocument()
    // 「+ 選択肢を追加」で ghost c(uid は mint されるが text 空)を追加
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await screen.findByText('c')
    // ghost c には gallery を出さない(text 非空になるまで affordance なし)
    expect(
      screen.queryByRole('button', { name: '選択肢 c に画像を追加' }),
    ).not.toBeInTheDocument()
  })

  it('Sprint I W5: uid 無し option(legacy)には gallery を出さない(option:undefined 衝突を構造回避)', () => {
    // uid 無し option が editor に来ても target=option:undefined の gallery を出さない
    // (legacy 同士の衝突 mis-attach を affordance ごと塞ぐ = canonical Important #1)。
    const legacyOpts: CardOption[] = [
      { id: 'a', text: '選択肢A(legacy 無 uid)', is_correct: false },
      { id: 'b', text: '選択肢B(legacy 無 uid)', is_correct: false },
    ]
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={legacyOpts} />)
    expect(screen.queryByRole('button', { name: /に画像を追加$/ })).not.toBeInTheDocument()
  })

  it('削除 button が各 option row に描画される (option 数と一致)', () => {
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    expect(screen.getAllByRole('button', { name: '選択肢を削除' }).length).toBe(2)
  })

  it('options.length === 1 → 削除 button が disabled', () => {
    renderSingle(baseOptions[0]!)
    expect(screen.getByRole('button', { name: '選択肢を削除' })).toBeDisabled()
  })

  it('「+ 追加」: 新 option が optimistic に末尾追加 + text cell が即 edit mode', async () => {
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    expect(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' }).length,
    ).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
  })

  it('「+ 追加」: 新 option の id は nextOptionId 規則 (a,b → c)', () => {
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    expect(screen.getByText('c')).toBeInTheDocument()
  })

  it('追加 click 直後は enqueue されない (text 空 ghost は sanitize で除外)', async () => {
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('追加後 ghost に text 入力 + blur → 昇格して enqueue に new option 含む', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    const ta = await screen.findByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(ta, { target: { value: '新しい選択肢' } })
    fireEvent.blur(ta)
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: false },
            // Sprint I W5: 新規 option c は handleAddOption が uid を mint(ランダム)。
            { id: 'c', uid: expect.any(String), text: '新しい選択肢', isCorrect: false },
          ],
        },
      })
    })
  })

  it('ghost を text 入力なく blur → sanitized が server-committed と一致 → enqueue skip、 ghost は local に残る', async () => {
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    const ta = await screen.findByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.blur(ta)
    // microtask flush しても enqueue されない
    await new Promise((r) => setTimeout(r, 50))
    expect(mockEnqueue).not.toHaveBeenCalled()
    // ghost は local state に残る (display で 'c')
    expect(screen.getByText('c')).toBeInTheDocument()
  })

  it('ghost 放置で別 row checkbox toggle → ghost 除外で別 row 変更のみ enqueue', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // option B を ON
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
            { id: 'b', text: '選択肢B', isCorrect: true },
          ],
        },
      })
    })
  })

  it('削除 click → optimistic に row が消え、 filtered options を enqueue', async () => {
    await seedCard(baseOptions)
    render(<InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />)
    expect(screen.getByText('選択肢B')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '選択肢を削除' })[1]!)
    await vi.waitFor(() => {
      expect(screen.queryByText('選択肢B')).not.toBeInTheDocument()
    })
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card', entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true, explanation: 'A 理由' },
          ],
        },
      })
    })
  })
})

describe('InlineOptionList — auto-resize / layout regression (S2.0b)', () => {
  it('text cell (multiline): textarea に rows attribute が無い', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    expect(ta.tagName).toBe('TEXTAREA')
    expect(ta.hasAttribute('rows')).toBe(false)
  })

  it('id cell (single-line): Input element、 inline style.height は assign されない', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 id 編集' }))
    const inputEl = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(inputEl.tagName).toBe('INPUT')
    expect((inputEl as HTMLInputElement).style.height).toBe('')
  })

  it('text textarea に resize-none + overflow-hidden が付く', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(ta.className).toMatch(/resize-none/)
    expect(ta.className).toMatch(/overflow-hidden/)
  })

  it('text cell mount 時に useLayoutEffect で style.height が inline 設定される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('text cell: editValue 変化で style.height が再 assign される', () => {
    renderSingle(baseOptions[0]!)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', {
      name: '選択肢 本文 編集',
    }) as HTMLTextAreaElement
    ta.style.height = ''
    expect(ta.style.height).toBe('')
    fireEvent.change(ta, { target: { value: '長い\n複数行\nテキスト' } })
    expect(ta.style.height).not.toBe('')
    expect(ta.style.height).toMatch(/px$/)
  })

  it('display / edit 共通: 3 cell 種別とも sharedBoxChrome を持つ、 display は border-transparent + md responsive', () => {
    renderSingle(baseOptions[0]!)
    const idBtn = screen.getByRole('button', { name: '選択肢 id 編集' })
    expect(idBtn.className).toMatch(/min-h-11/)
    expect(idBtn.className).toMatch(/\bp-2\b/)
    expect(idBtn.className).toMatch(/rounded-md/)
    expect(idBtn.className).toMatch(/border-transparent/)
    expect(idBtn.className).toMatch(/md:min-h-8/)
    expect(idBtn.className).toMatch(/md:py-1/)
    fireEvent.click(idBtn)
    const idInput = screen.getByRole('textbox', { name: '選択肢 id 編集' })
    expect(idInput.className).toMatch(/min-h-11/)
    expect(idInput.className).toMatch(/rounded-md/)
    expect(idInput.className).toMatch(/md:min-h-8/)
    expect(idInput.className).toMatch(/md:py-1/)
  })

  it('responsive スリム化: checkbox label に md:min-h-0/md:min-w-0 が付く', () => {
    renderSingle(baseOptions[0]!)
    const checkbox = screen.getByRole('checkbox')
    const label = checkbox.closest('label')!
    expect(label.className).toMatch(/min-h-11/)
    expect(label.className).toMatch(/min-w-11/)
    expect(label.className).toMatch(/md:min-h-0/)
    expect(label.className).toMatch(/md:min-w-0/)
  })

  it('responsive スリム化: checkbox input に md:h-4/md:w-4 が付く', () => {
    renderSingle(baseOptions[0]!)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.className).toMatch(/h-6/)
    expect(checkbox.className).toMatch(/w-6/)
    expect(checkbox.className).toMatch(/md:h-4/)
    expect(checkbox.className).toMatch(/md:w-4/)
  })

  it('displayClassName が両モードに伝搬する (is_correct=true は emerald)', () => {
    renderSingle(baseOptions[0]!)
    const textBtn = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(textBtn.className).toMatch(/font-bold/)
    expect(textBtn.className).toMatch(/text-emerald-900/)
    fireEvent.click(textBtn)
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    expect(ta.className).toMatch(/font-bold/)
    expect(ta.className).toMatch(/text-emerald-900/)
  })

  it('id cell displayClassName (font-mono) も両モードに伝搬', () => {
    renderSingle(baseOptions[0]!)
    const idBtn = screen.getByRole('button', { name: '選択肢 id 編集' })
    expect(idBtn.className).toMatch(/font-mono/)
    fireEvent.click(idBtn)
    expect(
      screen.getByRole('textbox', { name: '選択肢 id 編集' }).className,
    ).toMatch(/font-mono/)
  })

  it('grid wrapper に md:gap-1 が付く (responsive スリム化)', () => {
    const { container } = renderSingle(baseOptions[0]!)
    const grid = container.querySelector('[class*="grid-cols-"]')
    expect(grid).not.toBeNull()
    expect(grid!.className).toMatch(/md:gap-1/)
  })

  it('PC で checkbox label と削除ボタンが md:self-center (縦中央揃え) になる', () => {
    renderSingle(baseOptions[0]!)
    // grid は items-start のまま (本文セルは上端基準)、checkbox/削除だけ self-center で
    // 縦中央に寄せる回帰 fix。md:min-h-0 で 16px に縮んでも行中央に来る。
    const label = screen.getByRole('checkbox').closest('label')!
    expect(label.className).toMatch(/md:self-center/)
    const delBtn = screen.getByRole('button', { name: '選択肢を削除' })
    expect(delBtn.className).toMatch(/md:self-center/)
  })
})

describe('InlineOptionCell — 末尾改行の display 補正 (<br>)', () => {
  it('本文末尾改行ありは display に <br> を 1 つ、 textContent は値そのまま', () => {
    renderSingle({ id: 'a', text: 'あ\n\n', is_correct: false })
    const disp = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(1)
    expect(disp.textContent).toBe('あ\n\n')
  })

  it('本文内部改行のみ (末尾が非改行) は <br> を足さない', () => {
    renderSingle({ id: 'a', text: 'あ\nい', is_correct: false })
    const disp = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(0)
    expect(disp.textContent).toBe('あ\nい')
  })

  it('本文 単一末尾改行 (あ\\n) も <br> 1 個 (N=1)', () => {
    renderSingle({ id: 'a', text: 'あ\n', is_correct: false })
    const disp = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(1)
    expect(disp.textContent).toBe('あ\n')
  })

  it('本文 改行のみ (\\n) は空扱いせず display + <br>', () => {
    renderSingle({ id: 'a', text: '\n', is_correct: false })
    const disp = screen.getByRole('button', { name: '選択肢 本文 編集' })
    expect(disp.querySelectorAll('br')).toHaveLength(1)
    expect(disp.textContent).toBe('\n')
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T2: InlineOptionCell の cn 統一後 twMerge 上書き確認
// displayClassName に md:min-h-6 を渡すと sharedBoxChrome の md:min-h-8 が上書きされる
// ことを display/edit 両パスで確認。inner box 要素(textarea/input/display div)に効く。
// ---------------------------------------------------------------------------

describe('Edit-3 T2: InlineOptionCell displayClassName の md:min-h 上書き (cn 統一 + twMerge)', () => {
  it('display button(inner box): md:min-h-6 が md:min-h-8 を上書き', () => {
    render(
      <InlineOptionCell
        kind="text"
        ariaLabel="テスト 本文 編集"
        value="テスト"
        onSave={() => {}}
        displayClassName="text-sm md:min-h-6 md:py-0.5"
      />,
    )
    const btn = screen.getByRole('button', { name: 'テスト 本文 編集' })
    const classes = btn.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('edit textarea(inner box): md:min-h-6 が md:min-h-8 を上書き', () => {
    render(
      <InlineOptionCell
        kind="text"
        ariaLabel="テスト 本文 編集"
        value="テスト"
        onSave={() => {}}
        displayClassName="text-sm md:min-h-6 md:py-0.5"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'テスト 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: 'テスト 本文 編集' })
    const classes = ta.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('edit input(inner box, id cell): md:min-h-6 が md:min-h-8 を上書き', () => {
    render(
      <InlineOptionCell
        kind="id"
        ariaLabel="テスト id 編集"
        value="x"
        onSave={() => {}}
        displayClassName="md:min-h-6 md:py-0.5"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'テスト id 編集' }))
    const input = screen.getByRole('textbox', { name: 'テスト id 編集' })
    const classes = input.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('display と edit の md:min-h が一致する (layout shift 防止)', () => {
    render(
      <InlineOptionCell
        kind="id"
        ariaLabel="テスト id 編集"
        value="x"
        onSave={() => {}}
        displayClassName="md:min-h-6 md:py-0.5"
      />,
    )
    const btn = screen.getByRole('button', { name: 'テスト id 編集' })
    const displayClasses = btn.className.split(' ')
    fireEvent.click(btn)
    const input = screen.getByRole('textbox', { name: 'テスト id 編集' })
    const editClasses = input.className.split(' ')
    expect(displayClasses).toContain('md:min-h-6')
    expect(editClasses).toContain('md:min-h-6')
    expect(displayClasses).not.toContain('md:min-h-8')
    expect(editClasses).not.toContain('md:min-h-8')
  })
})

describe('InlineOptionList — merge での ghost ライフサイクル (1-a, 70d0714 回帰修正)', () => {
  it('放置された空 ghost は serverOptions 更新 (pull-back) で drop され末尾に残らない', async () => {
    const { rerender } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    // 空のまま追加 (ghost c)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await screen.findByText('c')
    // さらに追加 (ghost d) → autoEditOptionId が d へ移り、c は「放置された空 ghost」に
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await screen.findByText('d')
    // d を入力・確定して server へ反映された状態を rerender で模す (serverOptions に d 追加、c は無い)
    rerender(
      <InlineOptionList
        cardId={CARD_ID} images={[]} userId={TEST_USER_ID}
        options={[...baseOptions, { id: 'd', text: 'D本文', is_correct: false }]}
      />,
    )
    // merge: c (空 かつ autoEdit=d でない) は drop。d は serverOptions に存在 → 残る
    await vi.waitFor(() => {
      expect(screen.queryByText('c')).not.toBeInTheDocument()
    })
    expect(screen.getByText('d')).toBeInTheDocument()
  })

  // 波2 ESLint C1 pin: InlineOptionCell L483 の set-state-in-effect を
// prev-render pattern に置換するときの挙動保存証明。 (a) cell が編集中なら外部 prop
// 変化で editValue は保護 / (b) idle なら次回 edit-start 時に新値が表示される。
  it('cell 編集中に serverOptions の text が外部変化しても editValue (入力中値) は保護される (波2 C1 pin)', async () => {
    const { rerender } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    // 行 a の text cell を edit mode に。
    const dispA = screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!
    fireEvent.click(dispA)
    const taA = screen.getAllByRole('textbox', { name: '選択肢 本文 編集' })[0]!
    fireEvent.change(taA, { target: { value: 'ユーザ入力中' } })
    expect((taA as HTMLTextAreaElement).value).toBe('ユーザ入力中')
    // 外部経路 (別 commit / pull-back 等) で text='A 更新' が降ってくる状況。
    rerender(
      <InlineOptionList
        cardId={CARD_ID} images={[]} userId={TEST_USER_ID}
        options={[
          { id: 'a', text: 'A 更新', is_correct: true, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', is_correct: false },
        ]}
      />,
    )
    // 編集中 cell の入力値は保護される (上書きされない)。
    const taAAfter = screen.getAllByRole('textbox', { name: '選択肢 本文 編集' })[0]!
    expect((taAAfter as HTMLTextAreaElement).value).toBe('ユーザ入力中')
  })

  it('cell が idle なら serverOptions 外部変化で display と次回 edit 時の input 値は新値に同期する (波2 C1 pin)', async () => {
    const { rerender } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    // 初期 display は '選択肢A'。
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    // 外部経路で text='A 更新' が降ってくる。
    rerender(
      <InlineOptionList
        cardId={CARD_ID} images={[]} userId={TEST_USER_ID}
        options={[
          { id: 'a', text: 'A 更新', is_correct: true, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', is_correct: false },
        ]}
      />,
    )
    // idle なので display は新値に同期。
    await vi.waitFor(() => {
      expect(screen.getByText('A 更新')).toBeInTheDocument()
    })
    // edit mode に入っても新値が input に出る (= editValue が同期されている)。
    const dispA = screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!
    fireEvent.click(dispA)
    const taA = screen.getAllByRole('textbox', { name: '選択肢 本文 編集' })[0]!
    expect((taA as HTMLTextAreaElement).value).toBe('A 更新')
  })

  it('連続追加で片方を入力中、 別 commit の serverOptions 更新でも編集中 ghost は消えない (70d0714 保護)', async () => {
    const { rerender } = render(
      <InlineOptionList cardId={CARD_ID} images={[]} userId={TEST_USER_ID} options={baseOptions} />,
    )
    // 1 つ目追加 (ghost c) → 2 つ目追加 (ghost d, autoEdit=d)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await screen.findByText('c')
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await screen.findByText('d')
    // d の text cell に入力中 (blur しない = working-set には未保存、cell の editValue のみ)
    const tas = screen.getAllByRole('textbox', { name: '選択肢 本文 編集' })
    fireEvent.change(tas[tas.length - 1]!, { target: { value: 'D入力中' } })
    // 別経路の commit で serverOptions が更新された状況を rerender で模す (c/d は server に未反映)
    rerender(
      <InlineOptionList
        cardId={CARD_ID} images={[]} userId={TEST_USER_ID}
        options={[
          { id: 'a', text: '選択肢A 改', is_correct: true, explanation: 'A 理由' },
          { id: 'b', text: '選択肢B', is_correct: false },
        ]}
      />,
    )
    // 編集中 ghost d (autoEdit) は保持され、textarea と入力値が失われない
    await vi.waitFor(() => {
      const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
      expect((ta as HTMLTextAreaElement).value).toBe('D入力中')
    })
    // 放置された空 ghost c は drop
    expect(screen.queryByText('c')).not.toBeInTheDocument()
  })
})
