// @vitest-environment jsdom
// CompactOptionsCell (Edit-2 T2) の基本動作 test。
// table cell 用 compact editable 選択肢 component。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// runOptimisticUpdate / getClientDb は fake-indexeddb の実 Dexie で動かす。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ClientCardImage, ClientCardOption } from '@/lib/client-db'
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
// Sprint T T6: CompactOptionsCell が CardImageGallery を import するようになり、gallery が
// '../_actions/asset-actions'(server action・R2_* env fail-fast)と '@/lib/media/get-asset'
// を real import するため、未 mock だと module load 時に throw する(columns test と同じ制約)。
const { mockGetAssetObjectURL, mockAttachImageToCard } = vi.hoisted(() => ({
  mockGetAssetObjectURL: vi.fn(async () => 'blob:mock-object-url' as string | null),
  // Sprint T add(2026-07-17): 選択肢 add affordance の attach 経路検証用。
  mockAttachImageToCard: vi.fn(async () => ({ ok: true, assetId: 'asset-x' }) as never),
}))
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: mockGetAssetObjectURL,
}))
vi.mock('@/lib/media/upload', () => ({
  attachImageToCard: mockAttachImageToCard,
  removeImageFromCard: vi.fn(async () => {}),
}))

import { CompactOptionsCell } from './exam-card-table-options-edit-cell'

const CARD_ID = '44444444-4444-4444-8444-444444444444'

const baseOptions: ClientCardOption[] = [
  { id: 'a', text: '選択肢A', is_correct: true, explanation: 'A 理由' },
  { id: 'b', text: '選択肢B', is_correct: false },
]

