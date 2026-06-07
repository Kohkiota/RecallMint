'use client'

// tag manager (カテゴリ / option) 削除専用の確認 modal。 a11y / focus / Esc /
// backdrop close は汎用 ConfirmDialog 側で担保済みのため、 ここは tag 固有の
// 文言生成 (kind 別 title / description + 100+ 省略表記) と props 整形のみ。

import * as React from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'

type Props = {
  open: boolean
  // 削除対象が category か option かで title / description 文言を切替える。
  targetKind: 'category' | 'option'
  // 「カテゴリ『X』」 / 「option『Y』」 の name 部分。
  targetName: string
  // category 削除時のみ意味を持つ (配下 option 件数)。
  childOptionCount?: number
  // 紐付き card 件数。 両 kind で使う。
  cardCount: number
  onConfirm: () => void
  onCancel: () => void
}

// 100 以上は「100+」 に省略。 削除確認文脈では「正確な件数」 より「だいぶ多い」
// を伝えるほうが意思決定に資するため、 上限超は丸める。
function formatCount(n: number): string {
  return n >= 100 ? '100+' : String(n)
}

export function DeleteConfirmDialog({
  open,
  targetKind,
  targetName,
  childOptionCount,
  cardCount,
  onConfirm,
  onCancel,
}: Props) {
  const cardLabel = formatCount(cardCount)

  if (targetKind === 'category') {
    const optionLabel = formatCount(childOptionCount ?? 0)
    return (
      <ConfirmDialog
        open={open}
        title={`カテゴリ『${targetName}』 を削除しますか?`}
        description={
          <>
            配下の option {optionLabel} 件、 紐付き card {cardLabel} 件のタグも消えます。
            この操作は取り消せません。
          </>
        }
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        confirmVariant="destructive"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
  }

  return (
    <ConfirmDialog
      open={open}
      title={`option『${targetName}』 を削除しますか?`}
      description={
        <>{cardLabel} 件の card に紐付いています。 この操作は取り消せません。</>
      }
      confirmLabel="削除する"
      cancelLabel="キャンセル"
      confirmVariant="destructive"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
