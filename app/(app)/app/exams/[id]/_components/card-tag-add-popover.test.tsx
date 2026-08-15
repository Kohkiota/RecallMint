// @vitest-environment jsdom
// CardTagAddPopover: 2 stage popover (カテゴリ選択 → option 選択) の各シナリオを
// pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 4 にて新規追加された追加用 popover component のテスト。
// Tag-4c-1 Task 3: stage 拡張 (editCategory / editOption) + kebab + Esc 階層テスト追加。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { TagEditCallbacks } from '@/lib/tags/tag-crud'

// Tag-4c-2c hotfix H5: PopoverContent に渡された props を直接 assert したい
// (collisionPadding / sideOffset / avoidCollisions は Radix 内部 positioning に消費され
// DOM 属性化されないため)。 vi.hoisted で spy 受け皿を確保し、 vi.mock では
// importActual で実 Popover module を取り寄せ PopoverContent のみ wrap する。
// wrap は props を spy へ流した後、 そのまま実 PopoverContent を render するので
// 既存 popover test (data-slot 検索 / role 系) は影響を受けない。
const { popoverContentPropsSpy } = vi.hoisted(() => {
  return { popoverContentPropsSpy: vi.fn() }
})

vi.mock('@/components/ui/popover', async (importActual) => {
  const actual =
    await importActual<typeof import('@/components/ui/popover')>()
  const RealPopoverContent = actual.PopoverContent
  function PopoverContentSpy(
    props: React.ComponentProps<typeof RealPopoverContent>,
  ) {
    popoverContentPropsSpy(props)
    return <RealPopoverContent {...props} />
  }
  return { ...actual, PopoverContent: PopoverContentSpy }
})

import * as React from 'react'
import { CardTagAddPopover } from './card-tag-add-popover'
import { SORTABLE_SR_INSTRUCTIONS } from '@/lib/dnd/accessibility'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const cat = (
  id: string,
  name: string,
  select_type: 'single' | 'multi' = 'multi',
  created_at = '2026-06-07T00:00:00.000Z',
  overrides?: Partial<ClientTagCategory>,
): ClientTagCategory => ({
  id,
  user_id: 'user-1',
  name,
  select_type,
  color: null,
  sort_key: null,
  created_at,
  updated_at: '2026-06-07T00:00:00.000Z',
  ...overrides,
})

const opt = (
  id: string,
  name: string,
  category_id: string,
  overrides?: Partial<ClientTagOption>,
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id,
  name,
  color: null,
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
  ...overrides,
})

const CATEGORIES = [
  cat('cat-1', '分野', 'multi', '2026-06-07T01:00:00.000Z'),
  cat('cat-2', 'レベル', 'single', '2026-06-07T02:00:00.000Z'),
]

const OPTIONS = [
  opt('o1', '循環器', 'cat-1'),
  opt('o2', '腎臓', 'cat-1'),
  opt('o3', '初級', 'cat-2'),
  opt('o4', '上級', 'cat-2'),
]

// ---------------------------------------------------------------------------
// tagEditCallbacks mock (shared across all tests)
// ---------------------------------------------------------------------------

const mockTagEditCallbacks: TagEditCallbacks = {
  renameCategory: vi.fn(async () => undefined),
  setCategoryColor: vi.fn(async () => undefined),
  deleteCategory: vi.fn(async () => undefined),
  renameOption: vi.fn(async () => undefined),
  setOptionColor: vi.fn(async () => undefined),
  deleteOption: vi.fn(async () => undefined),
  countCategoryImpact: vi.fn(async () => ({ optionCount: 0, cardCount: 0 })),
  countOptionImpact: vi.fn(async () => ({ cardCount: 0 })),
  // Tag-4c-2a: 既存 popover の挙動には未関与 (Task 3/4 で配線)。 型整合のため stub。
  createCategory: vi.fn(async () => ({ id: 'stub' })),
  createOptionAndAssign: vi.fn(async () => undefined),
  // Tag-4c-2b T7 M-C: reorder callback は TagEditCallbacks 型から drop され、 popover の
  // standalone props (onReorderCategories / onReorderOptions) 1 経路に集約された。
}

