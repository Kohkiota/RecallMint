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

// ---------------------------------------------------------------------------
// Tag-4c-1: tag_categories / tag_options mock
// ---------------------------------------------------------------------------

const mockTagCategoriesGet = vi.fn(async () => undefined as unknown)
const mockTagCategoriesUpdate = vi.fn(async () => 1)
const mockTagCategoriesDelete = vi.fn(async () => undefined)
// Tag-4c-2a: handleCreateCategory が呼ぶ put (default mock; 個別テストで vi.fn 差替も可能)
const mockTagCategoriesPutDefault = vi.fn(async () => undefined)
// Fix A-2: handleRenameCategory が全件 check に使う toArray
const mockTagCategoriesToArray = vi.fn(async () => [] as unknown[])

const mockTagOptionsGet = vi.fn(async () => undefined as unknown)
const mockTagOptionsUpdate = vi.fn(async () => 1)
const mockTagOptionsDelete = vi.fn(async () => undefined)
// Tag-4c-2a: handleCreateOptionAndAssign が呼ぶ put (default mock)
const mockTagOptionsPutDefault = vi.fn(async () => undefined)

// チェーン可能な where mock 生成ヘルパー
// db.tag_options.where('category_id').equals(id).toArray() / .delete()
// db.card_tags.where('option_id').equals(id).count() / .delete()
// db.card_tags.where('option_id').anyOf(ids).delete()
const makeWhereChain = (returns: unknown[] | number) => ({
  equals: vi.fn(() => ({
    toArray: vi.fn(async () => (Array.isArray(returns) ? returns : [])),
    delete: vi.fn(async () => (Array.isArray(returns) ? returns.length : 0)),
    count: vi.fn(async () => (typeof returns === 'number' ? returns : (Array.isArray(returns) ? returns.length : 0))),
  })),
  anyOf: vi.fn(() => ({
    delete: vi.fn(async () => (Array.isArray(returns) ? returns.length : 0)),
  })),
})

// 各 where call に返り値を設定するため、 テストで mockTagOptionsWhereImpl 等を差し替える
let tagOptionsWhereImpl = () => makeWhereChain([])
let tagCategoriesWhereImpl = () => makeWhereChain([])
let cardTagsWhereImpl = () => makeWhereChain([])

const mockTagOptionsWhere = vi.fn(() => tagOptionsWhereImpl())
const mockTagCategoriesWhere = vi.fn(() => tagCategoriesWhereImpl())
const mockCardTagsWhere = vi.fn(() => cardTagsWhereImpl())

