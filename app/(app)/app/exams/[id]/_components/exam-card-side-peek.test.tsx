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
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

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
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10)。 本 test は画像 gallery の挙動を検証しないため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import {
  ExamCardSidePeek,
  computeDraggedPeekWidthVw,
  isExemptFromOutsideClose,
  OUTSIDE_CLICK_EXEMPT_SELECTORS,
  PEEK_WIDTH_KEYBOARD_STEP_VW,
} from './exam-card-side-peek'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { PEEK_WIDTH_MIN_VW, PEEK_WIDTH_MAX_VW } from '@/lib/sync/sync-meta'

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
    question_label: 'A0001',
    base_order: 1024,
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
    // UI fix C: widthVw/onWidthChange は required prop。 既定 40vw で全既存 test の視覚を不変に保つ。
    widthVw: 40,
    onWidthChange: vi.fn(),
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
// ⑤ UI fix D: パネル外要素への click で onClose が呼ばれる(反転)
//
// 旧実装は onInteractOutside 一律 preventDefault で外クリックでは閉じなかった。OT 指示で
// 反転: 既定は閉じる(例外は下記 UI fix D 節)。
//
// radix Dialog は非 modal でも deferPointerDownOutside=true 固定のため、実際の dismiss 判定は
// pointerdown 単体では走らず後続の click まで遅延する(node_modules 実装を読んで確認 — file 冒頭
// UI fix D 節参照)。 pointerDown だけでは何も起きない(旧 test の前提は誤りだった — 後続の
// tick() ヘルパー節で red 検証する)ため、実ブラウザの pointerdown→pointerup→click を模して
// 両方 fire する。 また radix 側の外側判定リスナーは mount 後 setTimeout(0) で非同期登録される
// ため、fire 前に 1 tick 待つ。
// ===========================================================================

