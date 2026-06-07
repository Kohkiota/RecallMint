// @vitest-environment jsdom
// CardTagAddPopover: 2 stage popover (カテゴリ選択 → option 選択) の各シナリオを
// pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 4 にて新規追加された追加用 popover component のテスト。
// Tag-4c-1 Task 3: stage 拡張 (editCategory / editOption) + kebab + Esc 階層テスト追加。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { TagEditCallbacks } from './card-tags-section'

import { CardTagAddPopover, sortByKeyThenCreated } from './card-tag-add-popover'

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
    expect(screen.queryByRole('menuitem', { name: /カテゴリ: 分野/ })).not.toBeInTheDocument()
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
      screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'カテゴリ: レベル (単一選択)' }),
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
    expect(names[0]).toBe('カテゴリ: 先カテゴリ (複数選択)')
    expect(names[1]).toBe('カテゴリ: 後カテゴリ (単一選択)')
  })
})

// ---------------------------------------------------------------------------
// 4. stage 1: 型アイコン (CheckSquare for multi / Circle for single)
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 型アイコン', () => {
  it('multi カテゴリ行には CheckSquare アイコンが含まれる (aria-label で確認)', () => {
    render(
      <CardTagAddPopover
        categories={[cat('cat-m', '多択', 'multi')]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    // data-testid で検証
    expect(screen.getByTestId('type-icon-multi-cat-m')).toBeInTheDocument()
  })

  it('single カテゴリ行には Circle アイコンが含まれる', () => {
    render(
      <CardTagAddPopover
        categories={[cat('cat-s', '単択', 'single')]}
        options={[]}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
        tagEditCallbacks={mockTagEditCallbacks}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(screen.getByTestId('type-icon-single-cat-s')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 5. stage 1: カテゴリ 0 件 → placeholder + /app/tags link
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — stage 1 カテゴリ 0 件', () => {
  it('カテゴリ 0 件のとき placeholder テキストが表示される', () => {
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
      screen.getByText(/カテゴリがありません/),
    ).toBeInTheDocument()
  })

  it('カテゴリ 0 件のとき「タグ管理 →」 link が /app/tags に向く', () => {
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
    const link = screen.getByRole('link', { name: 'タグ管理 →' })
    expect(link).toHaveAttribute('href', '/app/tags')
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
    // 戻る
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    // カテゴリリストが再表示される
    expect(
      screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
    // stage 2 の Esc → onEscapeKeyDown が e.preventDefault() して stage に戻す
    const backBtn = screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })
    fireEvent.keyDown(backBtn.closest('[data-radix-popper-content-wrapper]') ?? document.body, {
      key: 'Escape',
    })
    // stage 1 に戻っている → カテゴリリストが見える
    expect(
      screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
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
      screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
    ).toBeInTheDocument()
    // stage 1 Esc → shadcn が popover を閉じる
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // popover が閉じる → カテゴリリストが消える
    expect(
      screen.queryByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
    expect(
      screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }),
    ).toBeInTheDocument()

    // Esc で close (stage 2 の Esc は stage 1 に戻るだけなので、 stage 1 に戻してから close)
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(
      screen.queryByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
    ).not.toBeInTheDocument()

    // 再 open → stage 1 から
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(
      screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }),
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: レベル (単一選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
  it('option 0 件のとき「このカテゴリには option がありません」 が表示される', () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 空カテゴリ (複数選択)' }))
    expect(
      screen.getByText('このカテゴリには option がありません'),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 15. footer「タグ管理 →」 link の表示ルール
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — footer タグ管理 link', () => {
  it('stage 1 + カテゴリ ≥1 件のとき footer に「タグ管理 →」 link がある', () => {
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
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links.length).toBeGreaterThanOrEqual(1)
    expect(links[0]).toHaveAttribute('href', '/app/tags')
  })

  it('stage 1 + カテゴリ 0 件のとき footer は非表示 (placeholder の link のみ)', () => {
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
    // placeholder 内の link が 1 つだけ (footer は非表示)
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links).toHaveLength(1)
  })

  it('stage 2 + option ≥1 件のとき footer に「タグ管理 →」 link がある', () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links.length).toBeGreaterThanOrEqual(1)
    expect(links[0]).toHaveAttribute('href', '/app/tags')
  })

  it('stage 2 + option 0 件のとき footer は非表示 (CardTagOptionList の placeholder link のみ)', () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 空 (複数選択)' }))
    // CardTagOptionList placeholder の link が 1 つだけ (footer は非表示)
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links).toHaveLength(1)
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
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
    expect(screen.queryByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' })).not.toBeInTheDocument()

    // 再 open → stage=category から (edit input なし)
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    expect(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'カテゴリ名 編集' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 23. footer link は edit stages でも表示される
// ---------------------------------------------------------------------------

describe('CardTagAddPopover — footer link in edit stages', () => {
  it('editCategory stage でも footer に「タグ管理 →」 link がある', () => {
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
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links.length).toBeGreaterThanOrEqual(1)
    expect(links[0]).toHaveAttribute('href', '/app/tags')
  })

  it('editOption stage でも footer に「タグ管理 →」 link がある', () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 分野 (複数選択)' }))
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 循環器' }))
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links.length).toBeGreaterThanOrEqual(1)
    expect(links[0]).toHaveAttribute('href', '/app/tags')
  })
})

// ---------------------------------------------------------------------------
// Fix C-3: sortByKeyThenCreated 純粋関数ユニットテスト
// ---------------------------------------------------------------------------

describe('sortByKeyThenCreated', () => {
  type Item = { sort_key: string | null; created_at: string }
  const mk = (sort_key: string | null, created_at: string): Item => ({ sort_key, created_at })

  it('両方 sort_key 非 null: sort_key ASC で並ぶ', () => {
    const a = mk('b', '2026-01-01T00:00:00.000Z')
    const b = mk('a', '2026-01-01T00:00:00.000Z')
    expect(sortByKeyThenCreated(a, b)).toBeGreaterThan(0) // a > b (b comes first)
    expect(sortByKeyThenCreated(b, a)).toBeLessThan(0)   // b < a
  })

  it('sort_key null は末尾 (NULLS LAST): non-null が先', () => {
    const withKey = mk('a', '2026-01-01T00:00:00.000Z')
    const withoutKey = mk(null, '2025-01-01T00:00:00.000Z') // 古い created_at でも後
    expect(sortByKeyThenCreated(withKey, withoutKey)).toBeLessThan(0)
    expect(sortByKeyThenCreated(withoutKey, withKey)).toBeGreaterThan(0)
  })

  it('両方 sort_key null: created_at ASC でタイブレーク', () => {
    const older = mk(null, '2026-01-01T00:00:00.000Z')
    const newer = mk(null, '2026-12-31T00:00:00.000Z')
    expect(sortByKeyThenCreated(older, newer)).toBeLessThan(0)
    expect(sortByKeyThenCreated(newer, older)).toBeGreaterThan(0)
  })

  it('同 sort_key + 同 created_at → 0 (等価)', () => {
    const a = mk('x', '2026-06-01T00:00:00.000Z')
    const b = mk('x', '2026-06-01T00:00:00.000Z')
    expect(sortByKeyThenCreated(a, b)).toBe(0)
  })
})
