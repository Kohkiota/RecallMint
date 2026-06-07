// /app/tags 専用 loading skeleton。 共通 AppLoadingSkeleton ではなく
// tag manager の 2 column 構造を反映した固有 placeholder を用意することで、
// click 後 hydration までの体感を実 layout と揃える (S-perf-1)。
//
// 構造:
// - タイトル bar 1 本 (text-2xl h1 相当)
// - desktop (md+): 1/3 + 2/3 grid、 各 column に row placeholder 数本
// - mobile (< md): 縦 1 列の row placeholder

export default function TagsLoading() {
  return (
    <div
      className="space-y-6 md:space-y-3 animate-pulse"
      aria-label="loading"
      role="status"
    >
      <div className="h-8 w-32 rounded bg-slate-200" />

      <div className="hidden md:grid md:grid-cols-3 md:gap-6">
        <div className="col-span-1 space-y-2">
          <div className="h-10 rounded bg-slate-200" />
          <div className="h-10 rounded bg-slate-200" />
          <div className="h-10 rounded bg-slate-200" />
        </div>
        <div className="col-span-2 space-y-2">
          <div className="h-10 rounded bg-slate-200" />
          <div className="h-10 rounded bg-slate-200" />
        </div>
      </div>

      <div className="md:hidden space-y-2">
        <div className="h-10 rounded bg-slate-200" />
        <div className="h-10 rounded bg-slate-200" />
      </div>
    </div>
  )
}