/** radix DismissableLayer の pointerdown listener 登録(setTimeout(0))を待つ。 */
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ExamCardSidePeek ⑤: パネル外要素への click で onClose が呼ばれる(UI fix D)', () => {
  it('パネル外要素への pointerDown → click で onClose がちょうど 1 回呼ばれる', async () => {
    const onClose = vi.fn()
    // 外部要素を含む wrapper でレンダリング
    render(
      <div>
        <button type="button" data-testid="outside">外部ボタン</button>
        <ExamCardSidePeek {...defaultProps({ onClose })} />
      </div>,
    )
    await tick()

    const outside = screen.getByTestId('outside')
    fireEvent.pointerDown(outside, { button: 0 })
    fireEvent.click(outside)

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('pointerDown 単体(click なし)では onClose が呼ばれない(deferPointerDownOutside の遅延を実測 pin)', async () => {
    const onClose = vi.fn()
    render(
      <div>
        <button type="button" data-testid="outside">外部ボタン</button>
        <ExamCardSidePeek {...defaultProps({ onClose })} />
      </div>,
    )
    await tick()

    fireEvent.pointerDown(screen.getByTestId('outside'), { button: 0 })
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
  it('番号編集モード中に別 card に切替えると textbox が消える', () => {
    const rowA = makeRow(CARD_ID_A)
    const rowB = makeRow(CARD_ID_B, { question_label: 'B0001', title: 'タイトルB' })

    const { rerender } = render(<ExamCardSidePeek {...defaultProps({ row: rowA })} />)

    // sort_key フィールドを edit mode にする (値は変えない → dirty=false → unmount 時も Dexie 不要)
    const questionLabelBtn = screen.getByRole('button', { name: '番号 編集' })
    fireEvent.click(questionLabelBtn)
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

// ===========================================================================
// UI fix C: computeDraggedPeekWidthVw — pure 関数 unit test
// ===========================================================================

describe('computeDraggedPeekWidthVw', () => {
  it('左へ引く(deltaPx 正)ほど幅が増える', () => {
    // 1000px viewport で 100px 左へ引く → +10vw
    expect(computeDraggedPeekWidthVw(40, 100, 1000)).toBe(50)
  })

  it('右へ押す(deltaPx 負)ほど幅が減る', () => {
    expect(computeDraggedPeekWidthVw(40, -100, 1000)).toBe(30)
  })

  it('25vw 未満になる delta は 25 にクランプする', () => {
    expect(computeDraggedPeekWidthVw(40, -500, 1000)).toBe(PEEK_WIDTH_MIN_VW)
  })

  it('70vw を超える delta は 70 にクランプする', () => {
    expect(computeDraggedPeekWidthVw(40, 500, 1000)).toBe(PEEK_WIDTH_MAX_VW)
  })

  it('viewportWidthPx<=0(異常値)は startWidthVw をそのまま返す(クランプのみ適用)', () => {
    expect(computeDraggedPeekWidthVw(40, 100, 0)).toBe(40)
    expect(computeDraggedPeekWidthVw(10, 100, 0)).toBe(PEEK_WIDTH_MIN_VW)
  })
})

// ===========================================================================
// UI fix C: リサイズ handle — モバイル不壊 / aria / ドラッグ / 矢印キー
// ===========================================================================

/** Dialog.Content(role=dialog)直下の resize handle(role=separator)を取得する。 */
function resizeHandle(): HTMLElement {
  return screen.getByRole('separator', { name: 'パネル幅を変更' })
}

describe('ExamCardSidePeek UI fix C: モバイル不壊 — handle が hidden md:block(class ベース)', () => {
  // fix round 1 (⑥): toContain の部分一致は 'md:hidden' のような class でも通ってしまう
  // (誤検出を防げない)。toHaveClass の完全一致トークンで固定する。
  // 本 test の保証範囲: handle の class token に 'hidden'/'md:block' が付与されていることまで。
  // 実際に <md で非表示になる(display:none が効く)ことの担保は Tailwind の生成 CSS 側の責務で
  // あり、本 test はそれを検証しない(jsdom はメディアクエリを評価しないため検証不可能)。
  it('handle は既定で hidden(モバイル非表示)、md:block を持つ(誤タッチ防止をクラスで構造的に担保)', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    const handle = resizeHandle()
    expect(handle).toHaveClass('hidden', 'md:block')
  })
})

describe('ExamCardSidePeek UI fix C fix round 1 (①): open 直後の初期 focus が「閉じる」に戻る', () => {
  // radix FocusScope の mount autofocus は DOM 順で最初の tabbable 候補へ移る。 resize handle
  // (tabIndex=0)が Dialog.Content の先頭子だった旧実装では open 直後の focus が handle に奪われる
  // regression があった。 handle を最後の子に移した(実装側)ことで「閉じる」が最初の tabbable
  // 候補に戻ることを pin する(この保証は fix round 1 以前は誰も持っていなかった)。
  it('peek open 直後の document.activeElement は「閉じる」ボタンである(handle に focus が奪われない)', () => {
    render(<ExamCardSidePeek {...defaultProps()} />)
    const closeButton = screen.getByRole('button', { name: '閉じる' })
    expect(document.activeElement).toBe(closeButton)
  })
})

describe('ExamCardSidePeek UI fix C: handle の aria 属性', () => {
  it('role=separator + aria-orientation=vertical + aria-valuenow/min/max が widthVw を反映する', () => {
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 45 })} />)
    const handle = resizeHandle()
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', '45')
    expect(handle).toHaveAttribute('aria-valuemin', String(PEEK_WIDTH_MIN_VW))
    expect(handle).toHaveAttribute('aria-valuemax', String(PEEK_WIDTH_MAX_VW))
  })
})

describe('ExamCardSidePeek UI fix C: panel 幅は widthVw prop を CSS 変数として反映する', () => {
  it('Dialog.Content の --peek-width-vw が widthVw に一致する', () => {
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 52 })} />)
    const content = document.querySelector('[role="dialog"]') as HTMLElement
    expect(content.style.getPropertyValue('--peek-width-vw')).toBe('52vw')
  })
})

