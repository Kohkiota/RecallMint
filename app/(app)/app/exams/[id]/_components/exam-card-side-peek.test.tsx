// @vitest-environment jsdom
// ExamCardSidePeek — presentational panel component の unit test。
// test ①〜⑩ は brief(task-1-brief.md)の完了条件と 1:1 対応。
//
// モック方針:
// - entity-mutations / entity-mutation-flush を spy mock (write path を無害化)。
// - getClientDb は mock しない: fake-indexeddb(vitest.setup.ts global)を使用。
//   test 内で edit mode に入っても値変更なし → cleanup の dirty-guard が commit を skip →
//   Dexie 書込は発生しない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientCard, ClientCardTag, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { ExamCardRow } from './exam-card-table-columns'

// ---------------------------------------------------------------------------
// モック (hoisted → vi.mock より先に定義)
// ---------------------------------------------------------------------------

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { ExamCardSidePeek } from './exam-card-side-peek'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Dialog as DialogPrimitive } from 'radix-ui'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const CARD_ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CARD_ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EXAM_ID = 'exam-peek-test'
const USER_ID = 'user-peek-test'
const CAT_ID = 'cat-peek-1'
const OPT_ID = 'tag-opt-peek-1'

function makeCard(id: string, overrides: Partial<ClientCard> = {}): ClientCard {
  return {
    id,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    title: 'テストタイトル',
    sort_key: 'A0001',
    question_text: '問題文テスト',
    options: [
      { id: 'opt-1', text: '選択肢1', is_correct: true, explanation: '説明1' },
      { id: 'opt-2', text: '選択肢2', is_correct: false },
    ],
    correct_answer_ids: ['opt-1'],
    explanation_text: '解説テスト',
    memo: 'メモテスト',
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: new Date().toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
    ...overrides,
  }
}

function makeRow(id: string, overrides: Partial<ClientCard> = {}): ExamCardRow {
  return {
    card: makeCard(id, overrides),
    tags: [],
  }
}

const CATEGORY: ClientTagCategory = {
  id: CAT_ID,
  user_id: USER_ID,
  name: 'カテゴリA',
  select_type: 'multi',
  color: null,
  sort_key: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const TAG_OPTION: ClientTagOption = {
  id: OPT_ID,
  user_id: USER_ID,
  category_id: CAT_ID,
  name: 'タグオプション1',
  color: null,
  sort_key: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const CARD_TAG: ClientCardTag = {
  card_id: CARD_ID_A,
  option_id: OPT_ID,
  user_id: USER_ID,
  created_at: '2026-01-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Default props helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<React.ComponentProps<typeof ExamCardSidePeek>> = {}) {
  return {
    row: makeRow(CARD_ID_A),
    cardTags: [CARD_TAG],
    categories: [CATEGORY],
    options: [TAG_OPTION],
    userId: USER_ID,
    onClose: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// ① row 有りで全フィールド表示
// ===========================================================================

describe('ExamCardSidePeek ①: row 有りで全フィールド表示', () => {
  it('sort_key が表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    expect(screen.getByText('A0001')).toBeInTheDocument()
  })

  it('title が表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    // タイトルは Dialog.Title(sr-only) と InlineTextField 表示 span の両方に出るため 2 以上
    const matches = screen.getAllByText('テストタイトル')
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('問題文が表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    expect(screen.getByText('問題文テスト')).toBeInTheDocument()
  })

  it('選択肢テキストが表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    expect(screen.getByText('選択肢1')).toBeInTheDocument()
    expect(screen.getByText('選択肢2')).toBeInTheDocument()
  })

  it('正解 checkbox が表示される(is_correct=true の選択肢)', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    const checkboxes = screen.getAllByRole('checkbox', { name: '選択肢 正解フラグ 編集' })
    expect(checkboxes.length).toBeGreaterThan(0)
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
  })

  it('タグ badge が表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    // CardTagBadge は `{category.name}: {option.name}` を表示
    expect(screen.getByText('カテゴリA: タグオプション1')).toBeInTheDocument()
  })

  it('解説が表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    expect(screen.getByText('解説テスト')).toBeInTheDocument()
  })

  it('メモが表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    expect(screen.getByText('メモテスト')).toBeInTheDocument()
  })
})

// ===========================================================================
// ② row=null で非描画
// ===========================================================================

