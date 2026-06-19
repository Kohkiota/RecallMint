// exam-card-bulk-delete-dialog — Grid-2 T5: bulk 削除の確認 modal。
// 汎用 ConfirmDialog (focus 移動 / Esc / backdrop close / portal を担保) の薄い wrapper。
// count を文言に反映し、 confirmVariant='destructive' で破壊的操作を明示する。
//
// 'use client' は付けない: hooks を持たず ConfirmDialog (client) を render するだけ。
// import 元 = action bar (client) が boundary を確立する (周辺 wrapper の慣習に合わせる)。

import { ConfirmDialog } from '@/components/ui/confirm-dialog'

type Props = {
  open: boolean
  count: number
  onConfirm: () => void
  onCancel: () => void
}

export function ExamCardBulkDeleteDialog({ open, count, onConfirm, onCancel }: Props) {
  return (
    <ConfirmDialog
      open={open}
      title="カードを削除しますか?"
      description={`選択した ${count} 件のカードを削除します。元に戻せません。`}
      confirmLabel="削除する"
      confirmVariant="destructive"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
