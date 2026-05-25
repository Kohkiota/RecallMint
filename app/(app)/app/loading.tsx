// /app 共通 loading (子 route が個別 loading.tsx を持たない場合の fallback)。
// S-perf-1: クリック後に server SSR を待つ間、 即時 fallback を出して体感改善。
import { AppLoadingSkeleton } from './_components/loading-skeleton'

export default function Loading() {
  return <AppLoadingSkeleton />
}
