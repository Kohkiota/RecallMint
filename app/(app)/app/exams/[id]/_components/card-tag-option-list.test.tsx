// @vitest-environment jsdom
// CardTagOptionList: multi/single 切替 + 0 件 placeholder + onClose callback の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 2 にて新規追加された共通 sub-component のテスト。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagOption } from '@/lib/client-db'

import { CardTagOptionList } from './card-tag-option-list'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const opt = (
  id: string,
  name: string,
  color?: string | null,
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: 'cat-1',
  name,
  color: color ?? null,
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
})

const OPTIONS = [
  opt('o1', '循環器', 'red'),
  opt('o2', '腎臓', 'blue'),
  opt('o3', '神経', null),
]

// ---------------------------------------------------------------------------
// 1. 各 option のボタンを name で render する
// ---------------------------------------------------------------------------

describe('CardTagOptionList — option rendering', () => {
  it('各 option の name が aria-label を持つ menuitemcheckbox として表示される (multi)', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: '循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemcheckbox', { name: '腎臓' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemcheckbox', { name: '神経' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 2. Check アイコンは selectedOptionIds に含まれる option のみ表示
// ---------------------------------------------------------------------------

describe('CardTagOptionList — selected state', () => {
  it('selectedOptionIds に含まれる option だけ Check icon (aria-label) を表示する', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    // o1 が選択済み → Check が存在する
    expect(screen.getByTestId('check-o1')).toBeInTheDocument()
    // o2, o3 は未選択 → Check なし
    expect(screen.queryByTestId('check-o2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('check-o3')).not.toBeInTheDocument()
  })

  it('未選択の option に Check が表示されない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    OPTIONS.forEach((o) => {
      expect(screen.queryByTestId(`check-${o.id}`)).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// 3. multi: toggle のみ、 onClose は呼ばれない
// ---------------------------------------------------------------------------

describe('CardTagOptionList — multi selectType', () => {
  it('option click で onToggle が正しい id で 1 回呼ばれる', () => {
    const onToggle = vi.fn()
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o2')
  })

  it('multi: option click では onClose は呼ばれない', () => {
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '循環器' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('multi option は role="menuitemcheckbox" を持つ', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-checked', 'true')
  })

  it('multi: 未選択 option の aria-checked は false', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(btn).toHaveAttribute('aria-checked', 'false')
  })
})

// ---------------------------------------------------------------------------
// 4. single: toggle + onClose 両方呼ばれる
// ---------------------------------------------------------------------------

describe('CardTagOptionList — single selectType', () => {
  it('option click で onToggle と onClose が 1 回ずつ呼ばれる', () => {
    const onToggle = vi.fn()
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={onToggle}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: '神経' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o3')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('single: onClose なし props でも onToggle は呼ばれ crash しない', () => {
    const onToggle = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: '循環器' }))
    expect(onToggle).toHaveBeenCalledWith('o1')
  })

  it('single option は role="menuitemradio" を持つ', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o2'])}
        selectType="single"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemradio', { name: '腎臓' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-checked', 'true')
  })

  it('single: 未選択 option の aria-checked は false', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemradio', { name: '循環器' })
    expect(btn).toHaveAttribute('aria-checked', 'false')
  })
})

// ---------------------------------------------------------------------------
// 5. 0 件 placeholder + tag manager link
// ---------------------------------------------------------------------------

describe('CardTagOptionList — 0 件 placeholder', () => {
  it('options が空のとき placeholder テキストを表示する', () => {
    render(
      <CardTagOptionList
        options={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.getByText('このカテゴリには option がありません'),
    ).toBeInTheDocument()
  })

  it('options が空のとき「タグ管理 →」 link が /app/tags に向く', () => {
    render(
      <CardTagOptionList
        options={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const link = screen.getByRole('link', { name: 'タグ管理 →' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/app/tags')
  })

  it('options が 1 件以上のとき placeholder を表示しない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.queryByText('このカテゴリには option がありません'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 6. onRowAction prop: kebab span の render
// ---------------------------------------------------------------------------

describe('CardTagOptionList — onRowAction kebab', () => {
  it('onRowAction が渡されると各 row に kebab button が表示される', () => {
    const onRowAction = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onRowAction={onRowAction}
      />,
    )
    // 各 option row に kebab (aria-label: 「option 操作: <name>」)
    expect(screen.getByRole('button', { name: 'option 操作: 循環器' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 腎臓' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 神経' })).toBeInTheDocument()
  })

  it('kebab click で onRowAction が optionId で呼ばれる', () => {
    const onRowAction = vi.fn()
    const onToggle = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onRowAction={onRowAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 腎臓' }))
    expect(onRowAction).toHaveBeenCalledWith('o2')
    // onToggle は呼ばれない (stopPropagation 動作確認)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('onRowAction なし (省略) のとき kebab は表示されない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /option 操作:/ })).not.toBeInTheDocument()
  })
})