vi.mock('@/lib/client-db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-db')>('@/lib/client-db')
  return {
    ...actual,
    getClientDb: vi.fn(() => ({
      transaction: mockTransaction,
      card_tags: { delete: mockDelete, put: mockPut, where: mockCardTagsWhere },
      tag_categories: {
        get: mockTagCategoriesGet,
        update: mockTagCategoriesUpdate,
        delete: mockTagCategoriesDelete,
        put: mockTagCategoriesPutDefault,
        where: mockTagCategoriesWhere,
        toArray: mockTagCategoriesToArray,
      },
      tag_options: {
        get: mockTagOptionsGet,
        update: mockTagOptionsUpdate,
        delete: mockTagOptionsDelete,
        put: mockTagOptionsPutDefault,
        where: mockTagOptionsWhere,
      },
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
  // where チェーン実装をデフォルトにリセット
  tagOptionsWhereImpl = () => makeWhereChain([])
  tagCategoriesWhereImpl = () => makeWhereChain([])
  cardTagsWhereImpl = () => makeWhereChain([])
  // Fix A-2: toArray デフォルト (空配列 = 衝突なし)
  mockTagCategoriesToArray.mockResolvedValue([])
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
    // getByText('タグ') は Fix B-1 で trigger button の <span>タグ</span> も合致するため
    // heading role で絞る。
    expect(screen.getByRole('heading', { name: 'タグ' })).toBeInTheDocument()
  })

  it('見出し横に「タグ管理 →」 link は render されない (Tag-4c-2a Task 4 で popover footer からも撤去)', () => {
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

// ---------------------------------------------------------------------------
// Tag-4c-1: import handlers under test
// ---------------------------------------------------------------------------
import {
  handleRenameCategory,
  handleSetCategoryColor,
  handleRenameOption,
  handleSetOptionColor,
  handleDeleteCategory,
  handleDeleteOption,
  countCategoryImpact,
  countOptionImpact,
  handleCreateCategory,
  handleCreateOptionAndAssign,
} from './card-tags-section'
// Note: runGuardedEntityMutationFlush already imported above (Section 5)

// ===========================================================================
// Section 6: handleRenameCategory
// ===========================================================================

describe('handleRenameCategory', () => {
  it('正常系: get → update → enqueue → flush の順に呼ばれる', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '旧名',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)

    await handleRenameCategory('cat-1', '新名')

    // get が cat-1 を引数で呼ばれた
    expect(mockTagCategoriesGet).toHaveBeenCalledWith('cat-1')
    // update が新名で呼ばれた
    expect(mockTagCategoriesUpdate).toHaveBeenCalledWith(
      'cat-1',
      expect.objectContaining({ name: '新名' }),
    )
    // enqueue が呼ばれた (update より後)
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        entity_id: 'cat-1',
        op: 'update_field',
        patch: { field: 'name', value: '新名' },
      }),
    )
    // flush が呼ばれた
    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  it('no-op: 同名の場合は update / enqueue を呼ばない', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '同名',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)

    await handleRenameCategory('cat-1', '同名')

    expect(mockTagCategoriesUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
  })

  it('enqueue が throw した場合 → update が 2 回呼ばれ (forward + revert)、 flush は呼ばれない', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '旧名',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )

    await expect(handleRenameCategory('cat-1', '新名')).rejects.toThrow('enqueue failed')

    // update が 2 回: forward + revert
    expect(mockTagCategoriesUpdate).toHaveBeenCalledTimes(2)
    // revert call の引数は元値に戻す
    const revertCall = (mockTagCategoriesUpdate.mock.calls as unknown as [string, Record<string, unknown>][])[1]
    expect(revertCall[1]).toMatchObject({ name: '旧名' })
    // flush は呼ばれない
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('category が存在しない場合は何もしない', async () => {
    mockTagCategoriesGet.mockResolvedValueOnce(undefined)

    await handleRenameCategory('nonexistent', '新名')

    expect(mockTagCategoriesUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
  })

  // Fix A-2: 同名衝突 check
  it('Fix A-2: 同名カテゴリが既に存在する場合は throw + update/enqueue は呼ばれない', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '旧名',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    const existing = {
      id: 'cat-2', // 別 id
      user_id: 'user-1',
      name: '既存名',
      select_type: 'single' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)
    mockTagCategoriesToArray.mockResolvedValueOnce([before, existing])

    await expect(handleRenameCategory('cat-1', '既存名')).rejects.toThrow('同名のカテゴリが既にあります')

    expect(mockTagCategoriesUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Section 7: handleSetCategoryColor
// ===========================================================================

describe('handleSetCategoryColor', () => {
  it('正常系: update → enqueue → flush', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '分野',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)

    await handleSetCategoryColor('cat-1', 'red')

    expect(mockTagCategoriesUpdate).toHaveBeenCalledWith(
      'cat-1',
      expect.objectContaining({ color: 'red' }),
    )
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        entity_id: 'cat-1',
        op: 'update_field',
        patch: { field: 'color', value: 'red' },
      }),
    )
    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  it('color null → null no-op: update / enqueue を呼ばない', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '分野',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)

    await handleSetCategoryColor('cat-1', null)

    expect(mockTagCategoriesUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
  })

  it('color null 往復: before.color=null, newColor=red, enqueue throw → revert で color が null に戻る (空文字/undefined に化けない)', async () => {
    const before = {
      id: 'cat-1',
      user_id: 'user-1',
      name: '分野',
      select_type: 'multi' as const,
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagCategoriesGet.mockResolvedValueOnce(before)
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )

    await expect(handleSetCategoryColor('cat-1', 'red')).rejects.toThrow('enqueue failed')

    // revert の 2 回目 update で color が null (空文字や undefined ではない)
    expect(mockTagCategoriesUpdate).toHaveBeenCalledTimes(2)
    const revertCall = (mockTagCategoriesUpdate.mock.calls as unknown as [string, Record<string, unknown>][])[1]
    expect(revertCall[1]).toMatchObject({ color: null })
    expect(revertCall[1].color).not.toBe('')
    expect(revertCall[1].color).not.toBe(undefined)
  })
})

// ===========================================================================
// Section 8: handleRenameOption
// ===========================================================================

describe('handleRenameOption', () => {
  it('正常系: get → update → enqueue → flush', async () => {
    const before = {
      id: 'opt-1',
      user_id: 'user-1',
      category_id: 'cat-1',
      name: '旧名',
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagOptionsGet.mockResolvedValueOnce(before)

    await handleRenameOption('opt-1', '新名')

    expect(mockTagOptionsUpdate).toHaveBeenCalledWith(
      'opt-1',
      expect.objectContaining({ name: '新名' }),
    )
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'update_field',
        patch: { field: 'name', value: '新名' },
      }),
    )
    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  it('enqueue throw → update 2 回 (forward + revert)、 flush は呼ばれない', async () => {
    const before = {
      id: 'opt-1',
      user_id: 'user-1',
      category_id: 'cat-1',
      name: '旧名',
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagOptionsGet.mockResolvedValueOnce(before)
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )

    await expect(handleRenameOption('opt-1', '新名')).rejects.toThrow('enqueue failed')

    expect(mockTagOptionsUpdate).toHaveBeenCalledTimes(2)
    const revertCall = (mockTagOptionsUpdate.mock.calls as unknown as [string, Record<string, unknown>][])[1]
    expect(revertCall[1]).toMatchObject({ name: '旧名' })
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  // Fix A-2: 同 category 内で同名衝突 check
  it('Fix A-2: 同 category 内に同名 option が既に存在 → throw + update/enqueue は呼ばれない', async () => {
    const before = {
      id: 'opt-1',
      user_id: 'user-1',
      category_id: 'cat-1',
      name: '旧名',
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagOptionsGet.mockResolvedValueOnce(before)
    // 同 cat-1 内に「衝突名」という option が既に存在する状態
    tagOptionsWhereImpl = () => makeWhereChain([
      before,
      { id: 'opt-2', category_id: 'cat-1', name: '衝突名' },
    ])

    await expect(handleRenameOption('opt-1', '衝突名')).rejects.toThrow('同名の option が既にあります')

    expect(mockTagOptionsUpdate).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
  })

  it('Fix A-2: 別 category に同名 option があっても OK (option は category scope)', async () => {
    const before = {
      id: 'opt-1',
      user_id: 'user-1',
      category_id: 'cat-1',
      name: '旧名',
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagOptionsGet.mockResolvedValueOnce(before)
    // cat-1 の where 結果には opt-1 のみ (同 cat-1 内に「新名」は存在しない)
    tagOptionsWhereImpl = () => makeWhereChain([before])

    // 別 category (cat-2) に「新名」 があっても衝突しない → throw しない
    await expect(handleRenameOption('opt-1', '新名')).resolves.toBeUndefined()

    expect(mockTagOptionsUpdate).toHaveBeenCalledWith(
      'opt-1',
      expect.objectContaining({ name: '新名' }),
    )
  })
})

// ===========================================================================
// Section 9: handleSetOptionColor
// ===========================================================================

describe('handleSetOptionColor', () => {
  it('正常系: update → enqueue → flush', async () => {
    const before = {
      id: 'opt-1',
      user_id: 'user-1',
      category_id: 'cat-1',
      name: 'テスト',
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagOptionsGet.mockResolvedValueOnce(before)

    await handleSetOptionColor('opt-1', 'blue')

    expect(mockTagOptionsUpdate).toHaveBeenCalledWith(
      'opt-1',
      expect.objectContaining({ color: 'blue' }),
    )
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'update_field',
        patch: { field: 'color', value: 'blue' },
      }),
    )
    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  it('color null 往復: before.color=null, newColor=red, enqueue throw → revert で color が null', async () => {
    const before = {
      id: 'opt-1',
      user_id: 'user-1',
      category_id: 'cat-1',
      name: 'テスト',
      color: null,
      sort_key: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    mockTagOptionsGet.mockResolvedValueOnce(before)
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )

    await expect(handleSetOptionColor('opt-1', 'red')).rejects.toThrow('enqueue failed')

    expect(mockTagOptionsUpdate).toHaveBeenCalledTimes(2)
    const revertCall = (mockTagOptionsUpdate.mock.calls as unknown as [string, Record<string, unknown>][])[1]
    expect(revertCall[1].color).toBe(null)
    expect(revertCall[1].color).not.toBe('')
    expect(revertCall[1].color).not.toBe(undefined)
  })
})

// ===========================================================================
// Section 10: handleDeleteCategory
// ===========================================================================

describe('handleDeleteCategory', () => {
  it('atomic tx: card_tags, tag_options, tag_categories, entity_mutations を rw lock する', async () => {
    // tag_options.where('category_id').equals(catId).toArray() が [] を返す
    tagOptionsWhereImpl = () => makeWhereChain([])

    await handleDeleteCategory('cat-1')

    expect(mockTransaction).toHaveBeenCalled()
    const firstCall = mockTransaction.mock.calls[0]
    expect(firstCall[0]).toBe('rw')
    const tableArgs = firstCall.slice(1, -1)
    const db = (getClientDb as ReturnType<typeof vi.fn>).mock.results[0]?.value as Record<string, unknown>
    expect(tableArgs).toContain(db.card_tags)
    expect(tableArgs).toContain(db.tag_options)
    expect(tableArgs).toContain(db.tag_categories)
    expect(tableArgs).toContain(db.entity_mutations)
  })

  it('enqueue が op:delete で呼ばれる', async () => {
    tagOptionsWhereImpl = () => makeWhereChain([])

    await handleDeleteCategory('cat-1')

    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        entity_id: 'cat-1',
        op: 'delete',
        patch: {},
      }),
    )
  })

  it('配下 options が存在する場合: card_tags も削除される', async () => {
    const options = [
      { id: 'opt-1', category_id: 'cat-1' },
      { id: 'opt-2', category_id: 'cat-1' },
    ]
    tagOptionsWhereImpl = () => makeWhereChain(options)
    // card_tags.where('option_id').anyOf([opt-1, opt-2]).delete() のチェーンを使う
    const cardTagsChain = makeWhereChain(options)
    cardTagsWhereImpl = () => cardTagsChain

    await handleDeleteCategory('cat-1')

    expect(enqueueEntityMutation).toHaveBeenCalled()
    // tag_categories.delete が呼ばれた
    expect(mockTagCategoriesDelete).toHaveBeenCalledWith('cat-1')
    // 強い contract pin: card_tags への cascade delete が option_ids 配列で発火
    expect(cardTagsChain.anyOf).toHaveBeenCalledWith(['opt-1', 'opt-2'])
  })

  it('flush は tx 完了後に呼ばれる', async () => {
    tagOptionsWhereImpl = () => makeWhereChain([])

    await handleDeleteCategory('cat-1')

    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })
})

// ===========================================================================
// Section 11: handleDeleteOption
// ===========================================================================

describe('handleDeleteOption', () => {
  it('atomic tx: card_tags, tag_options, entity_mutations を rw lock する', async () => {
    cardTagsWhereImpl = () => makeWhereChain([])

    await handleDeleteOption('opt-1')

    expect(mockTransaction).toHaveBeenCalled()
    const firstCall = mockTransaction.mock.calls[0]
    expect(firstCall[0]).toBe('rw')
    const tableArgs = firstCall.slice(1, -1)
    const db = (getClientDb as ReturnType<typeof vi.fn>).mock.results[0]?.value as Record<string, unknown>
    expect(tableArgs).toContain(db.card_tags)
    expect(tableArgs).toContain(db.tag_options)
    expect(tableArgs).toContain(db.entity_mutations)
    // tag_categories は含まれない (option 削除では不要)
    expect(tableArgs).not.toContain(db.tag_categories)
  })

  it('enqueue が op:delete で呼ばれ、 tag_options.delete が呼ばれる', async () => {
    cardTagsWhereImpl = () => makeWhereChain([])

    await handleDeleteOption('opt-1')

    expect(mockTagOptionsDelete).toHaveBeenCalledWith('opt-1')
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'delete',
        patch: {},
      }),
    )
  })

  it('flush は tx 完了後に呼ばれる', async () => {
    cardTagsWhereImpl = () => makeWhereChain([])

    await handleDeleteOption('opt-1')

    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })
})

