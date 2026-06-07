// @vitest-environment jsdom
// CardTagsSection: orchestrator + optimistic logic の unit test。
// Tag-4b-fix: Notion 方式 popover UI に合わせて全面書き直し。
// - 旧テスト: 見出し横「タグ管理 →」 link、 全カテゴリ row、 placeholder 表示を pin
// - 新テスト: バッジ iterate、 × click optimistic、 whole-set 不変条件、 buildNextTagSet 純粋関数

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type {
  ClientTagCategory,
  ClientTagOption,
  ClientCardTag,
} from '@/lib/client-db'

// ---------------------------------------------------------------------------
// モック: IDB + sync (render 前に定義)
// ---------------------------------------------------------------------------

const mockDelete = vi.fn(async () => undefined)
const mockPut = vi.fn(async () => undefined)
// Dexie の `db.transaction(mode, table1, ..., tableN, cb)` は cb が最終引数。
// Tag-4b-fix で card_tags + entity_mutations の 2 table を渡す多引数形に変更したため、
// mock は variadic で受けて末尾を cb として実行する。
const mockTransaction = vi.fn(async (...args: unknown[]) => {
  const cb = args[args.length - 1] as () => Promise<void>
  await cb()
})

vi.mock('@/lib/client-db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-db')>('@/lib/client-db')
  return {
    ...actual,
    getClientDb: vi.fn(() => ({
      transaction: mockTransaction,
      card_tags: { delete: mockDelete, put: mockPut },
      // entity_mutations は実 op をモジュールレベルで mock 済 (enqueueEntityMutation)
      // のため空 object で十分 (`db.transaction(...)` が table 参照のために touch する
      // だけで、 実際の query は走らない)。
      entity_mutations: {},
    })),
  }
})

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: vi.fn(async () => ({}) as never),
}))

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: vi.fn(async () => 'no-pending' as const),
}))

import { CardTagsSection, buildNextTagSet } from './card-tags-section'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const cat = (
  id: string,
  name: string,
  selectType: 'single' | 'multi' = 'multi',
  createdAt: string = '2026-06-01T00:00:00.000Z',
): ClientTagCategory => ({
  id,
  user_id: 'user-1',
  name,
  select_type: selectType,
  color: null,
  sort_key: null,
  created_at: createdAt,
  updated_at: createdAt,
})

const opt = (
  id: string,
  categoryId: string,
  name: string,
  createdAt: string = '2026-06-01T00:00:00.000Z',
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: categoryId,
  name,
  color: null,
  sort_key: null,
  created_at: createdAt,
  updated_at: createdAt,
})

const tag = (cardId: string, optionId: string): ClientCardTag => ({
  card_id: cardId,
  option_id: optionId,
  user_id: 'user-1',
  created_at: '2026-06-01T00:00:00.000Z',
})

// ---------------------------------------------------------------------------
// テスト前後の共通処理
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// Section 1: buildNextTagSet 純粋関数ユニットテスト
// ===========================================================================

describe('buildNextTagSet — multi カテゴリ', () => {
  it('未付与 option を toggle → toAdd に追加される', () => {
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1']
    const sameCat = new Set(['o1', 'o2', 'o3'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o2')
    expect(result.toAdd).toContain('o2')
    expect(result.toRemove).toHaveLength(0)
    expect(result.next).toEqual(expect.arrayContaining(['o1', 'o2']))
  })

  it('付与済み option を toggle → toRemove に追加される', () => {
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1', 'o2']
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o1')
    expect(result.toRemove).toContain('o1')
    expect(result.toAdd).toHaveLength(0)
    expect(result.next).toEqual(['o2'])
  })

  it('multi: 他カテゴリの option_id は next に残る (whole-set 不変条件)', () => {
    // catA に o1 (assigned)、 catB に o3 (assigned)。 catA の o1 を外しても o3 は残る。
    const category = { select_type: 'multi' as const }
    const allAssigned = ['o1', 'o3'] // o1 は catA、 o3 は catB
    const sameCatA = new Set(['o1', 'o2']) // catA のみ
    const result = buildNextTagSet(category, allAssigned, sameCatA, 'o1')
    expect(result.next).toContain('o3') // catB の option は保持
    expect(result.next).not.toContain('o1') // catA の option は削除
  })
})

describe('buildNextTagSet — single カテゴリ', () => {
  it('未付与 option を toggle → 同カテゴリ既存を削除して新規追加', () => {
    const category = { select_type: 'single' as const }
    const allAssigned = ['o1'] // o1 は同カテゴリの既存選択
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o2')
    expect(result.toAdd).toContain('o2')
    expect(result.toRemove).toContain('o1')
    expect(result.next).toEqual(['o2'])
  })

  it('single: 既付与 option を再 toggle → 0 個に戻る (0 個許容)', () => {
    const category = { select_type: 'single' as const }
    const allAssigned = ['o1']
    const sameCat = new Set(['o1', 'o2'])
    const result = buildNextTagSet(category, allAssigned, sameCat, 'o1')
    expect(result.toRemove).toContain('o1')
    expect(result.toAdd).toHaveLength(0)
    // 同カテゴリ内は 0 個
    const catOptions = ['o1', 'o2']
    const catNext = result.next.filter((id) => catOptions.includes(id))
    expect(catNext).toHaveLength(0)
  })

  it('single: 他カテゴリの option_id は next に残る (whole-set 不変条件)', () => {
    const category = { select_type: 'single' as const }
    const allAssigned = ['o1', 'o3'] // o1 は catA、 o3 は catB
    const sameCatA = new Set(['o1', 'o2']) // catA のみ
    const result = buildNextTagSet(category, allAssigned, sameCatA, 'o2')
    expect(result.next).toContain('o3') // catB の option は保持
    expect(result.next).toContain('o2') // catA は o2 に入れ替わり
    expect(result.next).not.toContain('o1') // catA の o1 は削除
  })
})

// ===========================================================================
// Section 2: 描画テスト
// ===========================================================================

describe('CardTagsSection — 見出し「タグ」', () => {
  it('h3「タグ」 を表示する', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[]}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(screen.getByText('タグ')).toBeInTheDocument()
  })

  it('見出し横に「タグ管理 →」 link は render されない (popover footer のみ)', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野')]}
        options={[]}
        cardTags={[]}
      />,
    )
    // popover が閉じた状態では heading 横の link は存在しない
    expect(
      screen.queryByRole('link', { name: /タグ管理/ }),
    ).not.toBeInTheDocument()
  })
})