describe('ExamCardSidePeek UI fix C: ドラッグ — pointerup で 1 回だけ確定値を通知', () => {
  // window.innerWidth を固定値に stub する(vi.stubGlobal は S2b-1 の requestAnimationFrame stub
  // と同じ既存 pattern。 afterEach で必ず戻す — 他 test への漏洩防止)。
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pointerdown → pointermove(複数回)→ pointerup で onWidthChange が最終値で 1 回だけ呼ばれる', () => {
    const onWidthChange = vi.fn()
    vi.stubGlobal('innerWidth', 1000)
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    // 中間値: onWidthChange はまだ呼ばれない(commit は pointerup のみ)
    fireEvent.pointerMove(window, { clientX: 450 }) // 左へ 50px → +5vw (45)
    expect(onWidthChange).not.toHaveBeenCalled()

    fireEvent.pointerMove(window, { clientX: 400 }) // 左へ 100px → +10vw (50)
    expect(onWidthChange).not.toHaveBeenCalled()

    fireEvent.pointerUp(window, { clientX: 400 })
    expect(onWidthChange).toHaveBeenCalledTimes(1)
    expect(onWidthChange).toHaveBeenCalledWith(50)
  })

  // fix round 1 (⑤): pointerdown 直後に handle 自身へ focus が移ることで、ドラッグ直後に
  // 矢印キーで微調整できる(Tab で辿り直す必要がない)。
  it('pointerdown で handle 自身に focus が移る(ドラッグ直後に矢印キー微調整できる)', () => {
    const onWidthChange = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    expect(document.activeElement).toBe(handle)

    fireEvent.pointerUp(window, { clientX: 500 })
  })

  it('ドラッグで 70vw を超えても onWidthChange は 70 にクランプされた値で呼ばれる', () => {
    const onWidthChange = vi.fn()
    vi.stubGlobal('innerWidth', 1000)
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: -200 }) // 左へ 700px → +70vw (110 → clamp)
    fireEvent.pointerUp(window, { clientX: -200 })

    expect(onWidthChange).toHaveBeenCalledWith(PEEK_WIDTH_MAX_VW)
  })

  it('右ボタン(button!==0)の pointerdown はドラッグを開始しない', () => {
    const onWidthChange = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 2, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 300 })
    fireEvent.pointerUp(window, { clientX: 300 })

    expect(onWidthChange).not.toHaveBeenCalled()
  })

  // fix round 1 (③): OS ジェスチャ中断等で pointercancel が来た場合。
  it('pointercancel は中断として扱われ onWidthChange を呼ばない、listener も外れる', () => {
    const onWidthChange = vi.fn()
    vi.stubGlobal('innerWidth', 1000)
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 400 }) // 委細確定していれば 50 になる量
    fireEvent.pointerCancel(window)

    expect(onWidthChange).not.toHaveBeenCalled()

    // listener が実際に外れていること(cancel 後の pointerup が二次発火しない)を合わせて確認。
    fireEvent.pointerUp(window, { clientX: 400 })
    expect(onWidthChange).not.toHaveBeenCalled()
  })

  // fix round 1 (③): ドラッグ中に peek が閉じる(unmount)場合、window listener が残留しない
  // ことを固定する。 残留すると、無関係な後続の pointerup(unmount 後の別操作等)まで
  // onWidthChange を誤発火させ得る。
  it('drag 中に unmount しても window listener が外れる(unmount 後の pointerup は無反応)', () => {
    const onWidthChange = vi.fn()
    vi.stubGlobal('innerWidth', 1000)
    const { unmount } = render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 400 })

    unmount()

    fireEvent.pointerUp(window, { clientX: 400 })
    expect(onWidthChange).not.toHaveBeenCalled()
  })
})

