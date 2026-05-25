import { AppLoadingSkeleton } from '../../_components/loading-skeleton'

export default function Loading() {
  // card 個別編集 page (深い編集が要る場合の保険、 通常は試験詳細 inline で完結)。
  // editor フォーム想定で rows=4 (title / question / options / explanation)
  return <AppLoadingSkeleton rows={4} />
}