// ---------------------------------------------------------------------------
// 1. trigger button の aria-label と描画内容
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — trigger button', () => {
  it('aria-label="タグを追加" を持つ button が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'タグを追加' }),
    ).toBeInTheDocument()
  })

  it('Fix B-1: trigger button の visible text は「タグ」 (aria-label は「タグを追加」 を維持)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    // visible text は「タグ」に変更 (aria-label は「タグを追加」のまま)
    expect(screen.getByText('タグ')).toBeInTheDocument()
    expect(screen.queryByText('タグを追加')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 2. 初期状態: popover 閉じている
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — 初期状態', () => {
  it('初期状態で popover が閉じており、 カテゴリリストは表示されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    // stage 1 のカテゴリ名は popover 内にのみ存在する
    expect(screen.queryByRole('menuitem', { name: '分野' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 3. trigger click → stage 1 (カテゴリリスト) が表示される
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 (カテゴリ一覧)', () => {
  it('trigger click で popover が開き、 全カテゴリが列挙される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'レベル' }),
    ).toBeInTheDocument()
  })

  it('カテゴリが created_at ASC で並ぶ (古い方が先)', () => {
    // cat-early が先、 cat-late が後になるよう逆順 props で渡す
    const catEarly = cat('cat-e', '先カテゴリ', 'multi', '2026-01-01T00:00:00.000Z')
    const catLate = cat('cat-l', '後カテゴリ', 'single', '2026-12-31T00:00:00.000Z')
    render(
      <CardTagAddPopover
        categories={[catLate, catEarly]}  // 意図的に逆順
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    const items = screen.getAllByRole('menuitem')
    const names = items.map((el) => el.getAttribute('aria-label'))
    expect(names[0]).toBe('先カテゴリ')
    expect(names[1]).toBe('後カテゴリ')
  })
})

// ---------------------------------------------------------------------------
// 4. stage 1: 型アイコン — Tag-4c-2a-fix Task 2 で削除
// Notion 方式 combobox 化に伴い、 stage1 では型アイコン (CheckSquare/Circle) を
// 表示しない設計に変更 (色 pill のみ表示)。 該当テストブロックを削除。
// 型情報は stage2 (option list) 進入後の category 文脈で identify する設計。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. stage 1: カテゴリ 0 件 → placeholder + /app/tags link
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 カテゴリ 0 件', () => {
  // Tag-4c-2a-fix Task 2: 0 件 placeholder の文言を Notion 方式 combobox の
  // emptyPlaceholderText に統合。 旧「+ カテゴリを追加」 row は削除し、 combobox 入力
  // 経由 (「新規作成: {name}」 row) を唯一の動線に変更。
  it('カテゴリ 0 件のとき新 placeholder 文言が表示される', () => {
    render(
      <CardTagAddPopover
        categories={[]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByText('タグ名を入力し新規作成'),
    ).toBeInTheDocument()
  })

  it('カテゴリ 0 件のとき placeholder 内に「タグ管理 →」 link は存在しない', () => {
    render(
      <CardTagAddPopover
        categories={[]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })

  it('Tag-4c-2a-fix Task 2: 旧「+ カテゴリを追加」 row は削除されている', () => {
    render(
      <CardTagAddPopover
        categories={[]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // 旧 row は DOM に存在しない
    expect(screen.queryByText('+ カテゴリを追加')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '+ カテゴリを追加' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 5b. Tag-4c-2a-fix-2 Task 2: stage 1 category combobox の完全一致抑制 (UI only)
//     `suppressCreateOnExactMatch` を default (true) に戻したため、 既存 category 名と
//     完全一致する入力時は「新規作成」 行を出さない (option と同じ挙動)。
//     部分一致 / 空入力時の挙動は不変 (regression)。
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 category combobox 完全一致抑制 (Tag-4c-2a-fix-2 Task 2)', () => {
  it('完全一致 category 名 (既存「分野」 に "分野" 入力) → 新規作成行が出ない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '分野' } },
    )
    // 既存 category 「分野」 は menuitem として表示される
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    // 完全一致のため「新規作成: 分野」 行は出ない
    expect(
      screen.queryByRole('button', { name: '新規作成: 分野' }),
    ).not.toBeInTheDocument()
  })

  it('部分一致 (既存「分野」 に "分" 入力) → 既存「分野」 + 「新規作成: 分」 行が出る (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '分' } },
    )
    // 既存 「分野」 は部分一致でヒット
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    // 「分」 自体は完全一致ではないため 新規作成行が表示される
    expect(
      screen.getByRole('button', { name: '新規作成: 分' }),
    ).toBeInTheDocument()
  })

  it('空入力 → 既存 category 全表示 + 新規作成行は非表示 (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // 空入力時は既存 category が全件 menuitem として表示される
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'レベル' })).toBeInTheDocument()
    // 新規作成行は出ない (空入力時は createRow 非表示の既存仕様)
    expect(
      screen.queryByRole('button', { name: /新規作成:/ }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 6. stage 1 → stage 2: カテゴリ click で option 一覧に遷移
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 → stage 2', () => {
  it('カテゴリ row を click すると「カテゴリ選択へ戻る」 button が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()
  })

  it('stage 2 で選択したカテゴリの option だけが表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // 「分野」 カテゴリを選択 → cat-1 の options (o1, o2) のみ
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '腎臓' })).toBeInTheDocument()
    // cat-2 の options は表示されない
    expect(screen.queryByRole('menuitemradio', { name: '初級' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 7. stage 2: 「カテゴリ選択へ戻る」 click → stage 1 に戻る
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 → stage 1 戻る', () => {
  it('「カテゴリ選択へ戻る」 click で stage 1 (カテゴリリスト) に戻る', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // 戻る
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    // カテゴリリストが再表示される
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 8. stage 2: Esc → stage 1 に戻る (popover は閉じない)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 Esc 挙動', () => {
  it('stage 2 で Esc を押すと stage 1 に戻り popover は閉じない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // stage 2 の Esc → onEscapeKeyDown が e.preventDefault() して stage に戻す
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body, {
      key: 'Escape',
    })
    // stage 1 に戻っている → カテゴリリストが見える
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 9. stage 1: Esc → popover が閉じる (標準 shadcn 動作)
//    ※ radix Esc は document レベルでキャプチャされる。
//    jsdom では PopoverContent の data-state="open" 属性が消えることで確認。
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 Esc 挙動', () => {
  it('stage 1 で Esc を押すと popover が閉じる', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // popover が開いていることを確認
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
    // stage 1 Esc → shadcn が popover を閉じる
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // popover が閉じる → カテゴリリストが消える
    expect(
      screen.queryByRole('menuitem', { name: '分野' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 10. popover close 後に再 open → stage がリセットされる
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — close 後 reopen でリセット', () => {
  it('stage 2 から close した後、 再 open で stage 1 から始まる', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    // open → stage 2 へ進む
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()

    // Esc で close (stage 2 の Esc は stage 1 に戻るだけなので、 stage 1 に戻してから close)
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(
      screen.queryByRole('menuitem', { name: '分野' }),
    ).not.toBeInTheDocument()

    // 再 open → stage 1 から
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 11. stage 2: CardTagOptionList が選択カテゴリの options を受け取る
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 option フィルタ', () => {
  it('allAssignedOptionIds のうち当該カテゴリ分のみが選択済みとして反映される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={['o1', 'o3']}  // o1 は cat-1、 o3 は cat-2
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // cat-1 (分野) を選択
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // o1 が check 済み、 o2 は未選択
    expect(screen.getByTestId('check-o1')).toBeInTheDocument()
    expect(screen.queryByTestId('check-o2')).not.toBeInTheDocument()
    // cat-2 の o3 は表示されていない
    expect(screen.queryByTestId('check-o3')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 12. stage 2 single: option click → onToggle(categoryId, optionId) + popover 閉じる
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 single 動作', () => {
  it('single: option click で onToggle(catId, optId) が呼ばれ popover が閉じる', () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddPopover
        categories={[cat('cat-2', 'レベル', 'single')]}
        options={[opt('o3', '初級', 'cat-2'), opt('o4', '上級', 'cat-2')]}
        allAssignedOptionIds={[]}
        onToggle={onToggle}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'レベル' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '初級' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('cat-2', 'o3')
    // single → popover が閉じる → stage 1 要素が消える
    expect(
      screen.queryByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 13. stage 2 multi: option click → onToggle 呼ばれ popover は開いたまま
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 multi 動作', () => {
  it('multi: option click で onToggle(catId, optId) が呼ばれ stage 2 が続く', () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddPopover
        categories={[cat('cat-1', '分野', 'multi')]}
        options={[opt('o1', '循環器', 'cat-1'), opt('o2', '腎臓', 'cat-1')]}
        allAssignedOptionIds={[]}
        onToggle={onToggle}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledWith('cat-1', 'o2')
    // popover が開いたまま → 戻るボタンがまだ存在
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 14. stage 2: option 0 件 → CardTagOptionList の placeholder が表示される
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 option 0 件', () => {
  it('option 0 件のとき CardTagOptionList の新 placeholder 文言が表示される', () => {
    // Tag-4c-2a-fix-4 Task 1 Fix-4: 0 件 placeholder 文言を「タグ名を入力し新規作成」 に短文化
    // (stage B popover 膨張源除去)。
    render(
      <CardTagAddPopover
        categories={[cat('cat-empty', '空カテゴリ', 'multi')]}
        options={[]}  // このカテゴリに option なし
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '空カテゴリ' }))
    expect(
      screen.getByText('タグ名を入力し新規作成'),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 15. footer「タグ管理 →」 link 全削除 regression (Tag-4c-2a Task 4 / spec B-2)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — タグ管理 link 全削除', () => {
  it('stage 1 + カテゴリ ≥1 件でも「タグ管理 →」 link は描画されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })

  it('stage 1 + カテゴリ 0 件でも「タグ管理 →」 link は描画されない', () => {
    render(
      <CardTagAddPopover
        categories={[]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })

  it('stage 2 + option ≥1 件でも「タグ管理 →」 link は描画されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })

  it('stage 2 + option 0 件でも「タグ管理 →」 link は描画されない', () => {
    render(
      <CardTagAddPopover
        categories={[cat('cat-empty', '空', 'multi')]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '空' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-1 Task 3 tests: kebab + edit stages + Esc 階層
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 16. stage 1: 各カテゴリ row に kebab span が表示される
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 kebab', () => {
  it('stage 1 で各カテゴリ row に kebab span (aria-label に「カテゴリ操作」) が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(screen.getByRole('button', { name: 'カテゴリ操作: 分野' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'カテゴリ操作: レベル' })).toBeInTheDocument()
  })

  it('category kebab click で editCategory stage に遷移する (header「カテゴリ選択へ戻る」が表示)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    // editCategory stage: back button が「カテゴリ選択へ戻る」
    expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
    // CardTagEditFields の rename input が表示される
    expect(screen.getByRole('textbox', { name: 'カテゴリ名 編集' })).toBeInTheDocument()
  })

  it('category kebab click は row click (stage option 遷移) を発火しない (stopPropagation)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    // option list (stage option) ではなく editCategory stage に遷移している
    // → menuitemcheckbox (option) は表示されない
    expect(screen.queryByRole('menuitemcheckbox', { name: '循環器' })).not.toBeInTheDocument()
  })

  it('category kebab keyboard (Enter) → 同じ editCategory 遷移', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    const kebab = screen.getByRole('button', { name: 'カテゴリ操作: 分野' })
    fireEvent.keyDown(kebab, { key: 'Enter' })
    expect(screen.getByRole('textbox', { name: 'カテゴリ名 編集' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 17. editCategory stage: Esc → stage='category'
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — editCategory Esc', () => {
  it('editCategory stage で Esc → stage=category (カテゴリリスト再表示)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    // editCategory stage で Esc
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(
      backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body,
      { key: 'Escape' },
    )
    // stage='category' に戻った → カテゴリリストが見える
    expect(screen.getByRole('button', { name: 'カテゴリ操作: 分野' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'カテゴリ名 編集' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 18. stage 2: 各 option row に kebab 表示 (onRowAction prop 経由)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 2 option kebab', () => {
  it('stage 2 で各 option row に kebab span が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // cat-1 の options: 循環器 (o1), 腎臓 (o2)
    expect(screen.getByRole('button', { name: 'option 操作: 循環器' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 腎臓' })).toBeInTheDocument()
  })

  it('option kebab click → editOption stage 遷移 (header「option 一覧へ戻る」)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    // editOption stage: back button「option 一覧へ戻る」
    expect(screen.getByRole('button', { name: 'option 一覧へ戻る' })).toBeInTheDocument()
    // CardTagEditFields の rename input が表示される
    expect(screen.getByRole('textbox', { name: 'option名 編集' })).toBeInTheDocument()
  })

  it('option kebab click は option toggle を発火しない (stopPropagation)', () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={onToggle}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    // toggle は呼ばれない (kebab click で editOption stage に遷移)
    expect(onToggle).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 19. editOption stage: Esc → stage='option'
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — editOption Esc', () => {
  it('editOption stage で Esc → stage=option (option list 再表示)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    // editOption stage で Esc
    const backBtn = screen.getByRole('button', { name: 'option 一覧へ戻る' })
    fireEvent.keyDown(
      backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body,
      { key: 'Escape' },
    )
    // stage='option' に戻った → option list が見える
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'option名 編集' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 20. editCategory: rename 成功 → callback 呼出 + stage 維持 + lastError null
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — editCategory rename / delete callbacks', () => {
  it('rename 成功: renameCategory が呼ばれ stage=editCategory を維持する', async () => {
    const callbacks = { ...mockTagEditCallbacks, renameCategory: vi.fn(async () => undefined) }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })
    fireEvent.change(input, { target: { value: '新しい分野名' } })
    fireEvent.blur(input)
    // rename callback が呼ばれた
    expect(callbacks.renameCategory).toHaveBeenCalledWith('cat-1', '新しい分野名')
    // stage は editCategory に留まる
    expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
  })

  it('rename throw → lastError が表示され stage=editCategory 維持', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      renameCategory: vi.fn(async () => { throw new Error('API error') }),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' })
    fireEvent.change(input, { target: { value: '新しい名前' } })
    fireEvent.blur(input)
    // error message が表示される (非同期なので await を使わず直接確認)
    // CardTagEditFields の errorMessage prop 経由で表示される
    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    // stage は維持
    expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
  })

  it('delete 成功: deleteCategory が呼ばれ stage=category に戻る', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      deleteCategory: vi.fn(async () => undefined),
      countCategoryImpact: vi.fn(async () => ({ optionCount: 0, cardCount: 0 })),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    // 削除ボタン click → countImpact → dialog open → confirm
    fireEvent.click(screen.getByRole('button', { name: /削除/ }))
    await vi.waitFor(() => {
      expect(screen.getByTestId('confirm-dialog-backdrop')).toBeInTheDocument()
    })
    // dialog の confirm button click
    const confirmBtn = screen.getByRole('button', { name: '削除する' })
    fireEvent.click(confirmBtn)
    await vi.waitFor(() => {
      expect(callbacks.deleteCategory).toHaveBeenCalledWith('cat-1')
    })
    // stage='category' に戻る
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'カテゴリ操作: レベル' })).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// 21. editOption: rename / delete callbacks
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — editOption rename / delete callbacks', () => {
  it('rename 成功: renameOption が呼ばれ stage=editOption 維持', async () => {
    const callbacks = { ...mockTagEditCallbacks, renameOption: vi.fn(async () => undefined) }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    const input = screen.getByRole('textbox', { name: 'option名 編集' })
    fireEvent.change(input, { target: { value: '新しい循環器' } })
    fireEvent.blur(input)
    expect(callbacks.renameOption).toHaveBeenCalledWith('o1', '新しい循環器')
    // stage は editOption に留まる
    expect(screen.getByRole('button', { name: 'option 一覧へ戻る' })).toBeInTheDocument()
  })

  it('Fix A-3: delete 成功: 削除 button click で即 deleteOption が呼ばれ stage=option に戻る', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      deleteOption: vi.fn(async () => undefined),
      countOptionImpact: vi.fn(async () => ({ cardCount: 0 })),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    // Fix A-3: option 削除は即削除 (dialog を経由しない)
    fireEvent.click(screen.getByRole('button', { name: /削除/ }))
    await vi.waitFor(() => {
      expect(callbacks.deleteOption).toHaveBeenCalledWith('o1')
    })
    // DeleteConfirmDialog は開かない
    // (Radix Popover 自体は role="dialog" を持つため queryByRole('dialog') ではなく
    // confirm-dialog-backdrop testid で確認する)
    expect(screen.queryByTestId('confirm-dialog-backdrop')).not.toBeInTheDocument()
    // countOptionImpact は呼ばれない
    expect(callbacks.countOptionImpact).not.toHaveBeenCalled()
    // stage='option' に戻る (成功後 popover が setStage('option') する)
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'option 一覧へ戻る' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// 22. popover close で全 state reset (editTargetId=null, lastError=null)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — close で全 state reset', () => {
  it('editCategory stage から close → 再 open で stage=category, edit 要素なし', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    // open → editCategory へ
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    expect(screen.getByRole('textbox', { name: 'カテゴリ名 編集' })).toBeInTheDocument()

    // Esc 2 回で close (editCategory Esc → category, category Esc → close)
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(
      backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body,
      { key: 'Escape' },
    )
    // stage=category になった → category の Esc で close
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: '分野' })).not.toBeInTheDocument()

    // 再 open → stage=category から (edit input なし)
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'カテゴリ名 編集' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 23. edit stages でも「タグ管理 →」 link は描画されない (Tag-4c-2a Task 4 / spec B-2)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — edit stages でも タグ管理 link なし', () => {
  it('editCategory stage で「タグ管理 →」 link は描画されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })

  it('editOption stage で「タグ管理 →」 link は描画されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Fix C-3: sortByKeyThenCreated 純粋関数ユニットテストは Tag-4c-2b T1.5 で
// `lib/tags/sort-comparator.test.ts` に移転 (popover ローカル定義の共有 module 化に伴う)。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tag-4c-2a-fix Task 3: createCategoryType stage 配線テスト
// stage 1 combobox 「新規作成: {name}」 click → createCategoryType stage 表示 →
// single/multi 2 button のいずれかを click → createCategory(name, type) 発火 +
// stage='option' へ遷移。
// 旧「+ カテゴリを追加」 row + createCategory stage は撤廃済 (DOM に存在しない)。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 24. stage1 combobox 「新規作成: {name}」 row → createCategoryType stage 表示
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — createCategoryType stage 表示', () => {
  it('combobox 入力 → 「新規作成: {name}」 click で createCategoryType stage に遷移 (2 button + back)', () => {
    // Tag-4c-2a-fix-3 Task 2 Fix-2: 旧見出し「『{name}』 の種別を選択」 は削除済 → DOM 不在を検証。
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // 旧「+ カテゴリを追加」 row は存在しない
    expect(
      screen.queryByRole('button', { name: '+ カテゴリを追加' }),
    ).not.toBeInTheDocument()
    // combobox に新カテゴリ名を入力 → 新規作成行が表示される
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    // Tag-4c-2a-fix-3 Fix-2: 旧見出し「『新カテゴリ』 の種別を選択」 は削除されているため DOM 不在
    expect(screen.queryByText(/の種別を選択/)).not.toBeInTheDocument()
    // 2 button が表示される (stage createCategoryType 固有の marker)
    expect(screen.getByRole('button', { name: /シングルセレクト/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /マルチセレクト/ })).toBeInTheDocument()
    // back button が表示される
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()
    // 旧 stage の name input は存在しない
    expect(
      screen.queryByRole('textbox', { name: 'カテゴリ名' }),
    ).not.toBeInTheDocument()
  })

  it('Tag-4c-2a-fix-4 Fix-3: 2 button block の outer wrapper は `pb-1` のみ (px-2 削除)、 stage 全体 wrapper は `py-1`', () => {
    // Tag-4c-2a-fix-4 Fix-3: 型選択 stage の 2-button outer から余分 `px-2` を削除し、
    // button content 左端を他 stage の row content (8px) に揃える。
    // button class 内の `px-2` はそのまま維持し、 二重 px-2 を解消する。
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    const singleBtn = screen.getByRole('button', { name: /シングルセレクト/ })
    // 2 button block の outer wrapper は `pb-1` のみ (`px-2 pb-1` は不在)
    const pbWrapper = singleBtn.closest('div.pb-1')
    expect(pbWrapper).not.toBeNull()
    // `px-2 pb-1` (px-2 と pb-1 を両方持つ div) は不在
    expect(singleBtn.closest('div.px-2.pb-1')).toBeNull()
    // stage 全体 wrapper (back button block + 2 button block を包む div) の class assertion
    const stageWrapper = pbWrapper?.parentElement
    expect(stageWrapper).not.toBeNull()
    expect(stageWrapper?.className).toContain('py-1')
  })

  it('Tag-4c-2a-fix-4 Fix-1: PopoverContent に `min-w-56` floor が含まれ `w-auto` は不在', () => {
    // stage 遷移時の幅収縮を防ぐため、 PopoverContent に min-w-56 (224px) を追加。
    // w-auto は削除、 max-w-sm + p-0 は維持。
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    const content = document.querySelector('[data-slot="popover-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toContain('min-w-56')
    expect(content?.className).toContain('max-w-sm')
    expect(content?.className).toContain('p-0')
    expect(content?.className).not.toContain('w-auto')
  })

  it('Tag-4c-2a-fix-3 Fix-2: 旧見出し「『{name}』 の種別を選択」 は DOM に存在しない (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '見出しテスト' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 見出しテスト' }))
    // 完全一致でも部分一致でも見出し文言は DOM に存在しない
    expect(screen.queryByText('「見出しテスト」 の種別を選択')).not.toBeInTheDocument()
    expect(screen.queryByText(/の種別を選択/)).not.toBeInTheDocument()
  })

  it('Tag-4c-2a-fix Task 3: 旧 createCategory stage の DOM 要素は存在しない', () => {
    // popover を createCategoryType stage まで進める
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    // 旧 stage の name input / segment / 作成 button は存在しない
    expect(
      screen.queryByRole('textbox', { name: 'カテゴリ名' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '単一選択' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '複数選択' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '作成' })).not.toBeInTheDocument()
  })

  // Tag-4c-2a-fix-2 Task 1: コンパクト化により旧大 button (title + description)
  // を撤去。 button 名は「シングルセレクト」「マルチセレクト」 に変更、 description
  // 文 (「1 つの card にこのカテゴリの option は最大 1 つ」 等) は完全削除。
  it('Tag-4c-2a-fix-2 Task 1: 旧 button label / description が DOM に存在しない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    // 旧 button 名は accessible name でヒットしない
    expect(
      screen.queryByRole('button', { name: /単一 \(single\)/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /複数 \(multi\)/ }),
    ).not.toBeInTheDocument()
    // 旧 description 文も DOM に存在しない
    expect(screen.queryByText(/最大 1 つ/)).not.toBeInTheDocument()
    expect(screen.queryByText(/複数付与できる/)).not.toBeInTheDocument()
  })

  // Tag-4c-2a-fix-2 Task 1 / Tag-4c-2a-fix-3 Task 2 Fix-3: コンパクト化 button に
  // icon (CircleDot / CheckSquare) が含まれる。 lucide-react@1.14.0 では
  // CheckSquare は SquareCheckBig の alias で実 emit class は
  // `lucide-square-check-big` のため、 multi 側はこの class で検証する。
  it('Tag-4c-2a-fix-3 Task 2 Fix-3: 各 button に lucide icon (CircleDot / CheckSquare = SquareCheckBig) が含まれる', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    const singleBtn = screen.getByRole('button', { name: /シングルセレクト/ })
    const multiBtn = screen.getByRole('button', { name: /マルチセレクト/ })
    // CircleDot icon が single button 内に存在
    expect(singleBtn.querySelector('svg.lucide-circle-dot')).not.toBeNull()
    // CheckSquare (= SquareCheckBig alias) icon が multi button 内に存在
    expect(multiBtn.querySelector('svg.lucide-square-check-big')).not.toBeNull()
    // 旧 ListChecks icon は DOM 不在 (regression for Fix-3)
    expect(multiBtn.querySelector('svg.lucide-list-checks')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 25. createCategoryType: 「マルチセレクト」 button が default focus を持つ
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — createCategoryType default focus', () => {
  it('createCategoryType stage 表示直後に「マルチセレクト」 button が focus される', async () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    // useEffect 経由で focus が当たる → 次の microtask で確認
    await vi.waitFor(() => {
      const multiBtn = screen.getByRole('button', { name: /マルチセレクト/ })
      expect(document.activeElement).toBe(multiBtn)
    })
  })
})

// ---------------------------------------------------------------------------
// 26. createCategoryType: single button click → createCategory(name, 'single') 成功
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — createCategoryType 成功 path', () => {
  it('single button click → createCategory(name, "single") 呼出 + stage=option + 新 id 選択', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createCategory: vi.fn(async () => ({ id: 'new-cat-id' })),
    }
    // Tag-4c-2a-fix-2 Task 2: stage1 combobox は完全一致時 新規作成行を抑制するため、
    // 既存 categories に同名 '新カテゴリ' を含めず、 入力で作成行が出る状態にする。
    // (post-create stage=option の selectedCategory 解決は id='new-cat-id' で行われる
    // ので、 pre-populated name は別名でよい。)
    const categoriesWithNew = [
      ...CATEGORIES,
      cat('new-cat-id', '新カテゴリ-stub', 'single', '2026-06-08T00:00:00.000Z'),
    ]
    render(
      <CardTagAddPopover
        categories={categoriesWithNew}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    fireEvent.click(screen.getByRole('button', { name: /シングルセレクト/ }))
    await vi.waitFor(() => {
      expect(callbacks.createCategory).toHaveBeenCalledWith('新カテゴリ', 'single')
    })
    // stage='option' へ遷移
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      ).toBeInTheDocument()
    })
  })

  it('multi button click → createCategory(name, "multi") 呼出 + stage=option', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createCategory: vi.fn(async () => ({ id: 'new-cat-id' })),
    }
    // Tag-4c-2a-fix-2 Task 2: 同上 (pre-populated name は別名で衝突回避)
    const categoriesWithNew = [
      ...CATEGORIES,
      cat('new-cat-id', '新カテゴリ-stub', 'multi', '2026-06-08T00:00:00.000Z'),
    ]
    render(
      <CardTagAddPopover
        categories={categoriesWithNew}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    fireEvent.click(screen.getByRole('button', { name: /マルチセレクト/ }))
    await vi.waitFor(() => {
      expect(callbacks.createCategory).toHaveBeenCalledWith('新カテゴリ', 'multi')
    })
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      ).toBeInTheDocument()
    })
  })

  it('成功後 stage=category へ back すると pendingCategoryName は reset されている', async () => {
    // Tag-4c-2a-fix-3 Task 2 Fix-2: 見出し削除に伴い、 pendingCategoryName reset の検証は
    // 見出しテキスト比較ではなく、 第 2 サイクルの multi click で createCategory(name='Y')
    // が呼ばれる (X が漏れていない) ことで確認する。
    const callbacks = {
      ...mockTagEditCallbacks,
      createCategory: vi.fn(async () => ({ id: 'new-cat-id' })),
    }
    // Tag-4c-2a-fix-2 Task 2: stage1 完全一致抑制のため pre-populated name は 'X' / 'Y' と
    // 衝突しない別名にし、 stage1 入力 ('X' / 'Y') に対し createRow が必ず出る状態にする。
    const categoriesWithNew = [
      ...CATEGORIES,
      cat('new-cat-id', 'new-cat-stub', 'multi', '2026-06-08T00:00:00.000Z'),
    ]
    render(
      <CardTagAddPopover
        categories={categoriesWithNew}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: 'X' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: X' }))
    fireEvent.click(screen.getByRole('button', { name: /マルチセレクト/ }))
    // 成功後 stage='option' + 第 1 サイクルで createCategory が 'X' で呼ばれた
    await vi.waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      ).toBeInTheDocument()
    })
    expect(callbacks.createCategory).toHaveBeenNthCalledWith(1, 'X', 'multi')
    // 戻る → category stage で別 name 入力 → 新 createCategoryType に進む
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: 'Y' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: Y' }))
    // 旧見出しは削除済 → DOM 不在
    expect(screen.queryByText(/の種別を選択/)).not.toBeInTheDocument()
    // 第 2 サイクル multi click → createCategory が 'Y' で呼ばれる (X が漏れていない)
    fireEvent.click(screen.getByRole('button', { name: /マルチセレクト/ }))
    await vi.waitFor(() => {
      expect(callbacks.createCategory).toHaveBeenNthCalledWith(2, 'Y', 'multi')
    })
  })
})

// ---------------------------------------------------------------------------
// 27. createCategoryType: 失敗 path
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — createCategoryType 失敗 path', () => {
  it('callback throw → role="alert" error 表示 + stage=createCategoryType 維持 + pendingCategoryName 保持', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createCategory: vi.fn(async () => {
        throw new Error('API error')
      }),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '失敗テスト' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 失敗テスト' }))
    fireEvent.click(screen.getByRole('button', { name: /マルチセレクト/ }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作成に失敗しました')
    })
    // Tag-4c-2a-fix-3 Fix-2: 見出しは削除済 → stage='createCategoryType' 維持の確認は
    // 2 button が依然 enable + back button が表示 で代替 (見出しテキストは検査しない)。
    expect(screen.queryByText(/の種別を選択/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /シングルセレクト/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /マルチセレクト/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 28. createCategoryType: Esc → stage=category + pendingCategoryName/createError reset
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — createCategoryType Esc / back button', () => {
  it('createCategoryType stage で Esc → stage=category 戻り + pendingCategoryName reset', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '途中入力' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 途中入力' }))
    // createCategoryType で Esc
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(
      backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body,
      { key: 'Escape' },
    )
    // Tag-4c-2a-fix-3 Fix-2: 見出しは元々削除済 → stage='category' 戻りの確認は
    // カテゴリリスト (menuitem '分野') の再表示 + 2 button (createCategoryType 固有) が消える で行う。
    expect(screen.queryByRole('button', { name: /マルチセレクト/ })).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
  })

  it('createCategoryType back button click でも stage=category + pendingCategoryName reset', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '途中入力' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 途中入力' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    // Tag-4c-2a-fix-3 Fix-2: stage='category' 戻りの確認 (見出しは元々削除済)
    expect(screen.queryByRole('button', { name: /マルチセレクト/ })).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 30. stage=option: CardTagOptionList に onCreateNew / createError が配線される
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — option 新規作成配線', () => {
  it('新規作成行 click → createOptionAndAssign(categoryId, name) が呼ばれる', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createOptionAndAssign: vi.fn(async () => undefined),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // option filter input に存在しない名前を入力 → 新規作成行が出る
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: '新 option' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新 option' }))
    await vi.waitFor(() => {
      expect(callbacks.createOptionAndAssign).toHaveBeenCalledWith('cat-1', '新 option')
    })
  })

  it('createOptionAndAssign throw → createError が表示される', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createOptionAndAssign: vi.fn(async () => {
        throw new Error('option create fail')
      }),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: 'fail-opt' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: fail-opt' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作成に失敗しました')
    })
  })
})

// ---------------------------------------------------------------------------
// 31. popover close で createCategoryType state も全 reset される
//     (Tag-4c-2a-fix Task 3: pendingCategoryName + createError + isSubmittingCreate)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — close で create 系 state reset', () => {
  it('createCategoryType stage で → close → 再 open で stage=category + pendingCategoryName null', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    // createCategoryType まで進める
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '途中' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 途中' }))
    // Tag-4c-2a-fix-3 Fix-2: 見出しは削除済 → createCategoryType 到達の確認は
    // multi/single 2 button が表示されることで代替する。
    expect(screen.getByRole('button', { name: /マルチセレクト/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /シングルセレクト/ })).toBeInTheDocument()
    // Esc 2 回で close (createCategoryType → category → close)
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(
      backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body,
      { key: 'Escape' },
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // closed
    expect(
      screen.queryByRole('menuitem', { name: '分野' }),
    ).not.toBeInTheDocument()
    // 再 open → stage=category、 createCategoryType 固有 marker (multi button) は不在
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /マルチセレクト/ })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2a Task 3 fix: Important 1 (createError leak across stages)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — createError は stage 遷移で持ち越されない (Important 1)', () => {
  it('option stage で create 失敗 → 戻る button click で category 戻り → createError 消える', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createOptionAndAssign: vi.fn(async () => {
        throw new Error('option create fail')
      }),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // 新規作成行で fail させて createError をセットする
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: 'fail-opt' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: fail-opt' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作成に失敗しました')
    })
    // 戻る button で category へ
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    // 別カテゴリへ進む → 新カテゴリの option list には createError が表示されない
    fireEvent.click(screen.getByRole('menuitem', { name: 'レベル' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('option stage で create 失敗 → Esc で category 戻り → createError 消える', async () => {
    const callbacks = {
      ...mockTagEditCallbacks,
      createOptionAndAssign: vi.fn(async () => {
        throw new Error('option create fail')
      }),
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: 'fail-opt' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: fail-opt' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作成に失敗しました')
    })
    // option stage で Esc → category stage に戻る
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(
      backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body,
      { key: 'Escape' },
    )
    // 別カテゴリへ → createError は持ち越されない
    fireEvent.click(screen.getByRole('menuitem', { name: 'レベル' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2a Task 3 fix: Important 2 (二重発火ガード)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — 二重発火ガード (Important 2)', () => {
  // Tag-4c-2a-fix Task 3: createCategoryType stage の single/multi button 連打
  // ガード。 第 1 click 後 button は disabled になり、 さらに handler 先頭でも
  // isSubmittingCreate guard で短絡することを検証する。
  it('createCategoryType: multi button を連打しても createCategory は 1 回だけ呼ばれる', async () => {
    // 解決を保留できる手動 promise で第 1 呼出を pending にしてから第 2 click を撃つ
    let resolveCreate: ((v: { id: string }) => void) | null = null
    const createCategoryMock = vi.fn(
      () =>
        new Promise<{ id: string }>((res) => {
          resolveCreate = res
        }),
    )
    const callbacks = {
      ...mockTagEditCallbacks,
      createCategory: createCategoryMock,
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '二重テスト' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 二重テスト' }))
    const multiBtn = screen.getByRole('button', { name: /マルチセレクト/ })
    // 第 1 click
    fireEvent.click(multiBtn)
    // state 更新 (isSubmittingCreate=true) を React に flush させる
    await vi.waitFor(() => {
      expect(
        screen.getByRole('button', { name: /マルチセレクト/ }),
      ).toBeDisabled()
    })
    // 第 2 click (button は disabled、 さらに handler 先頭でも isSubmittingCreate guard)
    fireEvent.click(screen.getByRole('button', { name: /マルチセレクト/ }))
    // 第 1 呼出を resolve させて handler の finally まで進める
    expect(resolveCreate).not.toBeNull()
    resolveCreate!({ id: 'new-cat' })
    await vi.waitFor(() => {
      // option stage に遷移している → multi button は DOM から消える
      expect(
        screen.queryByRole('button', { name: /マルチセレクト/ }),
      ).not.toBeInTheDocument()
    })
    // createCategory は 1 回だけ呼ばれる
    expect(createCategoryMock).toHaveBeenCalledTimes(1)
  })

  it('option 新規作成: 新規作成行 click を連打しても createOptionAndAssign は 1 回だけ呼ばれる', async () => {
    let resolveCreate: (() => void) | null = null
    const createOptionMock = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveCreate = res
        }),
    )
    const callbacks = {
      ...mockTagEditCallbacks,
      createOptionAndAssign: createOptionMock,
    }
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={callbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: '新opt' } },
    )
    const createRowBtn = screen.getByRole('button', { name: '新規作成: 新opt' })
    // 第 1 click
    fireEvent.click(createRowBtn)
    // React state (isSubmittingCreate=true) の flush を待つため microtask 進める。
    // ボタン自体は CardTagOptionList 側で disabled 化していないため、
    // wrapper handler 内の isSubmittingCreate guard が短絡することを検証する。
    await Promise.resolve()
    await Promise.resolve()
    // 第 2 click: 同じ button (filterText は await 解決後まで clear されない)
    fireEvent.click(createRowBtn)
    // 第 1 呼出を resolve
    expect(resolveCreate).not.toBeNull()
    resolveCreate!()
    await vi.waitFor(() => {
      expect(createOptionMock).toHaveBeenCalledTimes(1)
    })
    // 念のためもう少し待っても 1 回のまま
    await Promise.resolve()
    expect(createOptionMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2a-fix-2 Fix-3: 編集 stage rename input 全選択 focus
// kebab click で editCategory / editOption stage に遷移した直後、 rename input が
// focus 済 + テキスト全選択済になる。 同 stage 内で別 target に kebab を切替
// (editTargetId 変化) した場合も `key={editTargetId}` で再 mount され useEffect が
// 再発火する。
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — Fix-3: kebab → 編集 stage rename input 全選択 focus', () => {
  it('category kebab click → editCategory stage rename input が focus + 全選択', async () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    const input = screen.getByRole('textbox', { name: 'カテゴリ名 編集' }) as HTMLInputElement
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('option kebab click → editOption stage rename input が focus + 全選択', async () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    const input = screen.getByRole('textbox', { name: 'option名 編集' }) as HTMLInputElement
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('editOption stage 中に別 option の kebab → editTargetId 変化 → 再 mount → 全選択 focus 再発火', async () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // 第 1 kebab: 循環器
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    const firstInput = screen.getByRole('textbox', { name: 'option名 編集' }) as HTMLInputElement
    await waitFor(() => {
      expect(document.activeElement).toBe(firstInput)
    })
    expect(firstInput.value).toBe('循環器')
    expect(firstInput.selectionStart).toBe(0)
    expect(firstInput.selectionEnd).toBe(firstInput.value.length)

    // editOption stage を一度 option stage に戻し、 別 option (腎臓) の kebab を click。
    // (editOption stage では option 一覧の kebab が表示されないため、 一度戻ってから別 kebab を撃つ)
    fireEvent.click(screen.getByRole('button', { name: 'option 一覧へ戻る' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 腎臓' }))
    const secondInput = screen.getByRole('textbox', { name: 'option名 編集' }) as HTMLInputElement
    // key={editTargetId} 切替で再 mount → useEffect 再発火 → focus + 全選択
    await waitFor(() => {
      expect(document.activeElement).toBe(secondInput)
    })
    expect(secondInput.value).toBe('腎臓')
    expect(secondInput.selectionStart).toBe(0)
    expect(secondInput.selectionEnd).toBe(secondInput.value.length)
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2b T5: popover stage 別 DndContext + filter ↔ D&D 整合
//
// 検証観点:
//   (a) stage1 filter 空 + onReorderCategories 渡し済 → handle 表示
//       (handle 経由で D&D drop すると onReorderCategories(orderedIds) が呼ばれる)
//   (b) stage1 filter non-empty → handle 非表示 (drag 不能)
//   (c) stage2 filter 空 + onReorderOptions 渡し済 → handle 表示
//   (d) stage2 filter non-empty → handle 非表示
//   (e) 編集 stage (editCategory / editOption / createCategoryType) には DndContext を
//       mount しない (handle 出ない)
//   (f) stage1/stage2 で filter 空に戻すと handle 復活
//
// dnd-kit の実 pointer drag シミュレーションは jsdom で再現困難なため、
// (a)/(c) の onReorder 呼出は「handle が presence」 + 「callback prop が popover の
// 内部 handler 経由で確実に onReorder へ pass-through される」 のを別軸 (popover prop
// 受け取り + CardTagOptionList へ手渡し済) で検証する。 onReorder の呼出 1 回 + 引数 pin は
// 実時 drag 経路が必要なため OT smoke (spec §9) に委ねる。
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — Tag-4c-2b T5: stage1 D&D 配線 (filter 空)', () => {
  it('stage1 filter 空 + onReorderCategories 渡し済 → 各 category row に handle button が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // handle aria-label = `カテゴリを並べ替え: {name}`
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 分野' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: レベル' }),
    ).toBeInTheDocument()
  })

  it('stage1 filter non-empty 中は handle button が DOM 上消える (D&D 無効化)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // filter 空時点では handle あり
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 分野' }),
    ).toBeInTheDocument()
    // filter に文字を入れる
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '分' } },
    )
    // 残った行は menuitem として存在するが handle button は出ない
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /カテゴリを並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('stage1 filter 空に戻すと handle 復活 (D&D 再有効化)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    const input = screen.getByRole('textbox', { name: 'category を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '分' } })
    // 中間: handle 非表示
    expect(
      screen.queryByRole('button', { name: /カテゴリを並べ替え:/ }),
    ).not.toBeInTheDocument()
    // 空文字に戻す
    fireEvent.change(input, { target: { value: '' } })
    // 復活
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 分野' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: レベル' }),
    ).toBeInTheDocument()
  })

  it('onReorderCategories 未渡し → handle button は表示されない (T6 配線前互換)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        /* onReorderCategories 渡さない */
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.queryByRole('button', { name: /カテゴリを並べ替え:/ }),
    ).not.toBeInTheDocument()
    // 既存挙動 (menuitem) は維持
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // T5 fix I-1: filter が 2+ 件残った状態でも handle 非表示 (dndEnabled gate を pin)
  //   旧 fixture (2 件) では filter '分' → 1 件残り、 length<2 短絡経路と
  //   dndEnabled gate どちらが効いて handle が消えたか区別できなかった。
  //   3 件以上の共通 substring を持つ category 群で filter 2+ 件残し、
  //   なお handle が消えることを assert することで、 length 短絡ではなく
  //   filter-text 由来 dndEnabled gate が確実に効いていることを pin する
  //   (spec §4.5 不変条件「filter 中は D&D 無効」)。
  // ---------------------------------------------------------------------------
  it('stage1 filter で 2+ 件残るが handle 非表示 (length 短絡ではなく dndEnabled gate)', () => {
    // 共通 substring '分' を含む 3 件 → filter '分' で 3 件残る
    const fanCategories = [
      cat('cat-a', '分野', 'multi', '2026-06-07T01:00:00.000Z'),
      cat('cat-b', '分類', 'multi', '2026-06-07T02:00:00.000Z'),
      cat('cat-c', '分布', 'single', '2026-06-07T03:00:00.000Z'),
    ]
    render(
      <CardTagAddPopover
        categories={fanCategories}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // filter 空時点で 3 件 + handle 3 件 (length>=2 + dndEnabled=true)
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 分野' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 分類' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 分布' }),
    ).toBeInTheDocument()

    // '分' で filter → 3 件残る (length 短絡条件 length<2 は不成立)
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '分' } },
    )
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '分類' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '分布' })).toBeInTheDocument()

    // 3 件残るが handle は出ない (dndEnabled gate が効いている)
    expect(
      screen.queryByRole('button', { name: /カテゴリを並べ替え:/ }),
    ).not.toBeInTheDocument()
  })
})

