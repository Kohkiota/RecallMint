import { AppContainer } from '../_components/app-container'
import { AppLoadingSkeleton } from '../_components/loading-skeleton'

export default function Loading() {
  return (
    <AppContainer>
      <AppLoadingSkeleton rows={3} />
    </AppContainer>
  )
}
