import { cn } from '@/lib/utils'

// 各 (app) page が max-w-4xl キャップを自前で持つための共有 wrapper。
// app/(app)/app/layout.tsx の <main> から幅 cap を外し (flex-1 w-full のみ)、
// 代わりに本 component を page 単位で使用する (Edit-1 T1)。
// 試験詳細 page など特定 page が全幅に逃げる際は className で上書き可能。
export function AppContainer({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('mx-auto w-full max-w-4xl px-4 py-8', className)}>
      {children}
    </div>
  )
}