describe('CardTagAddPopover — Tag-4c-2b T5: stage2 D&D 配線 (filter 空)', () => {
  it('stage2 filter 空 + onReorderOptions 渡し済 → 各 option row に handle button が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 腎臓' }),
    ).toBeInTheDocument()
  })

  it('stage2 filter non-empty 中は handle button が DOM 上消える', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // filter 空: handle あり
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 循環器' }),
    ).toBeInTheDocument()
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: '循' } },
    )
    expect(
      screen.queryByRole('button', { name: /optionを並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('stage2 filter 空に戻すと handle 復活', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '循' } })
    expect(
      screen.queryByRole('button', { name: /optionを並べ替え:/ }),
    ).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 循環器' }),
    ).toBeInTheDocument()
  })

  it('onReorderOptions 未渡し → handle 出ない (T6 配線前互換)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        /* onReorderOptions 渡さない */
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.queryByRole('button', { name: /optionを並べ替え:/ }),
    ).not.toBeInTheDocument()
    // 既存挙動 (menuitemcheckbox) は維持
    expect(
      screen.getByRole('menuitemcheckbox', { name: '循環器' }),
    ).toBeInTheDocument()
  })

  it('stage2 sortable pass-through contract: popover に onReorderOptions を渡すと DndContext が mount され handle が出るが、 drag 未発生時は onReorderOptions が呼ばれない (T5 fix I-2: 子は sortable boolean のみ受け取り、 実 dispatch は親 DndContext.onDragEnd 経路)', () => {
    // 実 drag シミュレーションは jsdom で不安定なため、 contract レベルで以下を pin:
    //   - popover に onReorderOptions を渡すと DndContext + SortableContext が mount される
    //   - 子 CardTagOptionList は sortable boolean だけ受け取り handle UI を render
    //   - drag 未発生 (通常 render + click) 時点では onReorderOptions が呼ばれない
    //     (= 子内部に reorder dispatch path が存在しないことの間接 pin、
    //      実 dispatch は親 DndContext.onDragEnd → handleStage2DragEnd → onReorderOptions(categoryId, ids) 経路で行う)
    // selectedCategory.id 付与は popover 側 handleStage2DragEnd が担う実装契約で、
    // onReorderOptions(categoryId, ids) signature を見れば categoryId が curry
    // されることが構造的に保証される (T5 fix I-2 で旧 closure wrapper を削除し
    // 親側 DragEnd handler に dispatch path を集約)。
    const onReorderOptions = vi.fn(async () => undefined)
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderOptions={onReorderOptions}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // handle 表示 = DndContext mount 済 + 子 sortable=true で render
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 循環器' }),
    ).toBeInTheDocument()
    // drag が起きていないので onReorderOptions は呼ばれていない (子経路で実 dispatch しない)
    expect(onReorderOptions).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // T5 fix I-1: stage2 でも filter 2+ 件残しで handle 非表示 (dndEnabled gate を pin)
  //   既存 fixture (cat-1 配下 2 option = 循環器/腎臓) では filter 1 件 = length 短絡で
  //   handle が消える可能性が残り、 dndEnabled gate が効いたか区別できなかった。
  //   '器' 共通 substring を持つ 3 件以上 (循環器 / 消化器 / 呼吸器) を fixture に乗せ、
  //   filter '器' で 3 件残るが handle 非表示を assert する。 spec §4.5 不変条件
  //   「filter 中は D&D 無効」 を length 短絡経路に依らずに pin。
  // ---------------------------------------------------------------------------
  it('stage2 filter で 2+ 件残るが handle 非表示 (length 短絡ではなく dndEnabled gate)', () => {
    // 共通 substring '器' を含む 3 件 + cat-1 配下
    const organOptions = [
      opt('o-a', '循環器', 'cat-1'),
      opt('o-b', '消化器', 'cat-1'),
      opt('o-c', '呼吸器', 'cat-1'),
    ]
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={organOptions}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))

    // filter 空時点で 3 件 handle あり
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 消化器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 呼吸器' }),
    ).toBeInTheDocument()

    // '器' で filter → 3 件残る (length 短絡条件 length<2 は不成立)
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: '器' } },
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: '循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemcheckbox', { name: '消化器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemcheckbox', { name: '呼吸器' }),
    ).toBeInTheDocument()

    // 3 件残るが handle は出ない (dndEnabled gate が効いている)
    expect(
      screen.queryByRole('button', { name: /optionを並べ替え:/ }),
    ).not.toBeInTheDocument()
  })
})

