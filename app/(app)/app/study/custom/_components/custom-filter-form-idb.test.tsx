// @vitest-environment jsdom
// CustomFilterForm の fake-indexeddb 統合テスト (tag-mirror-correctness sprint T2 #10/#11)。
//
// `custom-filter-form.test.tsx` は `dexie-react-hooks` の `useLiveQuery` を
// クエリ関数の `fn.toString()` 内容で分岐する mock に差し替えており、 実際の
// `db.tag_categories.where('user_id').equals(userId)` は一度も実行されない
// (querier 本体を呼ばず、 文字列に含まれるテーブル名だけで static state を返す)。
// そのため owner-scope read の red/green pin にはならない (mock で誤魔化さない
// という global 規律に反する)。
//
// 本 file は getClientDb / dexie-react-hooks を mock せず実 Dexie (fake-indexeddb)
// を使い、 「タグで絞り込み」 popover のカテゴリ候補一覧が userId prop で owner-scope
// read されることを実behavior で pin する
// (`card-tags-section-idb.test.tsx` と同じ「-idb」 分離パターンに倣う)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import { getClientDb, type ClientTagCategory, type ClientTagOption } from '@/lib/client-db'
import { CustomFilterForm } from './custom-filter-form'

const USER_ID = 'user-1'

function makeCat(id: string, name: string, userId: string): ClientTagCategory {
  return {
    id,
    user_id: userId,
    name,
    select_type: 'multi',
    color: null,
    sort_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeOpt(
  id: string,
  categoryId: string,
  name: string,
  userId: string,
): ClientTagOption {
  return {
    id,
    user_id: userId,
    category_id: categoryId,
    name,
    color: null,
    sort_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(async () => {
  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
})

afterEach(() => {
  cleanup()
})

describe('CustomFilterForm — owner-scope (tag-mirror-correctness sprint T2 #10/#11)', () => {
  it('user A で描画したとき「タグで絞り込み」 popover のカテゴリ候補に user B の category が現れない', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      makeCat('cat-a', '自分のカテゴリ', USER_ID),
      // 共有ブラウザに残った前 user (user-B) の行。 owner-scope read でなければ
      // 絞り込み候補に混ざって表示される。
      makeCat('cat-b', '他人のカテゴリ', 'user-B'),
    ])

    render(
      <CustomFilterForm userId={USER_ID} customLimit={20} onStart={() => {}} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await screen.findByRole('menuitem', { name: '自分のカテゴリ' })

    expect(
      screen.queryByRole('menuitem', { name: '他人のカテゴリ' }),
    ).not.toBeInTheDocument()
  })

  // 上記 test は categories 単独の owner-scope しか pin しない (options が漏れていても、
  // 他 user 単独 category に属す option は stage2 まで辿り着けないため検出できない)。
  // options 側 (#11) を独立に pin するため、 「自分の category (cat-a) に紐づくが owner は
  // 他 user」 という stale mirror 行を fixture 化する (共有ブラウザで前 user が同 category_id
  // 配下に option を持っていた場合に起こりうる状態)。
  it('自分の category 配下の option 選択画面に user B 所有の option が現れない', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCat('cat-a', '自分のカテゴリ', USER_ID))
    await db.tag_options.bulkPut([
      makeOpt('opt-own', 'cat-a', '自分の option', USER_ID),
      // owner-scope read でなければ stage2 の候補に混ざって表示される、 他 user 所有の
      // stale option 行 (category_id は自分の category を指す)。
      makeOpt('opt-leak', 'cat-a', '他人の option', 'user-B'),
    ])

    render(
      <CustomFilterForm userId={USER_ID} customLimit={20} onStart={() => {}} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '自分のカテゴリ' }))
    await screen.findByRole('menuitemcheckbox', { name: '自分の option' })

    expect(
      screen.queryByRole('menuitemcheckbox', { name: '他人の option' }),
    ).not.toBeInTheDocument()
  })
})
