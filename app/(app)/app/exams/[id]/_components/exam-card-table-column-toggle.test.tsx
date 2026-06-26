// @vitest-environment jsdom
// Edit-2 Task 4: 列表示/非表示 toggle + columnVisibility 永続化テスト。
//   - toggle off → 列の getIsVisible() false + cell/header が描画されない
//   - select 列は toggle list に出ない
//   - toggle で sync_meta に v2 (hiddenColumns 含む) が書込まれる
//   - リロード復元: sync_meta に hiddenColumns があると mount 時に列が隠れる
//   - 相互非破壊: 列 toggle が既存 view を保持する (read-modify-write)
//
// 環境: vitest + jsdom + @testing-library/react + fake-indexeddb (vitest.setup.ts global)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import {
  SYNC_META_KEYS,
  examViewPrefsSchema,
  examViewPrefsV2Schema,
  examViewPrefsToV2,
  getJsonSyncMeta,
  setJsonSyncMeta,
} from '@/lib/sync/sync-meta'

// bulk hooks の mock は不要 (toggle テストは bulk 操作を触らない) が、
// createOption mock は exam-card-table の他テストと同様に hoist しておく必要はない —
// 本テストは tag 新規作成も bulk も行わないため real 実装のまま mount できる。

import { ExamCardTable } from './exam-card-table'

const EXAM_ID = 'test-exam-coltoggle'
const USER_ID = 'test-user-coltoggle'

function makeCard(n: number): ClientCard {
  return {
    id: `card-${n}`,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    title: `Card ${n}`,
    sort_key: String(n).padStart(4, '0'),
    question_text: `Question text for card ${n}`,
    options: [],
    correct_answer_ids: [],
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
    created_at: new Date(Date.now() + n * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
  }
}

beforeEach(async () => {
  const db = getClientDb()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.sync_meta.clear()
})

afterEach(() => {
  cleanup()
})

/** popover を開いて column toggle list の checkbox を取得しやすくする helper。 */
async function openColumnToggle() {
  const trigger = screen.getByRole('button', { name: '列の表示・非表示' })
  fireEvent.click(trigger)
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: '列表示: メモ' })).toBeInTheDocument()
  })
}

describe('ColumnVisibilityToggle: 列 toggle で表示/非表示', () => {
  it('メモ列を off にすると header / cell が描画されなくなる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
    // メモ列 header が存在 (表示中)
    expect(screen.getByRole('columnheader', { name: /メモ/ })).toBeInTheDocument()

    await openColumnToggle()
    fireEvent.click(screen.getByRole('checkbox', { name: '列表示: メモ' }))

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: /メモ/ })).not.toBeInTheDocument()
    })
    // メモ列の編集 cell も消える
    expect(screen.queryByLabelText('メモ 編集')).not.toBeInTheDocument()
  })

  it('select 列は toggle list に出ない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    const trigger = screen.getByRole('button', { name: '列の表示・非表示' })
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '列表示: タイトル' })).toBeInTheDocument()
    })
    // select 列 (id 'select', header は string でない) は出ない
    expect(screen.queryByRole('checkbox', { name: /列表示: select/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '列表示: 全選択' })).not.toBeInTheDocument()
  })
})

describe('ColumnVisibilityToggle: 永続化 + 復元', () => {
  it('列 off で sync_meta に v2 (hiddenColumns) が書込まれる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    await openColumnToggle()
    fireEvent.click(screen.getByRole('checkbox', { name: '列表示: メモ' }))

    await waitFor(async () => {
      const saved = await getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema)
      expect(saved).toBeDefined()
      const v2 = examViewPrefsToV2(saved!)
      expect(v2.hiddenColumns).toContain('memo')
    })
  })

  it('mount 時 sync_meta の hiddenColumns で列が隠れる (リロード復元)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    // 事前に hiddenColumns に explanation_text を保存
    await setJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'table', hiddenColumns: ['explanation_text'] },
      examViewPrefsV2Schema,
    )

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
    // 解説列が隠れていること (load 反映)
    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: /解説/ })).not.toBeInTheDocument()
    })
    // 他列 (タイトル) は表示されている
    expect(screen.getByRole('columnheader', { name: /タイトル/ })).toBeInTheDocument()
  })
})

describe('ColumnVisibilityToggle: view ↔ hiddenColumns 相互非破壊 (HARD GATE)', () => {
  it('列 toggle 後も既存 view (card) が保持される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    // exam-detail-view が view='card' を保存した state を模す (table も同 key を共有)
    await setJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 2, view: 'card', hiddenColumns: [] },
      examViewPrefsV2Schema,
    )

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    await openColumnToggle()
    fireEvent.click(screen.getByRole('checkbox', { name: '列表示: メモ' }))

    // 列 toggle の persist は read-modify-write で view を保持するため view='card' のまま
    await waitFor(async () => {
      const saved = await getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema)
      const v2 = examViewPrefsToV2(saved!)
      expect(v2.view).toBe('card')
      expect(v2.hiddenColumns).toContain('memo')
    })
  })
})

// within import 使用 (lint no-unused 回避) — header 検証で row scope を限定する補助。
describe('ColumnVisibilityToggle: header scope', () => {
  it('toggle list はタイトル列を含む (title は toggle 可)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
    const trigger = screen.getByRole('button', { name: '列の表示・非表示' })
    fireEvent.click(trigger)
    const list = await screen.findByRole('checkbox', { name: '列表示: タイトル' })
    const popover = list.closest('[data-slot="popover-content"]') as HTMLElement
    expect(within(popover).getByRole('checkbox', { name: '列表示: タイトル' })).toBeChecked()
  })
})