// row-dnd sprint task-2 配線 pin (Codex 抜け 10 採用): factory unit test
// (`lib/dnd/accessibility.test.ts`) だけでは DndContext への配線漏れを検出できない
// ため、 実際に mount された DndContext の hidden instructions 要素
// (dnd-kit `HiddenText`、 `display:none` の div) に日本語文言が実在することを stage1・
// stage2 それぞれで pin する。
describe('CardTagAddPopover — a11y 配線 pin (row-dnd sprint task-2)', () => {
  it('stage1 DndContext mount 時に SORTABLE_SR_INSTRUCTIONS.draggable の実文言が hidden instructions 要素に存在する', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByText(SORTABLE_SR_INSTRUCTIONS.draggable),
    ).toBeInTheDocument()
  })

  it('stage2 DndContext mount 時に SORTABLE_SR_INSTRUCTIONS.draggable の実文言が hidden instructions 要素に存在する', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.getByText(SORTABLE_SR_INSTRUCTIONS.draggable),
    ).toBeInTheDocument()
  })

  it('stage1 → stage2 遷移後も文言は 1 件のまま (stage1 が残留 mount しない裏取り)', () => {
    // stage1・stage2 は排他表示 (どちらか一方の JSX しか render されない) ため、
    // 「stage1 mount 中は 1 件」「stage2 遷移後も 1 件 (stage1 unmount + stage2 mount)」
    // が正しい。 brief の「同一画面複数 DndContext は getAllByText 許容」 は将来 2 つの
    // DndContext が同時 mount されるケース向けの許容であり、 本 popover は排他なので
    // getAllByText で 1 件固定を pin することで、 その前提 (排他性) 自体も裏取りする。
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getAllByText(SORTABLE_SR_INSTRUCTIONS.draggable),
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.getAllByText(SORTABLE_SR_INSTRUCTIONS.draggable),
    ).toHaveLength(1)
  })
})

