// @vitest-environment jsdom
// S2-5: ColumnVisibilityToggle unit test (controlled 化)。
// - deriveColumnToggleMeta: select 除外 / 非 string header → id fallback / enableHiding===false → 非 hideable
// - ColumnVisibilityToggle: 静的列メタ列挙 / checkbox が columnVisibility prop を反映 /
//   toggle で onColumnVisibilityChange が flip した value で呼ばれる (live table 非依存)
//
// 永続 (sync_meta write) + mount-load + view↔hiddenColumns 非破壊往復は exam-detail-view が
// 単一所有するため exam-detail-view.test.tsx で検証する (本 file は表示 + 通知のみ)。
//
// 環境: vitest + jsdom + @testing-library/react。 Dexie / ExamCardTable 非依存 (pure)。

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { ColumnDef } from '@tanstack/react-table'
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10、 './exam-card-table-columns' → inline-card-list.tsx 経由の
// transitive import)。 本 test は画像 gallery の挙動を検証しないため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import {
  ColumnVisibilityToggle,
  deriveColumnToggleMeta,
} from './exam-card-table-column-toggle'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'

afterEach(() => {
  cleanup()
})

// ===========================================================================
// deriveColumnToggleMeta — 列メタ導出 (端ケース含む)
// ===========================================================================

describe('deriveColumnToggleMeta: 列メタ導出', () => {
  it('select 列は除外される', () => {
    const meta = deriveColumnToggleMeta(examCardTableColumns)
    expect(meta.some((m) => m.id === 'select')).toBe(false)
  })

  it('string header 列は header を label にする (memo → "メモ")', () => {
    const meta = deriveColumnToggleMeta(examCardTableColumns)
    const memo = meta.find((m) => m.id === 'memo')
    expect(memo?.label).toBe('メモ')
    expect(memo?.hideable).toBe(true)
  })

  it('非 string header 列は id を label に fallback する', () => {
    const columns: ColumnDef<ExamCardRow>[] = [
      { id: 'custom', header: () => React.createElement('span', null, 'JSX') },
    ]
    const meta = deriveColumnToggleMeta(columns)
    expect(meta[0].label).toBe('custom')
  })

  it('enableHiding===false の列は hideable=false になる', () => {
    const columns: ColumnDef<ExamCardRow>[] = [
      { id: 'locked', header: 'Locked', enableHiding: false },
      { id: 'free', header: 'Free' },
    ]
    const meta = deriveColumnToggleMeta(columns)
    expect(meta.find((m) => m.id === 'locked')?.hideable).toBe(false)
    expect(meta.find((m) => m.id === 'free')?.hideable).toBe(true)
  })

  it('将来追加列 (enableHiding 未指定) は自動的に hideable=true で載る', () => {
    const columns: ColumnDef<ExamCardRow>[] = [
      { id: 'select', header: 'S' },
      { id: 'future', header: '将来列' },
    ]
    const meta = deriveColumnToggleMeta(columns)
    expect(meta.map((m) => m.id)).toEqual(['future'])
    expect(meta[0].hideable).toBe(true)
  })
})

// ===========================================================================
// ColumnVisibilityToggle — controlled 表示 + 通知
// ===========================================================================

/** popover を開いて toggle list を可視化する helper。 */
function openToggle() {
  fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))
}

describe('ColumnVisibilityToggle: 列挙 + select 除外', () => {
  it('hideable 列 (タイトル / メモ / ソートキー) が列挙され、 select は出ない', () => {
    render(
      <ColumnVisibilityToggle columnVisibility={{}} onColumnVisibilityChange={vi.fn()} />,
    )
    openToggle()

    expect(screen.getByRole('checkbox', { name: '列表示: タイトル' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '列表示: メモ' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '列表示: ソートキー' })).toBeInTheDocument()
    // select 列 (JSX header) は列挙されない
    expect(screen.queryByRole('checkbox', { name: /列表示: select/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '列表示: 全選択' })).not.toBeInTheDocument()
  })
})

describe('ColumnVisibilityToggle: checkbox が columnVisibility prop を反映', () => {
  it('columnVisibility[id]===false の列は unchecked、 それ以外は checked', () => {
    render(
      <ColumnVisibilityToggle
        columnVisibility={{ sort_key: false, memo: false }}
        onColumnVisibilityChange={vi.fn()}
      />,
    )
    openToggle()

    // hidden 列 (false) は unchecked
    expect(screen.getByRole('checkbox', { name: '列表示: ソートキー' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '列表示: メモ' })).not.toBeChecked()
    // 未指定列 (可視) は checked
    expect(screen.getByRole('checkbox', { name: '列表示: タイトル' })).toBeChecked()
  })
})

describe('ColumnVisibilityToggle: toggle で onColumnVisibilityChange が呼ばれる', () => {
  it('可視列を off → 当該 id=false を含む value で呼ばれる (他 key 保持)', () => {
    const onChange = vi.fn()
    render(
      <ColumnVisibilityToggle
        columnVisibility={{ sort_key: false }}
        onColumnVisibilityChange={onChange}
      />,
    )
    openToggle()

    // メモ (可視) を click で off
    fireEvent.click(screen.getByRole('checkbox', { name: '列表示: メモ' }))
    expect(onChange).toHaveBeenCalledWith({ sort_key: false, memo: false })
  })

  it('hidden 列を on → 当該 id=true を含む value で呼ばれる', () => {
    const onChange = vi.fn()
    render(
      <ColumnVisibilityToggle
        columnVisibility={{ sort_key: false }}
        onColumnVisibilityChange={onChange}
      />,
    )
    openToggle()

    // ソートキー (hidden) を click で on
    fireEvent.click(screen.getByRole('checkbox', { name: '列表示: ソートキー' }))
    expect(onChange).toHaveBeenCalledWith({ sort_key: true })
  })
})

describe('ColumnVisibilityToggle: popover scope', () => {
  it('toggle list はタイトル列を含む (popover 内 scope で checked)', () => {
    render(
      <ColumnVisibilityToggle columnVisibility={{}} onColumnVisibilityChange={vi.fn()} />,
    )
    openToggle()
    const list = screen.getByRole('checkbox', { name: '列表示: タイトル' })
    const popover = list.closest('[data-slot="popover-content"]') as HTMLElement
    expect(within(popover).getByRole('checkbox', { name: '列表示: タイトル' })).toBeChecked()
  })
})