describe('ExamCardSidePeek ②: row=null で非描画', () => {
  it('row=null のとき title / 問題文 / 選択肢が DOM に存在しない', () => {
    render(<ExamCardSidePeek {...defaultProps({ row: null })} />)
    expect(screen.queryByText('テストタイトル')).not.toBeInTheDocument()
    expect(screen.queryByText('問題文テスト')).not.toBeInTheDocument()
    expect(screen.queryByText('選択肢1')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ③ × click で onClose ちょうど 1 回(二重発火なし)
// ===========================================================================

describe('ExamCardSidePeek ③: × click で onClose ちょうど 1 回', () => {
  it('× button をクリックすると onClose がちょうど 1 回呼ばれる', () => {
    const onClose = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ onClose })} />)
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// ④ Esc keydown で onClose
// ===========================================================================

describe('ExamCardSidePeek ④: Esc keydown で onClose', () => {
  it('Esc を押すと onClose が呼ばれる', () => {
    const onClose = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ onClose })} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// ⑤ パネル外要素への pointer interaction で onClose が呼ばれない
// ===========================================================================

describe('ExamCardSidePeek ⑤: 外 pointer interaction で onClose が呼ばれない', () => {
  it('パネル外要素への pointerDown で onClose が呼ばれない', () => {
    const onClose = vi.fn()
    // 外部要素を含む wrapper でレンダリング
    const { container } = render(
      <div>
        <button type="button" data-testid="outside">外部ボタン</button>
        <ExamCardSidePeek {...defaultProps({ onClose })} />
      </div>,
    )
    const outside = container.querySelector('[data-testid="outside"]')!
    fireEvent.pointerDown(outside)
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// ⑥ DeleteCardButton(「削除」button)が存在しない
// ===========================================================================

describe('ExamCardSidePeek ⑥: DeleteCardButton が存在しない', () => {
  it('「削除」ボタン(DeleteCardButton の idle state button)が存在しない', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    // DeleteCardButton は text="削除" のボタンを描画する。
    // "タグ削除: ..." や "選択肢を削除" は別コンポーネントの正当なボタンなので、
    // exact match で「削除」テキストのみを持つ button が存在しないことを確認する。
    expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑦ row 差し替え(card.id 変化)で編集中 state がリセットされる(remount)
// ===========================================================================

describe('ExamCardSidePeek ⑦: card.id 変化で編集 state がリセット(remount)', () => {
  it('ソートキー編集モード中に別 card に切替えると textbox が消える', () => {
    const rowA = makeRow(CARD_ID_A)
    const rowB = makeRow(CARD_ID_B, { sort_key: 'B0001', title: 'タイトルB' })

    const { rerender } = render(<ExamCardSidePeek {...defaultProps({ row: rowA })} />)

    // sort_key フィールドを edit mode にする (値は変えない → dirty=false → unmount 時も Dexie 不要)
    const sortKeyBtn = screen.getByRole('button', { name: 'ソートキー 編集' })
    fireEvent.click(sortKeyBtn)
    // edit mode: textbox が存在する
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    // row を card B に切り替える → key 変化 → remount
    rerender(<ExamCardSidePeek {...defaultProps({ row: rowB })} />)

    // textbox が消える(edit state がリセットされた)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    // card B のタイトルが表示されている(Dialog.Title + InlineTextField span の両方に出るため 2 以上)
    expect(screen.getAllByText('タイトルB').length).toBeGreaterThanOrEqual(2)
  })
})

// ===========================================================================
// ⑧ 「+ 選択肢を追加」ボタンと選択肢削除ボタンが表示される(InlineOptionList 配線確認)
// ===========================================================================

describe('ExamCardSidePeek ⑧: InlineOptionList の add/delete ボタンが表示される', () => {
  it('「+ 選択肢を追加」ボタンが表示される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    expect(screen.getByRole('button', { name: '+ 選択肢を追加' })).toBeInTheDocument()
  })

  it('選択肢削除ボタンが表示される(aria-label="選択肢を削除")', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    // options が 2 件あるので canDelete=true → 削除ボタンが visible
    const deleteButtons = screen.getAllByRole('button', { name: '選択肢を削除' })
    expect(deleteButtons.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// ⑨ non-modal 実挙動: パネル open 中も外部要素が aria-hidden/inert にならず操作可能
// ===========================================================================

describe('ExamCardSidePeek ⑨: non-modal — 外部要素が aria-hidden/inert にならない', () => {
  it('パネル open 中も外部要素に aria-hidden が付かない', () => {
    const { container } = render(
      <div>
        <button type="button" data-testid="outer-btn">外部ボタン</button>
        <ExamCardSidePeek {...defaultProps()} />
      </div>,
    )
    const outerBtn = container.querySelector('[data-testid="outer-btn"]')!
    // modal=false なので radix は外部要素を aria-hidden にしない
    expect(outerBtn).not.toHaveAttribute('aria-hidden', 'true')
    expect(outerBtn).not.toHaveAttribute('inert')
  })

  it('パネル open 中も外部 button が role=button として accessible', () => {
    render(
      <div>
        <button type="button">アクセス可能ボタン</button>
        <ExamCardSidePeek {...defaultProps()} />
      </div>,
    )
    // radix non-modal: 外部 button は aria-hidden されず、 queryByRole で取れる
    expect(screen.getByRole('button', { name: 'アクセス可能ボタン' })).toBeInTheDocument()
  })
})

// ===========================================================================
// ⑩ Esc layering: Dialog 内 Popover の Esc が popover のみ閉じ onClose を呼ばない
// ===========================================================================

// 最小 harness: Dialog non-modal + Popover の組み合わせで radix DismissableLayer stack を検証。
// ExamCardSidePeek 本体に popover を追加する必要はない — 本番では CardTagsSection が内部で
// popover を使うが、 この test は独立した最小構成で Esc layering 挙動を回帰ガードする。
function EscLayeringHarness({ onClose }: { onClose: () => void }) {
  return (
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title>テストパネル</DialogPrimitive.Title>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button">ポップオーバーを開く</button>
            </PopoverTrigger>
            <PopoverContent>ポップオーバー内容</PopoverContent>
          </Popover>
          <DialogPrimitive.Close>閉じる</DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// ===========================================================================
// F1: Dialog.Content が flex flex-col、body wrapper が flex-1 min-h-0 overflow-y-auto
// ===========================================================================

describe('ExamCardSidePeek F1: スクロール制約 — flex layout クラス', () => {
  it('Dialog.Content に flex flex-col クラスが付与される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    const content = document.querySelector('[role="dialog"]')
    expect(content).toHaveClass('flex', 'flex-col')
  })

  it('body wrapper に flex-1 min-h-0 overflow-y-auto クラスが付与される', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    // body wrapper: Dialog.Content 直下で row コンテンツを囲む div
    const body = document.querySelector('.flex-1.min-h-0.overflow-y-auto')
    expect(body).toBeInTheDocument()
  })
})

// ===========================================================================
// F2: Esc close 時に option cell の blur が onClose より先に呼ばれる
// ===========================================================================

describe('ExamCardSidePeek F2: Esc close が option cell blur を commit 前に実行', () => {
  it('option cell 編集中の Esc で blur が onClose より先に呼ばれる', () => {
    const callOrder: string[] = []
    const onClose = vi.fn(() => { callOrder.push('close') })
    render(<ExamCardSidePeek {...defaultProps({ onClose })} />)

    // option cell(本文 = multiline textarea)を edit mode にする
    const [cellBtn] = screen.getAllByRole('button', { name: '選択肢 本文 編集' })
    fireEvent.click(cellBtn)

    // edit mode になると aria-label 付き textbox(textarea)が現れる
    const optionInput = screen.getByRole('textbox', { name: '選択肢 本文 編集' })
    optionInput.focus()

    // blur spy: 呼び出し順を記録(実 blur は発火しないが、順序検証が目的)
    const blurSpy = vi.spyOn(optionInput, 'blur').mockImplementation(() => {
      callOrder.push('blur')
    })

    // Esc: radix onOpenChange(false) → panel handler が blur → onClose の順に呼ぶ
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(blurSpy).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    // blur が onClose より先に来ることを保証
    expect(callOrder).toEqual(['blur', 'close'])
  })
})

// ===========================================================================
// ⑩ Esc layering: Dialog 内 Popover の Esc が popover のみ閉じ onClose を呼ばない
// ===========================================================================

describe('ExamCardSidePeek ⑩: Esc layering — Popover の Esc が peek を閉じない', () => {
  it('popover open 中の Esc は popover のみ閉じ onClose を呼ばない', () => {
    const onClose = vi.fn()
    render(<EscLayeringHarness onClose={onClose} />)

    // popover を開く
    fireEvent.click(screen.getByRole('button', { name: 'ポップオーバーを開く' }))
    expect(screen.getByText('ポップオーバー内容')).toBeInTheDocument()

    // Esc: radix DismissableLayer stack が最内層(popover)のみ消費する
    fireEvent.keyDown(document.body, { key: 'Escape' })

    // popover が閉じた
    expect(screen.queryByText('ポップオーバー内容')).not.toBeInTheDocument()
    // peek は閉じていない(onClose 未呼び出し)
    expect(onClose).not.toHaveBeenCalled()
  })
})
