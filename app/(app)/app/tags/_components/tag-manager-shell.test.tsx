// @vitest-environment jsdom
// TagManagerShell client component の test。 tag manager の最上位 Client。
// - 責務は (a) activeCategoryId state を保持し CategoryList / OptionList に伝播
//   (b) desktop = CSS grid 2 列、 mobile = Tabs で 1 active 切替
//   (c) カテゴリ選択時に mobile tab を 'options' に自動切替
// - 子 (CategoryList / OptionList) は mock し、 shell の責務のみを test する。
//   Dexie / enqueue 系を再 test しないことで test を疎結合に保つ。

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
} from '@testing-library/react'

// 子 component を mock。 渡された props を data-* で書き出し、 ボタン操作で
// onSelectCategory を発火させて shell の state 遷移を確認する。
vi.mock('./category-list', () => ({
  CategoryList: ({
    userId,
    activeCategoryId,
    onSelectCategory,
  }: {
    userId: string
    activeCategoryId: string | null
    onSelectCategory: (id: string | null) => void
  }) => (
    <div
      data-testid="mock-category-list"
      data-active={activeCategoryId ?? 'null'}
      data-user-id={userId}
    >
      <button
        type="button"
        onClick={() => onSelectCategory('cat-x')}
      >
        select cat-x
      </button>
      <button
        type="button"
        onClick={() => onSelectCategory(null)}
      >
        deselect
      </button>
    </div>
  ),
}))

vi.mock('./option-list', () => ({
  OptionList: ({
    userId,
    activeCategoryId,
  }: {
    userId: string
    activeCategoryId: string | null
  }) => (
    <div
      data-testid="mock-option-list"
      data-active={activeCategoryId ?? 'null'}
      data-user-id={userId}
    />
  ),
}))

import { TagManagerShell } from './tag-manager-shell'

// Sync-fix-1 T2b: shell は server で解決した userId を CategoryList / OptionList に thread。
// 本 test では mock 子に対する pass-through なので値は使われないが、 props 必須なので fixture 化。
const USER_ID = 'user-1'

afterEach(() => {
  cleanup()
})

describe('TagManagerShell — layout 切替 (desktop / mobile)', () => {
  it('desktop wrapper は hidden md:grid、 mobile wrapper は md:hidden を class に持つ', () => {
    const { container } = render(<TagManagerShell userId={USER_ID} />)

    // desktop grid wrapper (`md:grid-cols-3` で 1/3 + 2/3 layout)
    const desktopWrapper = container.querySelector('[class*="md:grid"]')
    expect(desktopWrapper).not.toBeNull()
    expect(desktopWrapper!.className).toContain('hidden')
    expect(desktopWrapper!.className).toContain('md:grid-cols-3')

    // mobile wrapper (md 以下のみ表示)
    const mobileWrapper = container.querySelector('[class*="md:hidden"]')
    expect(mobileWrapper).not.toBeNull()
  })

  // Radix Tabs は inactive TabsContent を unmount するため、 mobile 側は active な
  // tab の component のみ DOM に存在する。 初期 tab=categories なので CategoryList は
  // desktop+mobile=2、 OptionList は desktop のみ=1。
  it('CategoryList は desktop + mobile (active tab) の 2 回、 OptionList は desktop のみ 1 回 mount される', () => {
    render(<TagManagerShell userId={USER_ID} />)
    expect(screen.getAllByTestId('mock-category-list')).toHaveLength(2)
    expect(screen.getAllByTestId('mock-option-list')).toHaveLength(1)
  })
})

describe('TagManagerShell — activeCategoryId state 配線', () => {
  it('初期は activeCategoryId=null が両 list に伝播', () => {
    render(<TagManagerShell userId={USER_ID} />)
    const cats = screen.getAllByTestId('mock-category-list')
    const opts = screen.getAllByTestId('mock-option-list')
    for (const el of cats) expect(el.dataset.active).toBe('null')
    for (const el of opts) expect(el.dataset.active).toBe('null')
  })

  it('CategoryList の onSelectCategory("cat-x") 発火 → 両 list に伝播', () => {
    render(<TagManagerShell userId={USER_ID} />)
    // desktop 版 mock の button を 1 個 click すれば state は両系に反映する
    fireEvent.click(screen.getAllByRole('button', { name: 'select cat-x' })[0])

    const cats = screen.getAllByTestId('mock-category-list')
    const opts = screen.getAllByTestId('mock-option-list')
    for (const el of cats) expect(el.dataset.active).toBe('cat-x')
    for (const el of opts) expect(el.dataset.active).toBe('cat-x')
  })

  it('onSelectCategory(null) で active が解除される', () => {
    render(<TagManagerShell userId={USER_ID} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'select cat-x' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'deselect' })[0])

    const cats = screen.getAllByTestId('mock-category-list')
    for (const el of cats) expect(el.dataset.active).toBe('null')
  })
})

describe('TagManagerShell — mobile tab 自動切替', () => {
  it('初期 tab は categories (categories tab content が active 表示)', () => {
    render(<TagManagerShell userId={USER_ID} />)
    const categoriesTab = screen.getByRole('tab', { name: 'カテゴリ' })
    expect(categoriesTab).toHaveAttribute('data-state', 'active')
  })

  it('mobile 側 CategoryList で id 選択 → options tab に自動遷移', () => {
    render(<TagManagerShell userId={USER_ID} />)
    // mobile 版の CategoryList mock button (2 つあるうちの 2 個目 = mobile 側) を click
    const selectButtons = screen.getAllByRole('button', { name: 'select cat-x' })
    expect(selectButtons.length).toBe(2)
    fireEvent.click(selectButtons[1])

    const optionsTab = screen.getByRole('tab', { name: 'option' })
    expect(optionsTab).toHaveAttribute('data-state', 'active')
  })

  it('onSelectCategory(null) では tab は遷移しない (categories のまま)', () => {
    render(<TagManagerShell userId={USER_ID} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'deselect' })[1])

    const categoriesTab = screen.getByRole('tab', { name: 'カテゴリ' })
    expect(categoriesTab).toHaveAttribute('data-state', 'active')
  })
})

describe('TagManagerShell — タイトル表示', () => {
  it('h1 「タグ管理」 を render する', () => {
    render(<TagManagerShell userId={USER_ID} />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'タグ管理' }),
    ).toBeInTheDocument()
  })
})

// Sync-fix-1 T2b: userId は server (tags/page.tsx) で解決し shell → CategoryList /
// OptionList → CreateForm まで thread される。 shell 層で値が両子に伝播することを pin。
describe('TagManagerShell — userId 配線 (sync-fix-1 T2b)', () => {
  it('userId prop が CategoryList と OptionList の両方 (desktop + mobile) に伝播する', () => {
    render(<TagManagerShell userId={USER_ID} />)
    const cats = screen.getAllByTestId('mock-category-list')
    const opts = screen.getAllByTestId('mock-option-list')
    for (const el of cats) expect(el.dataset.userId).toBe(USER_ID)
    for (const el of opts) expect(el.dataset.userId).toBe(USER_ID)
  })
})
