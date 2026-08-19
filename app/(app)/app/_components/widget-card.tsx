import { Card, CardAction, CardContent, CardHeader } from '@/components/ui/card'

// Home の W2〜W7 が共有するウィジェット枠 (spec §12)。shadcn Card の薄い wrapper で、
// 新 primitive は作らない。
//
// 設計判断:
// - heading は h2 固定。page 側 h1 の下の階層を部品で担保する (呼び出し側が level を
//   選べると widget ごとに階層が割れる)。
// - loading / empty / error の状態 API は持たせない。各 widget が自分の取得経路に応じて
//   children に描く責務 (spec §12 — 部品は骨格のみ)。
// - CardTitle (text-base の div) でなく自前 h2。widget は「数値が主・見出しは label」の
//   序列なので、見出しは小さく muted に落とし metric を最大の要素にする。
// - metric は tabular-nums。mirror 更新で値が差し替わるため、桁幅が動くと数字が揺れる。
export function WidgetCard({
  header,
  metric,
  delta,
  action,
  children,
}: {
  header: React.ReactNode
  metric: React.ReactNode
  delta?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-sm leading-snug font-medium text-muted-foreground">
          {header}
        </h2>
        {/* 空判定は `!= null` のみ。 slot は ReactNode ゆえ 0 や "" も有効な内容で、
            truthiness で畳むと 0 の delta (増減なし) が消える。
            呼び出し側は「出さない」を `cond ? <X/> : undefined` で表すこと —
            `cond && <X/>` は false を渡すため空の CardAction が生き、 CardHeader が
            2 カラム grid に切り替わる (見た目はほぼ同じだが意図しない状態)。 */}
        {action != null ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl leading-none font-semibold tabular-nums">
            {metric}
          </span>
          {delta != null ? <span className="text-sm">{delta}</span> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}