// ===========================================================================
// Section 12: countCategoryImpact / countOptionImpact
// ===========================================================================

describe('countCategoryImpact', () => {
  it('options が 0 件のとき optionCount=0, cardCount=0', async () => {
    tagOptionsWhereImpl = () => makeWhereChain([])
    // card_tags.where もデフォルト (toArray → [])

    const result = await countCategoryImpact('cat-1')
    expect(result).toEqual({ optionCount: 0, cardCount: 0 })
  })

  it('options 2 件, 各 option に card_tags 2 件 (異なる card_id) → optionCount=2, cardCount=4', async () => {
    const options = [
      { id: 'opt-1', category_id: 'cat-1' },
      { id: 'opt-2', category_id: 'cat-1' },
    ]
    tagOptionsWhereImpl = () => makeWhereChain(options)

    // Fix A-4: 各 option の card_tags.toArray() が返す card_id が distinct 2 件ずつ
    // opt-1 → [card-1, card-2]、 opt-2 → [card-3, card-4] → distinct = 4
    let callCount = 0
    cardTagsWhereImpl = () => {
      const cards =
        callCount++ === 0
          ? [{ card_id: 'card-1' }, { card_id: 'card-2' }]
          : [{ card_id: 'card-3' }, { card_id: 'card-4' }]
      return makeWhereChain(cards)
    }

    const result = await countCategoryImpact('cat-1')
    expect(result.optionCount).toBe(2)
    expect(result.cardCount).toBe(4) // 4 distinct card_ids
  })

  // Fix A-4: 1 card が同カテゴリ内 2 options を持つ場合 → cardCount=1 (not 2)
  it('Fix A-4: 1 card が同カテゴリ内 2 options を持つ場合 → cardCount=1 (distinct)', async () => {
    const options = [
      { id: 'opt-1', category_id: 'cat-1' },
      { id: 'opt-2', category_id: 'cat-1' },
    ]
    tagOptionsWhereImpl = () => makeWhereChain(options)

    // 両方の option に同じ card-1 が紐付いている
    cardTagsWhereImpl = () => makeWhereChain([{ card_id: 'card-1' }])

    const result = await countCategoryImpact('cat-1')
    expect(result.optionCount).toBe(2)
    expect(result.cardCount).toBe(1) // distinct: card-1 が 2 回カウントされない
  })
})