describe('ExamCardSidePeek UI fix C: 矢印キー — 1 打鍵 = 1 確定', () => {
  it('ArrowLeft で幅が PEEK_WIDTH_KEYBOARD_STEP_VW だけ増える(確定 = onWidthChange 即時呼出)', () => {
    const onWidthChange = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenCalledTimes(1)
    expect(onWidthChange).toHaveBeenCalledWith(40 + PEEK_WIDTH_KEYBOARD_STEP_VW)
  })

  it('ArrowRight で幅が PEEK_WIDTH_KEYBOARD_STEP_VW だけ減る', () => {
    const onWidthChange = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenCalledTimes(1)
    expect(onWidthChange).toHaveBeenCalledWith(40 - PEEK_WIDTH_KEYBOARD_STEP_VW)
  })

  it('境界付近の ArrowLeft は 70 にクランプされる(70 を超えない)', () => {
    const onWidthChange = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 68, onWidthChange })} />)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenCalledWith(PEEK_WIDTH_MAX_VW)
  })

  it('矢印キー以外(Enter 等)は onWidthChange を呼ばない', () => {
    const onWidthChange = vi.fn()
    render(<ExamCardSidePeek {...defaultProps({ widthVw: 40, onWidthChange })} />)
    fireEvent.keyDown(resizeHandle(), { key: 'Enter' })
    expect(onWidthChange).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// UI fix C fix round 1 (②): setState updater 内で親の setState を呼ばない
//
// 実 owner(exam-detail-view.tsx)は widthVw/onWidthChange の owner として実際に state を
// 持つ別 component。 ここでは同型の最小 owner(ParentOwner)を用意し、
// React.StrictMode 下でドラッグを行う。 旧実装(setLiveDragWidthVw の updater 内で
// onWidthChange = 親 setState を呼ぶ)は StrictMode の updater 二重呼出しにより
// 「Cannot update a component (ParentOwner) while rendering a different component
// (ExamCardSidePeek)」の console.error を実際に誘発することを事前に確認済み(修正前のコードで
// 再現 → 修正後のコードで消失、を手元で個別に確認した— 恒久 test 化)。
// ===========================================================================

function ParentOwner() {
  const [w, setW] = React.useState(40)
  return (
    <div>
      <span data-testid="peek-owner-width">{w}</span>
      <ExamCardSidePeek {...defaultProps({ widthVw: w, onWidthChange: setW })} />
    </div>
  )
}

describe('ExamCardSidePeek UI fix C fix round 1 (②): StrictMode ドラッグで setState-in-render 警告が出ない', () => {
  it('StrictMode 下でドラッグしても console.error が呼ばれない(setState-in-render 警告なし)', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })

    render(
      <React.StrictMode>
        <ParentOwner />
      </React.StrictMode>,
    )
    const handle = resizeHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 450 })
    fireEvent.pointerUp(window, { clientX: 450 })

    spy.mockRestore()

    const setStateInRenderErrors = errors.filter((e) => e.includes('Cannot update a component'))
    expect(setStateInRenderErrors).toEqual([])
    // 実際に幅は反映されている(警告回避のために書込自体を握り潰していないことも確認)。
    expect(screen.getByTestId('peek-owner-width').textContent).not.toBe('40')
  })
})

