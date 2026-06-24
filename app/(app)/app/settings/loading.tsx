import { AppContainer } from '../_components/app-container'
import { AppLoadingSkeleton } from '../_components/loading-skeleton'

export default function Loading() {
  // プラン / 学習設定 / 危険な操作 / 法的情報 の 4 section 想定
  return (
    <AppContainer>
      <AppLoadingSkeleton rows={4} />
    </AppContainer>
  )
}