describe('countOptionImpact', () => {
  it('card_tags 0 件のとき cardCount=0', async () => {
    cardTagsWhereImpl = () => makeWhereChain(0)

    const result = await countOptionImpact('opt-1')
    expect(result).toEqual({ cardCount: 0 })
  })

  it('card_tags 3 件のとき cardCount=3', async () => {
    cardTagsWhereImpl = () => makeWhereChain(3)

    const result = await countOptionImpact('opt-1')
    expect(result).toEqual({ cardCount: 3 })
  })
})

// ===========================================================================
// Tag-4c-2c hotfix H1: sortedCardTags — バッジ表示順序 (共有 sortByKeyThenCreated)
// ===========================================================================
//
// 旧 Fix C-3 軸 2 (Tag-4b-fix 由来) は category.name / option.name の localeCompare ja で
// 並べていたため、 sort_key 未参照の文字列辞書順による 11+ 件誤順 (調査 3) を起こしていた。
// hotfix H1 で popover / manager と同じ共有 `sortByKeyThenCreated` (sort_key 数値昇順 +
// tie-break created_at) に切替、 3 経路の並びを揃える。

describe('CardTagsSection — Tag-4c-2c hotfix H1: sortedCardTags badge order (sort_key)', () => {
  it('category 間: catA.sort_key < catB.sort_key の順で並ぶ (name localeCompare は無視)', () => {
    // 意図的に「name は逆順」 (難易度→分野 で localeCompare なら 分野 先) だが、
    // sort_key を 難易度='0' / 分野='1' と振って「sort_key で 難易度 先」 を pin する。
    const categories: ClientTagCategory[] = [
      { ...cat('c1', '難易度', 'single'), sort_key: '0' },
      { ...cat('c2', '分野', 'multi'), sort_key: '1' },
    ]
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', '高'), sort_key: '0' },
      { ...opt('o2', 'c2', '循環器'), sort_key: '0' },
    ]
    const cardTags = [tag('card-1', 'o2'), tag('card-1', 'o1')]

    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={categories}
        options={options}
        cardTags={cardTags}
      />,
    )

    const badges = screen.getAllByRole('button', { name: /^タグ: / })
    const labels = badges.map((b) => b.getAttribute('aria-label'))
    // sort_key 順なら 難易度 (0) 先、 分野 (1) 後。 name localeCompare 順なら 分野 (bun) 先、
    // 難易度 (nan) 後 — sort_key 順を pin。
    expect(labels[0]).toBe('タグ: 難易度: 高')
    expect(labels[1]).toBe('タグ: 分野: 循環器')
  })

  it('同 category 内 option: 2 桁含む sort_key を数値順で並べる (1, 2, ..., 12) — 旧文字列辞書順なら fail', () => {
    // 旧 (name localeCompare) でも fail し、 sort_key 文字列辞書順 (旧の別案) でも
    // ['1','10','11','12','2','3',...] で fail する形を明示。
    // 期待: 数値順 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    const categories: ClientTagCategory[] = [
      { ...cat('c1', '分野', 'multi'), sort_key: '0' },
    ]
    // option の name は sort_key と無関係 (sort_key 数値順を確認したいので意図的に不一致)。
    const optionFixture: ClientTagOption[] = [
      { ...opt('o1', 'c1', 'opt-01'), sort_key: '1' },
      { ...opt('o2', 'c1', 'opt-02'), sort_key: '2' },
      { ...opt('o3', 'c1', 'opt-03'), sort_key: '3' },
      { ...opt('o4', 'c1', 'opt-04'), sort_key: '4' },
      { ...opt('o5', 'c1', 'opt-05'), sort_key: '5' },
      { ...opt('o6', 'c1', 'opt-06'), sort_key: '6' },
      { ...opt('o7', 'c1', 'opt-07'), sort_key: '7' },
      { ...opt('o8', 'c1', 'opt-08'), sort_key: '8' },
      { ...opt('o9', 'c1', 'opt-09'), sort_key: '9' },
      { ...opt('o10', 'c1', 'opt-10'), sort_key: '10' },
      { ...opt('o11', 'c1', 'opt-11'), sort_key: '11' },
      { ...opt('o12', 'c1', 'opt-12'), sort_key: '12' },
    ]
    // 意図的にシャッフル入力 (sort 結果 = sort_key 数値昇順)
    const shuffled = [
      optionFixture[11], // sort_key '12'
      optionFixture[0],  // '1'
      optionFixture[9],  // '10'
      optionFixture[1],  // '2'
      optionFixture[10], // '11'
      optionFixture[2],  // '3'
      optionFixture[8],  // '9'
      optionFixture[3],  // '4'
      optionFixture[7],  // '8'
      optionFixture[4],  // '5'
      optionFixture[6],  // '7'
      optionFixture[5],  // '6'
    ]
    const cardTags = shuffled.map((o) => tag('card-1', o.id))

    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={categories}
        options={optionFixture}
        cardTags={cardTags}
      />,
    )

    const badges = screen.getAllByRole('button', { name: /^タグ: / })
    const labels = badges.map((b) => b.getAttribute('aria-label'))
    // 数値昇順 (1,2,3,...,12)。 文字列辞書順なら '1','10','11','12','2','3',... となり fail する。
    expect(labels).toEqual([
      'タグ: 分野: opt-01',
      'タグ: 分野: opt-02',
      'タグ: 分野: opt-03',
      'タグ: 分野: opt-04',
      'タグ: 分野: opt-05',
      'タグ: 分野: opt-06',
      'タグ: 分野: opt-07',
      'タグ: 分野: opt-08',
      'タグ: 分野: opt-09',
      'タグ: 分野: opt-10',
      'タグ: 分野: opt-11',
      'タグ: 分野: opt-12',
    ])
  })

  it('tie-break: 同 sort_key の option は created_at ASC で解決 (comparator 内蔵)', () => {
    // 同 sort_key='1' の 2 option が created_at の早い方先。 sortByKeyThenCreated 仕様
    // (sort_key 同位 → created_at ASC) を pin。
    const categories: ClientTagCategory[] = [
      { ...cat('c1', '分野', 'multi'), sort_key: '0' },
    ]
    const options: ClientTagOption[] = [
      { ...opt('oLate', 'c1', '後発', '2026-06-01T00:00:02.000Z'), sort_key: '1' },
      { ...opt('oEarly', 'c1', '先発', '2026-06-01T00:00:01.000Z'), sort_key: '1' },
    ]
    const cardTags = [tag('card-1', 'oLate'), tag('card-1', 'oEarly')]

    render(
      <CardTagsSection
        cardId="card-1"
        userId="user-1"
        categories={categories}
        options={options}
        cardTags={cardTags}
      />,
    )

    const badges = screen.getAllByRole('button', { name: /^タグ: / })
    const labels = badges.map((b) => b.getAttribute('aria-label'))
    // created_at の早い '先発' が先
    expect(labels[0]).toBe('タグ: 分野: 先発')
    expect(labels[1]).toBe('タグ: 分野: 後発')
  })
})