async function seedCard(options: ClientCardOption[]) {
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
  // commit が void runOptimisticUpdate (fire-and-forget) なので、前 test の
  // transaction が settle 前に次 test が始まると mockEnqueue に stale call が bleed する。
  // useRealTimers → cards.clear() を mock 操作の前に置いて前 test を drain する。
  vi.useRealTimers()
  await getClientDb().cards.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — 表示', () => {
  it('N 個の選択肢が縦積みで全て描画される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    // 各選択肢の本文が display cell (role=button) として出る
    expect(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' }).length,
    ).toBe(2)
    expect(screen.getByText('選択肢A')).toBeInTheDocument()
    expect(screen.getByText('選択肢B')).toBeInTheDocument()
  })

  it('空 options 配列 → クラッシュしない', () => {
    // no throw
    expect(() =>
      render(<CompactOptionsCell cardId={CARD_ID} options={[]} images={[]} userId="user-opt" />),
    ).not.toThrow()
    // 「+ 選択肢を追加」 は出る
    expect(
      screen.getByRole('button', { name: '+ 選択肢を追加' }),
    ).toBeInTheDocument()
  })

  it('explanation あり → 解説テキストが表示される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />)
    expect(screen.getByText('A 理由', { exact: false })).toBeInTheDocument()
  })

  it('explanation 未設定 → placeholder が表示される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} images={[]} userId="user-opt" />)
    expect(screen.getByText('解説 (クリックで追加)')).toBeInTheDocument()
  })

  it('「+ 選択肢を追加」 button が描画される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    expect(
      screen.getByRole('button', { name: '+ 選択肢を追加' }),
    ).toBeInTheDocument()
  })

  it('削除 button が各 option に描画される', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    expect(
      screen.getAllByRole('button', { name: '選択肢を削除' }).length,
    ).toBe(2)
  })

  it('options.length === 1 → 削除 button が disabled', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />)
    expect(
      screen.getByRole('button', { name: '選択肢を削除' }),
    ).toBeDisabled()
  })

  it('is_correct=true の checkbox が checked', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />)
    expect(
      (screen.getByRole('checkbox') as HTMLInputElement).checked,
    ).toBe(true)
  })

  it('is_correct=false の checkbox が unchecked', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} images={[]} userId="user-opt" />)
    expect(
      (screen.getByRole('checkbox') as HTMLInputElement).checked,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkbox toggle
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — checkbox toggle', () => {
  it('checkbox toggle → enqueue (即時 drain)', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!) // option b を ON
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
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

  it('checkbox toggle → flush が即時叩かれる', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    fireEvent.click(screen.getAllByRole('checkbox')[0]!) // option a を OFF
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// text click-to-edit
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — text click-to-edit', () => {
  it('text cell click → edit mode (textarea 表示)', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
    ).toBeInTheDocument()
  })

  it('text 編集 + blur → mirror cards.update に options が書かれる', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 本文 編集' })[0]!,
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      { target: { value: '選択肢A 改' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(async () => {
      const row = await getClientDb().cards.get(CARD_ID)
      expect(row?.options).toEqual([
        { id: 'a', text: '選択肢A 改', is_correct: true, explanation: 'A 理由' },
        { id: 'b', text: '選択肢B', is_correct: false },
      ])
    })
  })

  it('値変更なし + blur → enqueue されない', async () => {
    await seedCard([baseOptions[0]!])
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />,
    )
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 本文 編集' }))
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('textbox', { name: '選択肢 本文 編集' }),
      ).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// explanation click-to-edit (incl. drop-on-empty)
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — explanation click-to-edit', () => {
  it('explanation cell click → edit mode (textarea 表示)', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} images={[]} userId="user-opt" />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 解説 編集' }))
    expect(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
    ).toBeInTheDocument()
  })

  it('explanation 編集 + blur → enqueue に explanation 含む', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[1]!, // option b
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
      { target: { value: 'B 理由' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            {
              id: 'a',
              text: '選択肢A',
              isCorrect: true,
              explanation: 'A 理由',
            },
            { id: 'b', text: '選択肢B', isCorrect: false, explanation: 'B 理由' },
          ],
        },
      })
    })
  })

  it('explanation を空文字に → enqueue payload から explanation key が drop される', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢 解説 編集' })[0]!, // option a (has explanation)
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: '選択肢 解説 編集' }),
      { target: { value: '' } },
    )
    fireEvent.blur(screen.getByRole('textbox', { name: '選択肢 解説 編集' }))
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
        op: 'update_field',
        patch: {
          field: 'options',
          value: [
            { id: 'a', text: '選択肢A', isCorrect: true }, // explanation key dropped
            { id: 'b', text: '選択肢B', isCorrect: false },
          ],
        },
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T1: CompactOptionsCell 縦密度 (table 専用層)
// ---------------------------------------------------------------------------