describe('CardTagsSection — cardTags なし', () => {
  it('cardTags が 0 件のとき バッジは render されない', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野')]}
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[]}
      />,
    )
    // バッジ (タグ: ...) は存在しない
    expect(
      screen.queryByRole('button', { name: /^タグ: / }),
    ).not.toBeInTheDocument()
  })

  it('cardTags が 0 件のとき 「+ タグを追加」 button が表示される', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[]}
        options={[]}
        cardTags={[]}
      />,
    )
    expect(screen.getByRole('button', { name: 'タグを追加' })).toBeInTheDocument()
  })
})

describe('CardTagsSection — cardTags あり: バッジ render', () => {
  it('cardTag があるとき「タグ: {カテゴリ}: {option}」 バッジを render する', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野')]}
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[tag('card-1', 'o1')]}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'タグ: 分野: 循環器' }),
    ).toBeInTheDocument()
  })

  it('複数 cardTag がある場合、 複数バッジを render する', () => {
    const categories = [
      cat('c1', '分野'),
      cat('c2', '難易度', 'single'),
    ]
    const options = [
      opt('o1', 'c1', '循環器'),
      opt('o2', 'c2', '高'),
    ]
    const cardTags = [tag('card-1', 'o1'), tag('card-1', 'o2')]
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={categories}
        options={options}
        cardTags={cardTags}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'タグ: 分野: 循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'タグ: 難易度: 高' }),
    ).toBeInTheDocument()
  })

  it('存在しない option_id の cardTag は skip される (stale tag defensive)', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野')]}
        options={[]} // option が削除済み
        cardTags={[tag('card-1', 'o1')]} // stale tag
      />,
    )
    // バッジは render されない
    expect(
      screen.queryByRole('button', { name: /^タグ: / }),
    ).not.toBeInTheDocument()
  })

  it('存在しない category_id の option の cardTag は skip される (stale category defensive)', () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[]} // category が削除済み
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[tag('card-1', 'o1')]}
      />,
    )
    expect(
      screen.queryByRole('button', { name: /^タグ: / }),
    ).not.toBeInTheDocument()
  })
})

// ===========================================================================
// Section 3: optimistic 更新テスト (× button click)
// ===========================================================================

describe('CardTagsSection — × click optimistic remove', () => {
  it('バッジ × click で db.card_tags.delete が呼ばれる', async () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野', 'multi')]}
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[tag('card-1', 'o1')]}
      />,
    )

    const removeBtn = screen.getByRole('button', { name: 'タグ削除: 分野: 循環器' })
    fireEvent.click(removeBtn)

    // flush を待つため microtask を消化
    await vi.waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(['card-1', 'o1'])
    })
  })

  it('バッジ × click で enqueueEntityMutation が呼ばれ、 value が空配列になる', async () => {
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野', 'multi')]}
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[tag('card-1', 'o1')]}
      />,
    )

    const removeBtn = screen.getByRole('button', { name: 'タグ削除: 分野: 循環器' })
    fireEvent.click(removeBtn)

    await vi.waitFor(() => {
      expect(enqueueEntityMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ value: [] }),
        }),
      )
    })
  })

  it('whole-set 不変条件: 他カテゴリの option_id は enqueue の value に残る', async () => {
    // catA に o1 (assigned)、 catB に o3 (assigned)。 o1 を × で削除しても o3 は残る。
    const categories = [
      cat('c1', '分野', 'multi'),
      cat('c2', '難易度', 'single'),
    ]
    const options = [
      opt('o1', 'c1', '循環器'),
      opt('o3', 'c2', '高'),
    ]
    const cardTags = [tag('card-1', 'o1'), tag('card-1', 'o3')]

    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={categories}
        options={options}
        cardTags={cardTags}
      />,
    )

    const removeBtn = screen.getByRole('button', { name: 'タグ削除: 分野: 循環器' })
    fireEvent.click(removeBtn)

    await vi.waitFor(() => {
      expect(enqueueEntityMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({
            value: expect.arrayContaining(['o3']), // catB の option は残る
          }),
        }),
      )
    })

    // catA の o1 は next に含まれない
    const call = (enqueueEntityMutation as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.patch.value).not.toContain('o1')
  })
})

