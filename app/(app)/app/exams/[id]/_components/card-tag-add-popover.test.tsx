// @vitest-environment jsdom
// CardTagAddPopover: 2 stage popover (カテゴリ選択 → option 選択) の各シナリオを
// pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 4 にて新規追加された追加用 popover component のテスト。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'

import { CardTagAddPopover } from './card-tag-add-popover'

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
      />,
    )
    expect(
      screen.getByRole('button', { name: 'タグを追加' }),
    ).toBeInTheDocument()
  })

  it('trigger button に「タグを追加」 テキストが含まれる', () => {
    render(
      <CardTagAddPopover
        categories={CATEGORIES}
        options={OPTIONS}
        allAssignedOptionIds={[]}
        onToggle={vi.fn()}
      />,
    )
    expect(screen.getByText('タグを追加')).toBeInTheDocument()
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
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグを追加' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'カテゴリ: 空 (複数選択)' }))
    // CardTagOptionList placeholder の link が 1 つだけ (footer は非表示)
    const links = screen.getAllByRole('link', { name: 'タグ管理 →' })
    expect(links).toHaveLength(1)
  })
})
