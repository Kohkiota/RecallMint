import { AppLoadingSkeleton } from '../../_components/loading-skeleton'

export default function Loading() {
  // 試験詳細は inline 編集 card が並ぶ画面。 rows=5 で 1 画面分の placeholder を出す
  // (実際の card 数は表示後に確定するため、 placeholder 段数はあくまで体感向上目的)。
  return <AppLoadingSkeleton rows={5} />
}
