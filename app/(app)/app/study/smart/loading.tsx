import { AppLoadingSkeleton } from '../../_components/loading-skeleton'

export default function Loading() {
  // 復習画面は 1 card 単位の表示なので rows=1 にして「問題文枠」 1 つだけ仮表示
  return <AppLoadingSkeleton rows={1} />
}
