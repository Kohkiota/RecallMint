'use client'

// tag manager の top-level Client component。
// - 責務は「activeCategoryId state」 と「desktop CSS grid / mobile Tabs」 layout
//   切替のみ。 Dexie / 同期 / 削除 logic は CategoryList / OptionList が抱える。
// - desktop (md 以上 = 768px+): `md:grid-cols-3` 固定 1/3 + 2/3 layout。
//   ResizablePanel は導入しない (UX 単純さ優先、 Tag-4a スコープ)。
// - mobile (< md): shadcn Tabs で「カテゴリ」 / 「option」 を 1 active 切替。
//   カテゴリ選択時に options tab に自動遷移する (option 編集導線を最短化)。
//
// 子 component (CategoryList / OptionList) は desktop / mobile で 2 度 mount される。
// Dexie useLiveQuery は subscription ベースのため両 mount で同じ source を見るが、
// state は shell が単一所有するため active 切替は同期する。

import * as React from 'react'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

import { CategoryList } from './category-list'
import { OptionList } from './option-list'

type MobileTab = 'categories' | 'options'

export function TagManagerShell() {
  const [activeCategoryId, setActiveCategoryId] = React.useState<string | null>(
    null,
  )
  const [mobileTab, setMobileTab] = React.useState<MobileTab>('categories')

  // カテゴリ選択 hook。 mobile では options tab に自動遷移して option 編集導線を短縮。
  // null (= deselect) のときは tab を遷移させない (categories に留まる方が自然)。
  const handleSelectMobile = React.useCallback(
    (id: string | null) => {
      setActiveCategoryId(id)
      if (id) setMobileTab('options')
    },
    [],
  )

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">タグ管理</h1>

      {/* desktop: 1/3 + 2/3 の 2 column。 md 未満では非表示 (mobile Tabs に切替) */}
      <div className="hidden md:grid md:grid-cols-3 md:gap-6">
        <div className="col-span-1">
          <CategoryList
            activeCategoryId={activeCategoryId}
            onSelectCategory={setActiveCategoryId}
          />
        </div>
        <div className="col-span-2">
          <OptionList activeCategoryId={activeCategoryId} />
        </div>
      </div>

      {/* mobile: Tabs で 1 active 切替。 md 以上では非表示 (desktop grid に切替) */}
      <div className="md:hidden">
        <Tabs
          value={mobileTab}
          onValueChange={(v) => setMobileTab(v as MobileTab)}
        >
          <TabsList>
            <TabsTrigger value="categories">カテゴリ</TabsTrigger>
            <TabsTrigger value="options">option</TabsTrigger>
          </TabsList>
          <TabsContent value="categories">
            <CategoryList
              activeCategoryId={activeCategoryId}
              onSelectCategory={handleSelectMobile}
            />
          </TabsContent>
          <TabsContent value="options">
            <OptionList activeCategoryId={activeCategoryId} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