// ===========================================================================
// Tag-4c-2a Section A: handleCreateCategory
// ===========================================================================
//
// テスト戦略:
// - module スコープ関数 (props 引数版) を直接呼出し、 db.transaction / mirror put / enqueue
//   の挙動を mock で観測する。
// - `crypto.randomUUID` は vi.spyOn で安定 id ('cat-new-1') に固定し、 put 引数の id を pin。
// - sort_key 採番は `nextSortKey` (`@/lib/tags/next-sort-key`) の semantics に委ねる
//   (categories.sort_key ベース、 Tag-4c-2b T2.7 で `nextCardSortKey` から差替、 起点 '0')。

describe('handleCreateCategory', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'cat-new-1' as `${string}-${string}-${string}-${string}-${string}`,
    )
  })

  it('正常系: db.transaction が tag_categories + entity_mutations の 2 store rw lock で呼ばれる', async () => {
    const result = await handleCreateCategory('user-1', [], '新カテゴリ', 'multi')

    expect(result).toEqual({ id: 'cat-new-1' })
    expect(mockTransaction).toHaveBeenCalled()
    const firstCall = mockTransaction.mock.calls[0]
    expect(firstCall[0]).toBe('rw')
    const tableArgs = firstCall.slice(1, -1)
    const db = (getClientDb as ReturnType<typeof vi.fn>).mock.results[0]?.value as Record<string, unknown>
    expect(tableArgs).toContain(db.tag_categories)
    expect(tableArgs).toContain(db.entity_mutations)
    // 他 store (tag_options / card_tags) は含まれない
    expect(tableArgs).not.toContain(db.tag_options)
    expect(tableArgs).not.toContain(db.card_tags)
  })

  it('mirror put が id / name / select_type / color:null / sort_key / user_id / created_at で呼ばれる', async () => {
    const mockTagCategoriesPut = vi.fn(async () => undefined)
    // 既存 mock に put を追加 (getClientDb mock factory を上書き)
    ;(getClientDb as ReturnType<typeof vi.fn>).mockReturnValue({
      transaction: mockTransaction,
      card_tags: { delete: mockDelete, put: mockPut, where: mockCardTagsWhere },
      tag_categories: {
        get: mockTagCategoriesGet,
        update: mockTagCategoriesUpdate,
        delete: mockTagCategoriesDelete,
        put: mockTagCategoriesPut,
        where: mockTagCategoriesWhere,
        toArray: mockTagCategoriesToArray,
      },
      tag_options: {
        get: mockTagOptionsGet,
        update: mockTagOptionsUpdate,
        delete: mockTagOptionsDelete,
        where: mockTagOptionsWhere,
      },
      entity_mutations: {},
    })

    await handleCreateCategory('user-1', [], '分野', 'single')

    expect(mockTagCategoriesPut).toHaveBeenCalledTimes(1)
    const putArg = (mockTagCategoriesPut.mock.calls as unknown as [Record<string, unknown>][])[0][0]
    expect(putArg.id).toBe('cat-new-1')
    expect(putArg.name).toBe('分野')
    expect(putArg.select_type).toBe('single')
    expect(putArg.color).toBe(null)
    expect(putArg.sort_key).toBe('0') // 空配列 → '0' (Tag-4c-2b T2.7: nextSortKey 起点 '0')
    expect(putArg.user_id).toBe('user-1')
    expect(typeof putArg.created_at).toBe('string')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '0' }),
      }),
    )
  })

  it('enqueue が op=create の引数で呼ばれる (patch に sort_key 含む / manager create と shape 一致)', async () => {
    // Tag-4c-2b T7 V-a: 「null 混在を新規に作らない」 (§4.7 rationale) を popover create
    // 経路でも実現。 manager `category-create-form.tsx` の enqueue patch shape
    // (`{ name, select_type, sort_key }`) と揃え、 server `applyTagCategoryCreate` 経由で
    // 全 row が末尾採番 sort_key を持つ状態に収束する。 空 existing → sort_key '0' 起点。
    await handleCreateCategory('user-1', [], '分野', 'multi')

    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        entity_id: 'cat-new-1',
        op: 'create',
        patch: { name: '分野', select_type: 'multi', sort_key: '0' },
      }),
    )
  })

  it('userId 空文字 → console.error + throw、 db.transaction は呼ばれない', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(handleCreateCategory('', [], 'x', 'multi')).rejects.toThrow('empty user_id')
    expect(errSpy).toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('enqueue が throw した場合 → tx が throw を伝播 (Dexie auto-rollback)、 flush は呼ばれない', async () => {
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )

    await expect(handleCreateCategory('user-1', [], 'x', 'multi')).rejects.toThrow('enqueue failed')

    // flush は tx 完了後の void で、 throw されると到達しない
    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('flush は正常完了後に呼ばれる', async () => {
    await handleCreateCategory('user-1', [], 'x', 'multi')
    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  // ----- sort_key 採番 contract (Tag-4c-2b T2.7: nextSortKey 起点 '0') -----
  it('sort_key 採番: 既存全 null → "0"', async () => {
    const mockTagCategoriesPut = vi.fn(async () => undefined)
    ;(getClientDb as ReturnType<typeof vi.fn>).mockReturnValue({
      transaction: mockTransaction,
      card_tags: { delete: mockDelete, put: mockPut, where: mockCardTagsWhere },
      tag_categories: {
        get: mockTagCategoriesGet,
        update: mockTagCategoriesUpdate,
        delete: mockTagCategoriesDelete,
        put: mockTagCategoriesPut,
        where: mockTagCategoriesWhere,
        toArray: mockTagCategoriesToArray,
      },
      tag_options: {
        get: mockTagOptionsGet,
        update: mockTagOptionsUpdate,
        delete: mockTagOptionsDelete,
        where: mockTagOptionsWhere,
      },
      entity_mutations: {},
    })
    const cats = [cat('c1', '既存1'), cat('c2', '既存2')] // sort_key 全 null

    await handleCreateCategory('user-1', cats, '新', 'multi')

    const putArg = (mockTagCategoriesPut.mock.calls as unknown as [{ sort_key: string }][])[0][0]
    expect(putArg.sort_key).toBe('0')
    // Tag-4c-2b T7 V-a: mirror put 側だけでなく enqueue patch 側にも同採番値を書き込み、
    // server `applyTagCategoryCreate` 経由で「null 混在を新規に作らない」 を成立させる。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '0' }),
      }),
    )
  })

  it('sort_key 採番: 既存 ["1","2"] → "3"', async () => {
    const mockTagCategoriesPut = vi.fn(async () => undefined)
    ;(getClientDb as ReturnType<typeof vi.fn>).mockReturnValue({
      transaction: mockTransaction,
      card_tags: { delete: mockDelete, put: mockPut, where: mockCardTagsWhere },
      tag_categories: {
        get: mockTagCategoriesGet,
        update: mockTagCategoriesUpdate,
        delete: mockTagCategoriesDelete,
        put: mockTagCategoriesPut,
        where: mockTagCategoriesWhere,
        toArray: mockTagCategoriesToArray,
      },
      tag_options: {
        get: mockTagOptionsGet,
        update: mockTagOptionsUpdate,
        delete: mockTagOptionsDelete,
        where: mockTagOptionsWhere,
      },
      entity_mutations: {},
    })
    const cats: ClientTagCategory[] = [
      { ...cat('c1', '既存1'), sort_key: '1' },
      { ...cat('c2', '既存2'), sort_key: '2' },
    ]

    await handleCreateCategory('user-1', cats, '新', 'multi')

    const putArg = (mockTagCategoriesPut.mock.calls as unknown as [{ sort_key: string }][])[0][0]
    expect(putArg.sort_key).toBe('3')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '3' }),
      }),
    )
  })

  it('sort_key 採番: 既存 ["1", null, "5"] → "6"', async () => {
    const mockTagCategoriesPut = vi.fn(async () => undefined)
    ;(getClientDb as ReturnType<typeof vi.fn>).mockReturnValue({
      transaction: mockTransaction,
      card_tags: { delete: mockDelete, put: mockPut, where: mockCardTagsWhere },
      tag_categories: {
        get: mockTagCategoriesGet,
        update: mockTagCategoriesUpdate,
        delete: mockTagCategoriesDelete,
        put: mockTagCategoriesPut,
        where: mockTagCategoriesWhere,
        toArray: mockTagCategoriesToArray,
      },
      tag_options: {
        get: mockTagOptionsGet,
        update: mockTagOptionsUpdate,
        delete: mockTagOptionsDelete,
        where: mockTagOptionsWhere,
      },
      entity_mutations: {},
    })
    const cats: ClientTagCategory[] = [
      { ...cat('c1', '既存1'), sort_key: '1' },
      { ...cat('c2', '既存2'), sort_key: null },
      { ...cat('c3', '既存3'), sort_key: '5' },
    ]

    await handleCreateCategory('user-1', cats, '新', 'multi')

    const putArg = (mockTagCategoriesPut.mock.calls as unknown as [{ sort_key: string }][])[0][0]
    expect(putArg.sort_key).toBe('6')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_category',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '6' }),
      }),
    )
  })
})