describe('Edit-3 T1: CompactOptionsCell 縦密度 (table 専用層)', () => {
  it('外側 div に space-y-0.5 があり space-y-1 がない', () => {
    const { container } = render(
      <CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />,
    )
    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain('space-y-0.5')
    expect(outer.className).not.toContain('space-y-1')
  })

  it('選択肢ボックスに px-1.5 py-0.5 があり p-1.5 (単独) がない', () => {
    const { container } = render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />,
    )
    const optionBox = container.querySelector('.rounded.border') as HTMLElement
    expect(optionBox.className).toContain('px-1.5')
    expect(optionBox.className).toContain('py-0.5')
    // p-1.5 は px-1.5 のサブストリングにはならない ('p-' vs 'px-' で異なる)
    expect(optionBox.className).not.toContain('p-1.5')
  })

  it('checkbox label の min-h-8 が維持されている (tap target 保護)', () => {
    const { container } = render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />,
    )
    const checkboxLabel = container.querySelector('label') as HTMLElement
    expect(checkboxLabel.className).toContain('min-h-8')
  })

  it('削除ボタンの min-h-8 が維持されている (tap target 保護)', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    const deleteBtn = screen.getAllByRole('button', { name: '選択肢を削除' })[0]!
    expect((deleteBtn as HTMLElement).className).toContain('min-h-8')
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T2: CompactOptionsCell desktop min-h 削減 (24px 床)
// ---------------------------------------------------------------------------

describe('Edit-3 T2: CompactOptionsCell desktop min-h ~24px 削減', () => {
  it('text cell display div(inner box) に md:min-h-6 が付き md:min-h-8 がない', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} images={[]} userId="user-opt" />)
    // is_correct=false の text cell (displayClassName="text-sm text-slate-800 md:min-h-6 md:py-0.5")
    const btn = screen.getByRole('button', { name: '選択肢 本文 編集' })
    const classes = btn.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('text cell edit textarea(inner box) に md:min-h-6 が付き md:min-h-8 がない', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[1]!]} images={[]} userId="user-opt" />)
    fireEvent.click(screen.getByRole('button', { name: '選択肢 本文 編集' }))
    const ta = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    const classes = ta.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('explanation cell display div(inner box) に md:min-h-6 が付き md:min-h-8 がない', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />)
    // explanation cell (displayClassName="text-xs text-slate-600 md:min-h-6 md:py-0.5")
    const btn = screen.getByRole('button', { name: '選択肢 解説 編集' })
    const classes = btn.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('checkbox label に md:min-h-6 が付く (desktop tap target ~24px)', () => {
    const { container } = render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />,
    )
    const label = container.querySelector('label') as HTMLElement
    const classes = label.className.split(' ')
    expect(classes).toContain('md:min-h-6')
  })

  it('削除ボタンに md:min-h-6 が付く (desktop tap target ~24px)', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    const deleteBtn = screen.getAllByRole('button', { name: '選択肢を削除' })[0]!
    const classes = (deleteBtn as HTMLElement).className.split(' ')
    expect(classes).toContain('md:min-h-6')
  })

  it('mobile は touch target を維持: checkbox label に min-h-8 が残る', () => {
    const { container } = render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />,
    )
    const label = container.querySelector('label') as HTMLElement
    expect(label.className.split(' ')).toContain('min-h-8')
  })

  it('mobile は touch target を維持: 削除ボタンに min-h-8 が残る', () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />)
    const deleteBtn = screen.getByRole('button', { name: '選択肢を削除' })
    expect((deleteBtn as HTMLElement).className.split(' ')).toContain('min-h-8')
  })
})

// ---------------------------------------------------------------------------
// add / delete
// ---------------------------------------------------------------------------

describe('CompactOptionsCell — add / delete', () => {
  it('「+ 追加」 click → 新 option が optimistic に末尾追加される (削除ボタン数で確認)', async () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    expect(
      screen.getAllByRole('button', { name: '選択肢を削除' }).length,
    ).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      // 新 option は autoEditOnMount=true で即 edit mode になるため、
      // text cell は textbox として出る。削除ボタン数で行追加を確認する。
      expect(
        screen.getAllByRole('button', { name: '選択肢を削除' }).length,
      ).toBe(3)
    })
  })

  it('「+ 追加」 click → 新 option の text cell が即 edit mode になる', async () => {
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    fireEvent.click(screen.getByRole('button', { name: '+ 選択肢を追加' }))
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: '選択肢 本文 編集' }),
      ).toBeInTheDocument()
    })
  })

  it('削除 click → 該当 option が optimistic に消え enqueue', async () => {
    await seedCard(baseOptions)
    render(<CompactOptionsCell cardId={CARD_ID} options={baseOptions} images={[]} userId="user-opt" />)
    expect(screen.getByText('選択肢B')).toBeInTheDocument()
    fireEvent.click(
      screen.getAllByRole('button', { name: '選択肢を削除' })[1]!, // option b
    )
    await vi.waitFor(() => {
      expect(screen.queryByText('選択肢B')).not.toBeInTheDocument()
    })
    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'card',
        entity_id: CARD_ID,
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

  it('options.length === 1 → 削除 button が disabled (canDelete=false)', () => {
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[baseOptions[0]!]} images={[]} userId="user-opt" />,
    )
    expect(
      screen.getByRole('button', { name: '選択肢を削除' }),
    ).toBeDisabled()
  })
})