// ===========================================================================
// UI fix D: isExemptFromOutsideClose(pure 関数)— jsdom で直接 unit test
//
// fix round 1(review 指摘)は「grip trigger / 行メニュー項目 / PullIntoDialog panel・backdrop は
// 自前で stopPropagation するため radix の interception tracking により dispatch 自体が起きず、
// marker 判定に到達しない」と判断してこれらの marker test を削除したが、これは**本番では偽の
// 前提**だった(fix round 2 で判明・実装側 doc comment「前提訂正」節参照)。 前提が誤りだった
// 核心 = Next App Router では React root = document で、Radix の DismissableLayer も document に
// listener を張るため、**自前 stopPropagation は同一 node(document)上の listener を止められない**
// (stopPropagation は祖先ノードへの伝播だけを止める。 RTL は render root が document ではない
// 一時 div のため、その node で stopPropagation が実際に祖先=document への伝播を止めてしまい、
// テスト環境でだけ「到達しない」ように見えていた)。
//
// この教訓を反映し、本 pin は **jsdom の click 伝播シミュレーションに依存しない** 形にする:
// isExemptFromOutsideClose は純粋な DOM marker 判定関数なので、jsdom で合成要素に marker を
// 付けて `target.closest()` の結果を確認するだけで、production の topology に関わらず成立する
// (「document へ届くか」を模す必要が一切ない)。 marker 一覧は OUTSIDE_CLICK_EXEMPT_SELECTORS
// (実装側で export)と 1:1 対応させ、増減した場合はこの test の件数 pin が diff を可視化する。
describe('isExemptFromOutsideClose', () => {
  it('target が null なら false', () => {
    expect(isExemptFromOutsideClose(null)).toBe(false)
  })

  it('target が Element でない(Document 等)なら false', () => {
    expect(isExemptFromOutsideClose(document)).toBe(false)
  })

  it('いずれの marker も持たない要素は false(通常のテーブルセル等)', () => {
    const cell = document.createElement('button')
    expect(isExemptFromOutsideClose(cell)).toBe(false)
  })

  it('[data-slot="popover-content"] の子孫は true(grip menu 本体)', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-slot', 'popover-content')
    const child = document.createElement('button')
    wrapper.appendChild(child)
    expect(isExemptFromOutsideClose(child)).toBe(true)
  })

  it('[data-outside-close-exempt="grip-trigger"] の子孫は true(二役グリップ button)', () => {
    const grip = document.createElement('button')
    grip.setAttribute('data-outside-close-exempt', 'grip-trigger')
    // svg は HTML namespace の createElement では HTMLUnknownElement になる(実 DOM と乖離)。
    // GripVertical(lucide-react)は実 SVGElement のため createElementNS で正しい namespace にする。
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    grip.appendChild(icon)
    expect(isExemptFromOutsideClose(icon)).toBe(true)
  })

  it('[data-outside-close-exempt="pull-into-panel"] の子孫は true(PullIntoDialog panel)', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-outside-close-exempt', 'pull-into-panel')
    const child = document.createElement('h2')
    panel.appendChild(child)
    expect(isExemptFromOutsideClose(child)).toBe(true)
  })

  it('[data-outside-close-exempt="pull-into-backdrop"] の子孫は true(PullIntoDialog backdrop)', () => {
    const backdrop = document.createElement('div')
    backdrop.setAttribute('data-outside-close-exempt', 'pull-into-backdrop')
    expect(isExemptFromOutsideClose(backdrop)).toBe(true)
  })

  // UI fix F: marker の付与先を checkbox の <input> 自身から select td 全体へ広げた(意図の単位
  // =「行を選択する操作」/ 余白 click と checkbox 直撃とで挙動が割れないため)。 本 test は
  // marker が td 側にある前提で、td 配下の複数種の子孫(checkbox・grip・td/th 内の余白相当の
  // 要素)いずれからも true が返ることを pin する — marker を input 単体に戻す変異(td から
  // 剥がして input にだけ付け直す)をすると、input の兄弟である余白相当要素の判定が false に
  // 落ちて red になる。
  it('[data-outside-close-exempt="row-select"] の子孫は true(select td 配下の checkbox / grip / 余白相当のいずれも)', () => {
    const td = document.createElement('td')
    td.setAttribute('data-outside-close-exempt', 'row-select')
    const grip = document.createElement('button') // 二役グリップ相当
    const checkbox = document.createElement('input')
    const padding = document.createElement('span') // grip と checkbox の間の余白相当(td 直下の非 focusable 領域)
    td.append(grip, checkbox, padding)
    expect(isExemptFromOutsideClose(grip)).toBe(true)
    expect(isExemptFromOutsideClose(checkbox)).toBe(true)
    expect(isExemptFromOutsideClose(padding)).toBe(true)
  })

  it('[data-outside-close-exempt="row-select-all"] の子孫は true(select th 配下の checkbox / spacer 余白のいずれも)', () => {
    const th = document.createElement('th')
    th.setAttribute('data-outside-close-exempt', 'row-select-all')
    const spacer = document.createElement('span') // グリップ幅を揃える spacer(exam-card-table-columns.tsx)
    const checkbox = document.createElement('input')
    th.append(spacer, checkbox)
    expect(isExemptFromOutsideClose(spacer)).toBe(true)
    expect(isExemptFromOutsideClose(checkbox)).toBe(true)
  })

  it('[data-outside-close-exempt="image-zoom"] の子孫は true(PhotoSwipe lightbox root)', () => {
    // PhotoSwipe の DOM は document.body へ imperative に append される(createPortal ではない)
    // ため、このページで唯一 React tree の外にある overlay(use-image-zoom.ts 参照)。
    const pswpRoot = document.createElement('div')
    pswpRoot.setAttribute('data-outside-close-exempt', 'image-zoom')
    const closeBtn = document.createElement('button')
    pswpRoot.appendChild(closeBtn)
    expect(isExemptFromOutsideClose(closeBtn)).toBe(true)
  })

  it('data-outside-close-exempt の未登録値は false(値ベースの selector — 属性の存在だけでは exempt にならない)', () => {
    // OUTSIDE_CLICK_EXEMPT_SELECTORS の各エントリは `[data-outside-close-exempt="<値>"]` という
    // 値付き selector であり `[data-outside-close-exempt]`(存在のみ)ではない。 したがって
    // 登録済み以外の任意の値は自動的には exempt にならない(fail-closed)。 これを取り違えて
    // 「marker 属性さえ付ければ除外される」と誤解し未登録の値(例: 将来 action bar に
    // 安易に同名 marker を付けた場合)を使うと、除外されないのに気づけない regression になる
    // ため、明示的に false を pin する。
    const el = document.createElement('div')
    el.setAttribute('data-outside-close-exempt', 'unregistered-value')
    expect(isExemptFromOutsideClose(el)).toBe(false)
  })
})