describe('CardTagAddPopover — Tag-4c-2b T5: 編集 stage には DndContext mount しない', () => {
  it('editCategory stage に遷移しても category handle は出ない (spec §1 out of scope)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    // editCategory に遷移済 = カテゴリ名 編集 input が出る
    expect(
      screen.getByRole('textbox', { name: 'カテゴリ名 編集' }),
    ).toBeInTheDocument()
    // category handle / option handle どちらも出ない
    expect(
      screen.queryByRole('button', { name: /を並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('editOption stage に遷移しても option handle は出ない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
        onReorderOptions={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    expect(
      screen.getByRole('textbox', { name: 'option名 編集' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /を並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('createCategoryType stage に遷移しても handle は出ない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        onReorderCategories={vi.fn(async () => undefined)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新カテゴリ' }))
    // createCategoryType stage に遷移 (single/multi 2 button が見える)
    expect(
      screen.getByRole('button', { name: /マルチセレクト/ }),
    ).toBeInTheDocument()
    // handle は出ない
    expect(
      screen.queryByRole('button', { name: /を並べ替え:/ }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2c hotfix H5: PopoverContent に collisionPadding / sideOffset /
//   avoidCollisions が渡されている
// ---------------------------------------------------------------------------
// 端起動時の余白確保 (handle 24px / kebab 28px の操作 affordance 確保) のため、
// Radix Popover の positioning props を 3 件追加。 これらは DOM 属性化されない
// (floating-ui middleware に内部消費) ため、 `vi.mock` で PopoverContent を spy
// wrap し props を直接 assert する。
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — Tag-4c-2c hotfix H5 / H7a: PopoverContent 余白 props', () => {
  it('popover open 時に collisionPadding=16 / sideOffset=4 / avoidCollisions=true が渡される', () => {
    popoverContentPropsSpy.mockClear()
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // open 後 spy は最低 1 回呼ばれている (Radix mount + 任意 re-render)
    expect(popoverContentPropsSpy).toHaveBeenCalled()
    // 最後の call の props で本 hotfix の 3 件を assert (中間 render でも同値を期待)
    // H7a: 8 → 16 (1rem) に bump (OT 実機確認で 8 が不足判定)
    const lastCall = popoverContentPropsSpy.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const props = lastCall![0] as Record<string, unknown>
    expect(props.collisionPadding).toBe(16)
    expect(props.sideOffset).toBe(4)
    expect(props.avoidCollisions).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2c hotfix H6: drag 中 Esc (defaultPrevented=true) で popover を閉じない
// ---------------------------------------------------------------------------
// dnd-kit KeyboardSensor の cancel 経路 (node_modules/@dnd-kit/core/dist/
// core.esm.js:1332 `handleCancel`) は `event.preventDefault()` を呼ぶ。
// PopoverContent の `onEscapeKeyDown` 先頭で `e.defaultPrevented` 早期 return
// することで「drag 中 Esc → drag cancel のみ / popover stage 維持 / close 起動
// しない」 を構造的に実現する。 通常 Esc (preventDefault されていない) は既存
// stage 階層挙動を維持。
// ---------------------------------------------------------------------------

/**
 * Tag-4c-2c hotfix H6 / H7a: spy は `@/components/ui/popover` の PopoverContent
 * 全 mount を捕捉するため、 editCategory / editOption stage で render される
 * `ColorPalettePopover` 内部の PopoverContent (`onEscapeKeyDown` を持たない)
 * とも衝突する。 ここでは「本 add popover の PopoverContent」 を
 * `collisionPadding=16` (H5 で 8 / H7a で 16 に bump、 当該 popover 固有 props)
 * で識別する。
 */
function findAddPopoverProps(): {
  onEscapeKeyDown?: (event: KeyboardEvent) => void
} {
  for (let i = popoverContentPropsSpy.mock.calls.length - 1; i >= 0; i--) {
    const call = popoverContentPropsSpy.mock.calls[i]
    const p = call?.[0] as Record<string, unknown> | undefined
    if (p && p.collisionPadding === 16) {
      return p as { onEscapeKeyDown?: (event: KeyboardEvent) => void }
    }
  }
  throw new Error(
    'CardTagAddPopover の PopoverContent props を spy から特定できませんでした',
  )
}

describe('CardTagAddPopover — Tag-4c-2c hotfix H6: drag cancel Esc gate', () => {
  it('defaultPrevented=true の Esc は stage 遷移 / preventDefault 追加呼出 を起動しない', () => {
    popoverContentPropsSpy.mockClear()
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    // popover を open → editCategory stage に進める (stage 階層挙動が観測可能な状態)
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()

    // 本 popover の PopoverContent props から onEscapeKeyDown を取り出す
    const props = findAddPopoverProps()
    expect(typeof props.onEscapeKeyDown).toBe('function')

    // defaultPrevented=true の native KeyboardEvent を渡す (dnd-kit drag cancel 模擬)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    ev.preventDefault()
    expect(ev.defaultPrevented).toBe(true)
    const pdSpy = vi.spyOn(ev, 'preventDefault')
    props.onEscapeKeyDown!(ev)
    // stage 階層 (editCategory) は維持されたまま (新 preventDefault 呼出なし)
    expect(pdSpy).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()
  })

  it('defaultPrevented=false の Esc は既存 stage 階層挙動 (editCategory → category) を維持', () => {
    popoverContentPropsSpy.mockClear()
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 分野' }))
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()

    const props = findAddPopoverProps()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    expect(ev.defaultPrevented).toBe(false)
    const pdSpy = vi.spyOn(ev, 'preventDefault')
    act(() => {
      props.onEscapeKeyDown!(ev)
    })
    // 既存挙動: editCategory → category へ戻り、 popover の preventDefault を 1 度呼ぶ
    expect(pdSpy).toHaveBeenCalled()
    // stage 1 (カテゴリリスト) に戻る → '分野' menuitem が見える
    expect(
      screen.getByRole('menuitem', { name: '分野' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Grid-1 T3: initialStage / initialCategoryId props
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — Grid-1 T3: initialStage / initialCategoryId props', () => {
  // case ①: props 未指定 = stage 'category' で open (= 既存挙動)
  it('case ①: props 未指定で open → category list が表示される (既存挙動)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // stage='category' → category list が表示される
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'レベル' })).toBeInTheDocument()
    // stage='option' の「カテゴリ選択へ戻る」 ボタンは存在しない
    expect(screen.queryByRole('button', { name: 'カテゴリ選択へ戻る' })).not.toBeInTheDocument()
  })

  // case ②: initialStage='option' + initialCategoryId='cat-1' → stage='option' + selectedCategoryId='cat-1' で open
  it('case ②: initialStage="option" + initialCategoryId="cat-1" で open → cat-1 の option list が直接表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        initialStage="option"
        initialCategoryId="cat-1"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // stage='option' で cat-1 (分野) が選択されている →「カテゴリ選択へ戻る」 が表示される
    expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
    // cat-1 の option (o1=循環器, o2=腎臓) が表示される
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '腎臓' })).toBeInTheDocument()
    // cat-2 の option は表示されない
    expect(screen.queryByRole('menuitemradio', { name: '初級' })).not.toBeInTheDocument()
  })

  // case ③: initialStage='option' + initialCategoryId=undefined → 防御 fallback = stage='category'
  it('case ③: initialStage="option" + initialCategoryId=undefined → 防御 fallback で category list が表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        initialStage="option"
        initialCategoryId={undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // fallback → stage='category' → category list が表示される
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    // stage='option' の「カテゴリ選択へ戻る」 ボタンは存在しない
    expect(screen.queryByRole('button', { name: 'カテゴリ選択へ戻る' })).not.toBeInTheDocument()
  })

  // case ④: close → 再 open で再び initial props が反映される
  it('case ④: close → 再 open で再び initialStage / initialCategoryId が反映される (option list 再表示)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        initialStage="option"
        initialCategoryId="cat-1"
      />,
    )
    // 1st open → option list 表示確認
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()

    // stage 1 に戻してから Esc で close
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // popover が閉じた → option list 消える
    expect(screen.queryByRole('menuitemcheckbox', { name: '循環器' })).not.toBeInTheDocument()

    // 2nd open → 再び initialStage='option' + initialCategoryId='cat-1' が反映される
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// S2.3 Task 9: selectOnly prop
// selectOnly=true のとき:
//   - stage1 (category): 「新規作成」 行なし / kebab なし
//   - stage2 (option): 「新規作成」 行なし / kebab なし
//   - filter (検索 input) は動作する
//   - onToggle (option 選択) は動作する
//   - selectOnly=false (default) では全既存挙動が不変
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — selectOnly=true: stage1 新規作成行・kebab 非表示', () => {
  it('selectOnly=true + stage1 open → カテゴリ一覧は表示されるが「新規作成」 行は入力後も出ない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // カテゴリ一覧は表示される
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'レベル' })).toBeInTheDocument()
    // filter input に新カテゴリ名を入力しても「新規作成」 行が出ない
    fireEvent.change(
      screen.getByRole('textbox', { name: 'カテゴリを検索' }),
      { target: { value: '新カテゴリ' } },
    )
    expect(
      screen.queryByRole('button', { name: /新規作成:/ }),
    ).not.toBeInTheDocument()
  })

  it('selectOnly=true + stage1 → kebab (カテゴリ操作) ボタンが表示されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.queryByRole('button', { name: /カテゴリ操作:/ }),
    ).not.toBeInTheDocument()
  })

  it('selectOnly=true + stage1: filter input は機能し、 マッチしたカテゴリだけ表示される', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'カテゴリを検索' }),
      { target: { value: '分野' } },
    )
    // フィルタにヒット
    expect(screen.getByRole('menuitem', { name: '分野' })).toBeInTheDocument()
    // ヒットしないカテゴリは非表示
    expect(screen.queryByRole('menuitem', { name: 'レベル' })).not.toBeInTheDocument()
  })
})

