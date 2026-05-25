// 共通 loading skeleton。 app/(app)/app/**/loading.tsx から再利用する。
// 目的は「クリック直後の即時 fallback UI 表示」 と「streaming 境界の形成」 のみ
// (server SSR 負荷削減ではない、 S-perf-1)。 各 page で固有 UI を作るほど投資する
// 価値はないため、 軽量 placeholder を 1 つ用意して全 page で使う。
//
// 構造: h1 サイズの bar 1 本 + content card 3 段。 max-w / mx-auto / py は
// `/(app)/app/layout.tsx` 内 main 側で揃えているため、 ここでは余白指定なし。

export function AppLoadingSkeleton({
  rows = 3,
}: {
  rows?: number
}) {
  return (
    <div className="space-y-4 animate-pulse" aria-label="loading" role="status">
      <div className="h-8 w-48 rounded bg-slate-200" />
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg bg-slate-100" />
        ))}
      </div>
    </div>
  )
}