// ===========================================================================
// Tag-4c-2a Section B: handleCreateOptionAndAssign
// ===========================================================================

describe('handleCreateOptionAndAssign', () => {
  // 共通: tag_options.put / card_tags.put / card_tags.delete を捕まえる spy 群を用意して
  // getClientDb mock を毎回再設定する。
  let mockTagOptionsPut: ReturnType<typeof vi.fn>
  let mockCardTagsPut: ReturnType<typeof vi.fn>
  let mockCardTagsDelete: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'opt-new-1' as `${string}-${string}-${string}-${string}-${string}`,
    )
    mockTagOptionsPut = vi.fn(async () => undefined)
    mockCardTagsPut = vi.fn(async () => undefined)
    mockCardTagsDelete = vi.fn(async () => undefined)
    ;(getClientDb as ReturnType<typeof vi.fn>).mockReturnValue({
      transaction: mockTransaction,
      card_tags: {
        delete: mockCardTagsDelete,
        put: mockCardTagsPut,
        where: mockCardTagsWhere,
      },
      tag_categories: {
        get: mockTagCategoriesGet,
        update: mockTagCategoriesUpdate,
        delete: mockTagCategoriesDelete,
        where: mockTagCategoriesWhere,
        toArray: mockTagCategoriesToArray,
      },
      tag_options: {
        get: mockTagOptionsGet,
        update: mockTagOptionsUpdate,
        delete: mockTagOptionsDelete,
        put: mockTagOptionsPut,
        where: mockTagOptionsWhere,
      },
      entity_mutations: {},
    })
  })

  it('atomic tx: tag_options + card_tags + entity_mutations の 3 store rw lock', async () => {
    const categories = [cat('c1', '分野', 'multi')]
    await handleCreateOptionAndAssign('user-1', 'card-1', categories, [], [], 'c1', '新option')

    expect(mockTransaction).toHaveBeenCalled()
    const firstCall = mockTransaction.mock.calls[0]
    expect(firstCall[0]).toBe('rw')
    const tableArgs = firstCall.slice(1, -1)
    const db = (getClientDb as ReturnType<typeof vi.fn>).mock.results[0]?.value as Record<string, unknown>
    expect(tableArgs).toContain(db.tag_options)
    expect(tableArgs).toContain(db.card_tags)
    expect(tableArgs).toContain(db.entity_mutations)
    // tag_categories は含まれない (create option では category 触らない)
    expect(tableArgs).not.toContain(db.tag_categories)
  })

  it('multi: 新 option は toAdd のみ (同カテゴリ既存付与は維持される)', async () => {
    const categories = [cat('c1', '分野', 'multi')]
    const options = [opt('o1', 'c1', '既存')]
    const cardTags = [tag('card-1', 'o1')]

    await handleCreateOptionAndAssign(
      'user-1', 'card-1', categories, options, cardTags, 'c1', '追加',
    )

    // card_tags.delete は呼ばれない (multi なので toRemove なし)
    expect(mockCardTagsDelete).not.toHaveBeenCalled()
    // card_tags.put は新 option のみ
    expect(mockCardTagsPut).toHaveBeenCalledTimes(1)
    const putArg = mockCardTagsPut.mock.calls[0][0] as { card_id: string; option_id: string }
    expect(putArg.card_id).toBe('card-1')
    expect(putArg.option_id).toBe('opt-new-1')

    // enqueue の card update_field value は ['o1', 'opt-new-1'] (順不同で検証)
    const cardUpdateCall = (enqueueEntityMutation as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { entity_type: string }).entity_type === 'card',
    )
    expect(cardUpdateCall).toBeDefined()
    const value = (cardUpdateCall![0] as { patch: { value: string[] } }).patch.value
    expect(value).toEqual(expect.arrayContaining(['o1', 'opt-new-1']))
    expect(value).toHaveLength(2)
  })

  it('single: 同カテゴリ既存付与の option は toRemove に積まれる + 新 option を toAdd', async () => {
    const categories = [cat('c1', '難易度', 'single')]
    const options = [opt('o1', 'c1', '高')]
    const cardTags = [tag('card-1', 'o1')] // 既に「高」 付与済

    await handleCreateOptionAndAssign(
      'user-1', 'card-1', categories, options, cardTags, 'c1', '中',
    )

    // 同カテゴリ既存付与 'o1' が delete される (single ルール)
    expect(mockCardTagsDelete).toHaveBeenCalledWith(['card-1', 'o1'])
    // 新 option を put
    expect(mockCardTagsPut).toHaveBeenCalledTimes(1)
    const putArg = mockCardTagsPut.mock.calls[0][0] as { option_id: string }
    expect(putArg.option_id).toBe('opt-new-1')

    // enqueue value は ['opt-new-1'] (o1 は除外)
    const cardUpdateCall = (enqueueEntityMutation as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { entity_type: string }).entity_type === 'card',
    )
    const value = (cardUpdateCall![0] as { patch: { value: string[] } }).patch.value
    expect(value).toEqual(['opt-new-1'])
  })

  it('single: 他カテゴリの付与は維持される (whole-set 不変条件)', async () => {
    const categories = [
      cat('c1', '難易度', 'single'),
      cat('c2', '分野', 'multi'),
    ]
    const options = [opt('o1', 'c1', '高'), opt('o2', 'c2', '循環器')]
    const cardTags = [tag('card-1', 'o1'), tag('card-1', 'o2')]

    await handleCreateOptionAndAssign(
      'user-1', 'card-1', categories, options, cardTags, 'c1', '中',
    )

    // delete は o1 のみ (c1 内)、 o2 (c2) は触らない
    expect(mockCardTagsDelete).toHaveBeenCalledWith(['card-1', 'o1'])
    expect(mockCardTagsDelete).toHaveBeenCalledTimes(1)

    // enqueue value は ['o2', 'opt-new-1']
    const cardUpdateCall = (enqueueEntityMutation as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { entity_type: string }).entity_type === 'card',
    )
    const value = (cardUpdateCall![0] as { patch: { value: string[] } }).patch.value
    expect(value).toEqual(expect.arrayContaining(['o2', 'opt-new-1']))
    expect(value).not.toContain('o1')
  })

  it('tag_options.put 引数: id / category_id / name / color:null / sort_key / user_id / created_at', async () => {
    const categories = [cat('c1', '分野', 'multi')]
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', '既存1'), sort_key: '1' },
      { ...opt('o2', 'c1', '既存2'), sort_key: '2' },
    ]

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, options, [], 'c1', '新')

    expect(mockTagOptionsPut).toHaveBeenCalledTimes(1)
    const putArg = mockTagOptionsPut.mock.calls[0][0] as Record<string, unknown>
    expect(putArg.id).toBe('opt-new-1')
    expect(putArg.category_id).toBe('c1')
    expect(putArg.name).toBe('新')
    expect(putArg.color).toBe(null)
    expect(putArg.sort_key).toBe('3') // 既存 ["1","2"] → '3'
    expect(putArg.user_id).toBe('user-1')
    expect(typeof putArg.created_at).toBe('string')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '3' }),
      }),
    )
  })

  it('card_tags.put 引数: card_id / option_id / user_id (空文字でない)', async () => {
    const categories = [cat('c1', '分野', 'multi')]

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, [], [], 'c1', '新')

    const putArg = mockCardTagsPut.mock.calls[0][0] as { user_id: string }
    expect(putArg.user_id).toBe('user-1')
    expect(putArg.user_id).not.toBe('')
  })

  it('enqueue 2 連発: tag_option create (patch に sort_key 含む / manager create と shape 一致) と card update_field tag_option_ids', async () => {
    // Tag-4c-2b T7 V-a: 「null 混在を新規に作らない」 (§4.7 rationale) を popover create
    // 経路でも実現。 manager `option-create-form.tsx` の enqueue patch shape
    // (`{ category_id, name, color, sort_key }`) と揃え、 server `applyTagOptionCreate`
    // 経由で全 row が末尾採番 sort_key を持つ状態に収束する。 空 existing → '0' 起点。
    const categories = [cat('c1', '分野', 'multi')]

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, [], [], 'c1', '新')

    const calls = (enqueueEntityMutation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)

    // tag_option create call
    expect(calls[0][0]).toMatchObject({
      entity_type: 'tag_option',
      entity_id: 'opt-new-1',
      op: 'create',
      patch: { category_id: 'c1', name: '新', color: null, sort_key: '0' },
    })
    // card update_field tag_option_ids call
    expect(calls[1][0]).toMatchObject({
      entity_type: 'card',
      entity_id: 'card-1',
      op: 'update_field',
      patch: expect.objectContaining({ field: 'tag_option_ids' }),
    })
  })

  it('userId 空文字 → console.error + early return (副作用なし)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const categories = [cat('c1', '分野', 'multi')]

    await handleCreateOptionAndAssign('', 'card-1', categories, [], [], 'c1', '新')

    expect(errSpy).toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockTagOptionsPut).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('category 不在 → silent no-op (副作用なし)', async () => {
    await handleCreateOptionAndAssign('user-1', 'card-1', [], [], [], 'no-such-cat', '新')

    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockTagOptionsPut).not.toHaveBeenCalled()
    expect(enqueueEntityMutation).not.toHaveBeenCalled()
  })

  it('enqueue が throw した場合 → tx が throw を伝播 (Dexie auto-rollback)、 flush は呼ばれない', async () => {
    ;(enqueueEntityMutation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('enqueue failed'),
    )
    const categories = [cat('c1', '分野', 'multi')]

    await expect(
      handleCreateOptionAndAssign('user-1', 'card-1', categories, [], [], 'c1', '新'),
    ).rejects.toThrow('enqueue failed')

    expect(runGuardedEntityMutationFlush).not.toHaveBeenCalled()
  })

  it('flush は正常完了後に呼ばれる', async () => {
    const categories = [cat('c1', '分野', 'multi')]

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, [], [], 'c1', '新')

    expect(runGuardedEntityMutationFlush).toHaveBeenCalled()
  })

  // ----- sort_key 採番 contract (option scope: 同カテゴリの sort_key 集合) -----
  // Tag-4c-2b T2.7: nextSortKey 起点 '0' (全 null/非数値 = 母数空 → '0')。
  it('sort_key 採番: 同カテゴリ既存全 null → "0"', async () => {
    const categories = [cat('c1', '分野', 'multi')]
    const options = [opt('o1', 'c1', '既存')] // sort_key null

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, options, [], 'c1', '新')

    const putArg = mockTagOptionsPut.mock.calls[0][0] as { sort_key: string }
    expect(putArg.sort_key).toBe('0')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '0' }),
      }),
    )
  })

  it('sort_key 採番: 別カテゴリの sort_key は無視される (同カテゴリ scope)', async () => {
    const categories = [
      cat('c1', '分野', 'multi'),
      cat('c2', '難易度', 'single'),
    ]
    const options: ClientTagOption[] = [
      { ...opt('o-other', 'c2', '別カテ'), sort_key: '99' }, // 別カテ
      { ...opt('o1', 'c1', '既存'), sort_key: '1' }, // 同カテ
    ]

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, options, [], 'c1', '新')

    const putArg = mockTagOptionsPut.mock.calls[0][0] as { sort_key: string }
    // c1 の sort_key は ["1"] のみ → '2' (c2 の "99" は無視)
    expect(putArg.sort_key).toBe('2')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '2' }),
      }),
    )
  })

  it('sort_key 採番: 既存 ["1", null, "5"] → "6"', async () => {
    const categories = [cat('c1', '分野', 'multi')]
    const options: ClientTagOption[] = [
      { ...opt('o1', 'c1', '既存1'), sort_key: '1' },
      { ...opt('o2', 'c1', '既存2'), sort_key: null },
      { ...opt('o3', 'c1', '既存3'), sort_key: '5' },
    ]

    await handleCreateOptionAndAssign('user-1', 'card-1', categories, options, [], 'c1', '新')

    const putArg = mockTagOptionsPut.mock.calls[0][0] as { sort_key: string }
    expect(putArg.sort_key).toBe('6')
    // Tag-4c-2b T7 V-a: patch 側にも同採番値が書込される (manager create と shape 一致)。
    expect(enqueueEntityMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'tag_option',
        op: 'create',
        patch: expect.objectContaining({ sort_key: '6' }),
      }),
    )
  })
})