// ===========================================================================
// UI fix D: OUTSIDE_CLICK_EXEMPT_SELECTORS の網羅 pin — 過不足なく 7 件
//
// marker を足す/減らす変更をすると、この件数 assert が diff として可視化され、上記
// isExemptFromOutsideClose test 群や実 component 側の marker 付与漏れに気付ける。
// ===========================================================================

describe('OUTSIDE_CLICK_EXEMPT_SELECTORS: 除外 selector が過不足なく 7 件', () => {
  it('7 件(popover-content / grip-trigger / pull-into-panel / pull-into-backdrop / row-select / row-select-all / image-zoom)', () => {
    expect(OUTSIDE_CLICK_EXEMPT_SELECTORS).toHaveLength(7)
    expect(OUTSIDE_CLICK_EXEMPT_SELECTORS).toEqual([
      '[data-slot="popover-content"]',
      '[data-outside-close-exempt="grip-trigger"]',
      '[data-outside-close-exempt="pull-into-panel"]',
      '[data-outside-close-exempt="pull-into-backdrop"]',
      '[data-outside-close-exempt="row-select"]',
      '[data-outside-close-exempt="row-select-all"]',
      '[data-outside-close-exempt="image-zoom"]',
    ])
  })
})

// ===========================================================================
// UI fix D: [data-slot="popover-content"] 内の click(自前 onClick を持たない領域)は
// onClose を呼ばない(OUTSIDE_CLICK_EXEMPT_SELECTORS の 1 件 — 実装側 doc comment 参照)。
//
// grip menu(Popover)は ExamCardSidePeek 本体の外(兄弟 row cell から portal される別 DOM
// 部分木)のため、component 単体 test では実物を mount せず、同じ DOM marker を持つ最小要素で
// 代替する(⑤ の「外部ボタン」パターンと同型)。 対象要素(menu-content-area)は自前 onClick を
// 持たないため、click は topology に関わらず自然に document まで伝播する(stopPropagation の
// 有無に依存しない、topology 非依存な pin)。 実 Popover 配線での統合 test は
// exam-card-table.test.tsx 側(実 grip 経由で menu を開き、marker が効いていることを pin)。
// ===========================================================================