// ===========================================================================
// Section 4: React.memo export 確認
// ===========================================================================

describe('CardTagsSection — export', () => {
  it('CardTagsSection は React.memo でラップされた component である', () => {
    // memo でラップされた component は $$typeof が Symbol(react.memo)
    const { $$typeof } = CardTagsSection as unknown as { $$typeof: symbol }
    // react.memo の Symbol は環境依存だが、 プロパティ名で判定
    expect(String($$typeof)).toContain('memo')
  })
})

// ===========================================================================
// Section 5: atomic tx + JWT-derived user_id (Tag-4b-fix codex review #1/#2)
// ===========================================================================

import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

describe('CardTagsSection — optimistic atomic tx + user_id', () => {
  it('optimistic put の user_id に prop の userId (JWT 由来) が入り空文字ではない', async () => {
    // codex review #2 に対する contract pin。 multi カテゴリで未付与 o2 を edit
    // popover 経由で click → handleToggle の add 経路が card_tags.put({user_id: 'user-1'})
    // を呼ぶことを確認。 空文字汚染 (将来の user_id index 経路) を構造的に防ぐ。
    const categories = [cat('c1', '分野', 'multi')]
    const options = [opt('o1', 'c1', '循環器'), opt('o2', 'c1', '腎')]
    const cardTags = [tag('card-1', 'o1')]

    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={categories}
        options={options}
        cardTags={cardTags}
      />,
    )

    // バッジ click で edit popover open
    const badge = screen.getByRole('button', { name: 'タグ: 分野: 循環器' })
    fireEvent.click(badge)

    // popover 内の未付与 option 「腎」 を click → handleToggle add 経路
    const optionItem = await screen.findByRole('menuitemcheckbox', { name: '腎' })
    fireEvent.click(optionItem)

    await vi.waitFor(() => {
      expect(mockPut).toHaveBeenCalled()
    })

    // put 引数の user_id が prop の userId ('user-1') と一致 (空文字汚染なし)
    const callArg = (mockPut as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      user_id: string
    }
    expect(callArg.user_id).toBe('user-1')
    expect(callArg.user_id).not.toBe('')
  })

  it('atomic tx: db.transaction は card_tags と entity_mutations の両方を rw lock する', async () => {
    // codex review #1 に対する構造的保証。 mirror put/delete と outbox enqueue が
    // 同一 Dexie tx に寄せられている (= enqueue 失敗で mirror auto-rollback) ことを
    // mock transaction の引数で確認する。
    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野', 'multi')]}
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[tag('card-1', 'o1')]}
      />,
    )

    const removeBtn = screen.getByRole('button', { name: 'タグ削除: 分野: 循環器' })
    fireEvent.click(removeBtn)

    await vi.waitFor(() => {
      expect(mockTransaction).toHaveBeenCalled()
    })

    // 最初の transaction call の引数: (mode, table1, table2, ..., cb)
    const firstCall = mockTransaction.mock.calls[0]
    expect(firstCall[0]).toBe('rw')
    // 中間引数 (tables) に card_tags と entity_mutations の両方の table object 参照が含まれる
    const tableArgs = firstCall.slice(1, -1) // 最後の cb を除く
    const db = (getClientDb as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      card_tags: unknown
      entity_mutations: unknown
    }
    expect(tableArgs).toContain(db.card_tags)
    expect(tableArgs).toContain(db.entity_mutations)
  })

  it('atomic tx: enqueue が throw すると flush は呼ばれない (rollback path)', async () => {
    // codex review #1 fix の挙動契約: enqueue 失敗時は Dexie tx auto-rollback で
    // mirror も巻き戻り、 flush も skip される。 「UI 更新 + outbox 無」 の inconsistent
    // 状態を構造的に排除した証拠。
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )

    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={[cat('c1', '分野', 'multi')]}
        options={[opt('o1', 'c1', '循環器')]}
        cardTags={[tag('card-1', 'o1')]}
      />,
    )

    const removeBtn = screen.getByRole('button', { name: 'タグ削除: 分野: 循環器' })
    fireEvent.click(removeBtn)

    // tx が呼ばれ、 enqueue が reject し、 catch で return する完了を待つ
    await vi.waitFor(() => {
      expect(enqueueEntityMutation).toHaveBeenCalled()
    })

    // flush は tx 外の void 経路で、 try-catch が return するため呼ばれない
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })
})

// getClientDb mock を Section 5 で参照するため import (Section 1-4 は不要)
import { getClientDb } from '@/lib/client-db'