describe('CardTagAddPopover — selectOnly=true: stage2 新規作成行・kebab 非表示 + toggle 機能', () => {
  it('selectOnly=true + stage2 → 「新規作成」 行は入力後も出ない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    // option 一覧が表示される
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    // filter に存在しない名前を入力しても「新規作成」 行が出ない
    fireEvent.change(
      screen.getByRole('textbox', { name: 'タグを検索' }),
      { target: { value: '新 option' } },
    )
    expect(
      screen.queryByRole('button', { name: /新規作成:/ }),
    ).not.toBeInTheDocument()
  })

  it('selectOnly=true + stage2 → kebab (option 操作) ボタンが表示されない', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.queryByRole('button', { name: /option 操作:/ }),
    ).not.toBeInTheDocument()
  })

  it('selectOnly=true + stage2 → onToggle は正常に呼ばれる (toggle 選択が機能する)', () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={onToggle}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '循環器' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('cat-1', 'o1')
  })

  it('selectOnly=true + stage2 single → option click で onToggle が呼ばれ popover が閉じる', () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddPopover
        categories={[cat('cat-2', 'レベル', 'single')]}
        options={[opt('o3', '初級', 'cat-2'), opt('o4', '上級', 'cat-2')]}
        allAssignedOptionIds={[]}
        onToggle={onToggle}
        tagEditCallbacks={mockTagEditCallbacks}
        selectOnly
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'レベル' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '初級' }))
    expect(onToggle).toHaveBeenCalledWith('cat-2', 'o3')
    // single → popover が閉じる
    expect(
      screen.queryByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).not.toBeInTheDocument()
  })
})

describe('CardTagAddPopover — selectOnly=false (default): 既存挙動が不変', () => {
  it('selectOnly 未指定 (=false) → stage1 kebab が表示される (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByRole('button', { name: 'カテゴリ操作: 分野' }),
    ).toBeInTheDocument()
  })

  it('selectOnly 未指定 (=false) → stage1 新規作成行が出る (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
      { target: { value: '新カテゴリ' } },
    )
    expect(
      screen.getByRole('button', { name: '新規作成: 新カテゴリ' }),
    ).toBeInTheDocument()
  })

  it('selectOnly 未指定 (=false) → stage2 kebab が表示される (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    expect(
      screen.getByRole('button', { name: 'option 操作: 循環器' }),
    ).toBeInTheDocument()
  })

  it('selectOnly 未指定 (=false) → stage2 新規作成行が出る (regression)', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分野' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
      { target: { value: '新 option' } },
    )
    expect(
      screen.getByRole('button', { name: /新規作成:/ }),
    ).toBeInTheDocument()
  })
})