describe('ExamCardSidePeek UI fix D: [data-slot="popover-content"] 内の click は onClose を呼ばない', () => {
  it('[data-slot="popover-content"] 内の click では onClose が呼ばれない(padding 等・自前 onClick を持たない領域が対象。実 menu 項目 button も同じ [data-slot="popover-content"] marker の子孫として exempt になるが、項目 button 自身の onClick は setMenuOpen(false) 等の副作用を持つため、ここでは副作用の無い合成領域だけを対象に marker 判定を切り出して pin する)', async () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-slot="popover-content">
          <button type="button" data-testid="menu-content-area">padding 相当(stopPropagation なし)</button>
        </div>
        <ExamCardSidePeek {...defaultProps({ onClose })} />
      </div>,
    )
    await tick()

    const menuContentArea = screen.getByTestId('menu-content-area')
    fireEvent.pointerDown(menuContentArea, { button: 0 })
    fireEvent.click(menuContentArea)

    expect(onClose).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// UI fix D: focus outside(Tab 等)では閉じない — onPointerDownOutside とは独立に
// onFocusOutside は常に preventDefault する。
// ===========================================================================

describe('ExamCardSidePeek UI fix D: focus outside では閉じない(onFocusOutside 常時 preventDefault)', () => {
  it('パネル外要素へ focus が移っても onClose は呼ばれない(Tab でテーブルへ移動する想定)', async () => {
    const onClose = vi.fn()
    render(
      <div>
        <button type="button" data-testid="outside-focus-target">外部フォーカス先</button>
        <ExamCardSidePeek {...defaultProps({ onClose })} />
      </div>,
    )
    await tick()

    const target = screen.getByTestId('outside-focus-target')
    act(() => {
      target.focus()
    })

    expect(document.activeElement).toBe(target)
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// UI fix D: 両立 — 外側クリックで peek が閉じても、そのクリック本来の動作は実行される
//
// onPointerDownOutside の preventDefault/非 preventDefault は radix の合成 CustomEvent に対して
// 行うものであり、元の DOM click イベントや React 側の onClick には触れない(stopPropagation も
// preventDefault もしていない)ため、外部要素自身の click ハンドラは通常どおり発火する。
// exam-card-table.test.tsx の T3 ⑨ で実テーブルセルの統合 test を持つため、ここでは component
// 単体でこの契約(peek 側の処理が外部の click を握り潰さない)を pin する。checkbox 側は
// isExemptFromOutsideClose の判定と checkbox 自身の onChange が完全に独立した経路(前者は
// Radix の onPointerDownOutside callback 内、後者は React の通常 onChange)なので、統合 test
// 無しでも構造的に両立する(T3 ⑦ 撤去の経緯は exam-card-table.test.tsx 側の comment 参照)。
// ===========================================================================

describe('ExamCardSidePeek UI fix D: 両立 — 外側クリックで peek が閉じても外部要素自身の click は実行される', () => {
  it('外部要素の click で peek の onClose と要素自身の onClick が両方発火する', async () => {
    const onClose = vi.fn()
    const outsideOnClick = vi.fn()
    render(
      <div>
        <button type="button" data-testid="outside-actionable" onClick={outsideOnClick}>
          外部アクション
        </button>
        <ExamCardSidePeek {...defaultProps({ onClose })} />
      </div>,
    )
    await tick()

    const target = screen.getByTestId('outside-actionable')
    fireEvent.pointerDown(target, { button: 0 })
    fireEvent.click(target)

    expect(outsideOnClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
