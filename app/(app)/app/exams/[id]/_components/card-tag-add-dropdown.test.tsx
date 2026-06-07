// @vitest-environment jsdom
// CardTagAddDropdown: shadcn DropdownMenu (radix-ui Menu) で 該当 category 配下の
// option を一覧化し、 click で onToggle を呼ぶ。 select_type='multi' は menu を
// 閉じず、 'single' は閉じる挙動を固定する。 また option 0 件時の placeholder +
// /app/tags へのリンクを固定する。
//
// 注: radix DropdownMenuTrigger は pointerDown / keyDown=Enter|Space|ArrowDown で
// open するが、 jsdom + fireEvent では pointerDown の挙動が安定しないため、 trigger
// に focus → fireEvent.keyDown(Enter) で開く。 内容は portal で document.body
// 配下に出るため screen.getByXxx で取得できる。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'

import type { ClientTagOption } from '@/lib/client-db'

import { CardTagAddDropdown } from './card-tag-add-dropdown'

const opt = (
  id: string,
  name: string,
  color: string | null = null,
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: 'cat-1',
  name,
  color,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
})

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'タグ追加' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

afterEach(() => {
  cleanup()
})

describe('CardTagAddDropdown — trigger', () => {
  it('「タグ追加」 trigger (aria-label) が描画される', () => {
    render(
      <CardTagAddDropdown
        categoryOptions={[opt('o1', '高', 'red')]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'タグ追加' }),
    ).toBeInTheDocument()
  })
})

describe('CardTagAddDropdown — option 一覧 (multi)', () => {
  it('categoryOptions 全件が menu item として表示される', async () => {
    render(
      <CardTagAddDropdown
        categoryOptions={[
          opt('o1', '高', 'red'),
          opt('o2', '中', 'amber'),
          opt('o3', '低', 'green'),
        ]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    openMenu()
    expect(await screen.findByText('高')).toBeInTheDocument()
    expect(screen.getByText('中')).toBeInTheDocument()
    expect(screen.getByText('低')).toBeInTheDocument()
  })

  it('selected な option には checkmark が表示される', async () => {
    render(
      <CardTagAddDropdown
        categoryOptions={[opt('o1', '高', 'red'), opt('o2', '中', 'amber')]}
        selectedOptionIds={new Set(['o1'])}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    openMenu()
    const selectedItem = await screen.findByRole('menuitem', { name: /高/ })
    const unselectedItem = screen.getByRole('menuitem', { name: /中/ })
    expect(within(selectedItem).queryByTestId('tag-check')).toBeInTheDocument()
    expect(
      within(unselectedItem).queryByTestId('tag-check'),
    ).not.toBeInTheDocument()
  })

  it('multi: menu item click で onToggle(option.id) が呼ばれる', async () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddDropdown
        categoryOptions={[opt('o1', '高', 'red')]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /高/ })
    fireEvent.click(item)
    expect(onToggle).toHaveBeenCalledWith('o1')
  })
})

describe('CardTagAddDropdown — selectType=single 挙動', () => {
  it('single: menu item click で onToggle(option.id) が呼ばれる', async () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddDropdown
        categoryOptions={[opt('o1', '高', 'red')]}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={onToggle}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /高/ })
    fireEvent.click(item)
    expect(onToggle).toHaveBeenCalledWith('o1')
  })

  // multi だと preventDefault → radix の close を阻止して menu 開きっぱなし。
  // single だと preventDefault しない → menu が閉じる。 これを onSelect の defaultPrevented
  // 状態で確認する (radix の close 動作は jsdom 上 portal cleanup 含めて
  // tester-controlled 検証が難しいため、 component 側の API 呼出を直接観測する設計)。
  it('multi: onSelect で e.preventDefault() が呼ばれる (menu 閉鎖阻止)', async () => {
    const onToggle = vi.fn()
    render(
      <CardTagAddDropdown
        categoryOptions={[opt('o1', '高', 'red')]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /高/ })
    // radix は内部で onSelect を発火する。 click 自体は onSelect を経由するため
    // preventDefault 後でも onToggle は呼ばれる。 menu が DOM から消えていない
    // ことを確認する (multi)。
    fireEvent.click(item)
    expect(onToggle).toHaveBeenCalledWith('o1')
    // multi では menu が閉じない
    expect(screen.queryByRole('menuitem', { name: /高/ })).toBeInTheDocument()
  })

  it('single: click 後に menu が閉じる', async () => {
    render(
      <CardTagAddDropdown
        categoryOptions={[opt('o1', '高', 'red')]}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={vi.fn()}
      />,
    )
    openMenu()
    const item = await screen.findByRole('menuitem', { name: /高/ })
    fireEvent.click(item)
    // single では preventDefault しない → radix が close を進める
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('menuitem', { name: /高/ }),
      ).not.toBeInTheDocument()
    })
  })
})

describe('CardTagAddDropdown — option 0 件 placeholder', () => {
  it('0 件時は placeholder 文言と /app/tags への link を出す', async () => {
    render(
      <CardTagAddDropdown
        categoryOptions={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    openMenu()
    expect(
      await screen.findByText(/このカテゴリには option がありません/),
    ).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /タグ管理/ })
    expect(link).toHaveAttribute('href', '/app/tags')
  })

  it('0 件時は menuitem を render しない', async () => {
    render(
      <CardTagAddDropdown
        categoryOptions={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    openMenu()
    // open 後でも menuitem は出ない
    await screen.findByText(/このカテゴリには option がありません/)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
})