// Sprint T T6 + add(2026-07-17 OT): 選択肢 gallery 配線(option:<uid> target・
// thumbnail + compact add affordance)。uid gate 付き。
describe('Sprint T T6: 選択肢 gallery 配線(thumbnail + add)', () => {
  const OPT_IMG: ClientCardImage = {
    key: '22222222-2222-4222-8222-222222222222',
    target: 'option:opt-uid-1',
    alt: '選択肢画像',
  }
  const optWithUid: ClientCardOption = { id: 'a', text: '選A', is_correct: true, uid: 'opt-uid-1' }

  it('① uid あり選択肢 + 該当画像 → サムネ(img)描画', async () => {
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[optWithUid]} images={[OPT_IMG]} userId="user-opt" />,
    )
    expect(await screen.findByAltText('選択肢画像')).toBeInTheDocument()
  })

  it('② uid なし選択肢 → gallery 描画されず(opt.uid gate の負テスト)', () => {
    // canonical Imp#1: gate が消えると target=`option:${undefined}`=「option:undefined」で
    // gallery が render される。それに一致する画像を置くことで gate 除去 = RED を作る。
    // 判定は **同期** の loading placeholder(.animate-pulse)で行う — img/alt は objectURL
    // 解決後(非同期)にしか出ないため、同期の querySelector('img') では gate 有無を区別できない。
    // gate 健在 = gallery wrapper ごと出ない → placeholder なし。gate 除去 = 一致画像で
    // thumbnail(loading placeholder)が同期描画される。
    const GHOST_IMG: ClientCardImage = {
      key: '33333333-3333-4333-8333-333333333333',
      target: 'option:undefined',
      alt: 'ghost 画像',
    }
    const { container } = render(
      <CompactOptionsCell
        cardId={CARD_ID}
        options={[{ id: 'a', text: '選A', is_correct: true }]}
        images={[GHOST_IMG]}
        userId="user-opt"
      />,
    )
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('③ uid あり選択肢に add affordance が出る(選択肢 id 文脈付き aria-label)', () => {
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[optWithUid]} images={[]} userId="user-opt" />,
    )
    expect(screen.getByRole('button', { name: '選択肢 a に画像を追加' })).toBeInTheDocument()
  })

  it('③-b uid なし選択肢では add affordance も出ない(uid gate と整合)', () => {
    render(
      <CompactOptionsCell
        cardId={CARD_ID}
        options={[{ id: 'a', text: '選A', is_correct: true }]}
        images={[]}
        userId="user-opt"
      />,
    )
    expect(screen.queryByRole('button', { name: /画像を追加/ })).toBeNull()
  })

  it('③-c uid ありでも text 空(ghost 選択肢)では add が出ない(孤児化防止・card view と同 gate)', () => {
    // Codex P2: 空 ghost 選択肢に add を出すと未確定 option へ添付 → drop 時に孤児化する。
    // card view(inline-option-row:262)は text 非空 gate で回避しており、それに揃える。
    render(
      <CompactOptionsCell
        cardId={CARD_ID}
        options={[{ id: 'a', text: '', is_correct: false, uid: 'ghost-uid-1' }]}
        images={[]}
        userId="user-opt"
      />,
    )
    expect(screen.queryByRole('button', { name: /画像を追加/ })).toBeNull()
  })

  it('④ add 押下(file 選択)→ 既存 attachImageToCard 経路が呼ばれる(独自経路なし)', async () => {
    const { container } = render(
      <CompactOptionsCell cardId={CARD_ID} options={[optWithUid]} images={[]} userId="user-opt" />,
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() =>
      expect(mockAttachImageToCard).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'option:opt-uid-1',
          cardId: CARD_ID,
          userId: 'user-opt',
        }),
        expect.anything(),
      ),
    )
  })

  it('⑤ 選択肢サムネは削除可能(readOnly でない → 既存 remove 経路)', async () => {
    render(
      <CompactOptionsCell cardId={CARD_ID} options={[optWithUid]} images={[OPT_IMG]} userId="user-opt" />,
    )
    expect(await screen.findByRole('button', { name: '画像を削除' })).toBeInTheDocument()
  })
})
