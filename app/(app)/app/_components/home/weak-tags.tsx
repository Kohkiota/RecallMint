'use client'

// WeakTags(W4)— 苦手タグ Top3(定義 doc §4-P / W4)。v1 で唯一の L3(server 集計)。
//
// 応答の扱いで守ること:
// - **応答全体を zod で検証する**。配列の中身だけ見ると、echo の欠落や型崩れを
//   「候補 0」として黙って空表示してしまう。
// - **描画条件は echo 2 本(owner_user_id / exam_id)の一致**(spec §9.2-3)。
//   sign-up race(users 行が未同期)では endpoint が **400 ではなく echo 無しの 200**
//   を返す — `withReadOnlyAuth` の静的 emptyBody の構造的帰結。「400 だけが不正の
//   信号」と考えると、この応答を「苦手タグは無い」と誤って断定する。
// - **別試験の exam_id echo が付いた応答は捨てる**(試験切替の遅着)。捨てるだけで
//   失敗表示にはしない — 正しい試験の取得が別途進行中だから。
// - 失敗は §3.8 の 4 状態区別に従い、候補 0(非表示)と**別の表示**にする。陳腐
//   (取得済みだが古い)は v1 では実装しない(キャッシュ保持契約が無い段階では
//   失敗時可視化のみに倒す — 定義 doc の保守側裁定)。
//
// 「今日」の評価時刻: 30 日窓は server の `receivedAt` で切られ、Home の `now` とは
// 日跨ぎ付近で最大数分ずれうる。v1 では受容する(揃えるには now を往復させる契約が
// 要り、W4 の精度要求に見合わない)。

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { WidgetCard } from '../widget-card'

const weakTagSchema = z.object({
  option_id: z.string(),
  name: z.string(),
  category_name: z.string(),
  review_accuracy: z.number(),
  card_count: z.number(),
})

// echo 2 本は optional: sign-up race の空 200 には載らないため必須にすると
// 「schema 不正」と「照合不能」を同じ失敗に潰してしまう。**必須にする代わりに
// 描画条件として一致を要求する**(欠落 = 照合不能 = 表示しない)。
const summaryResponseSchema = z.object({
  owner_user_id: z.string().optional(),
  exam_id: z.string().optional(),
  weak_tags: z.array(weakTagSchema),
})

type WeakTagRow = z.infer<typeof weakTagSchema>

type FetchState = { kind: 'failed' } | { kind: 'loaded'; rows: WeakTagRow[] }

export function WeakTags({
  userId,
  examId,
}: {
  userId: string
  examId: string
}): React.JSX.Element | null {
  // 結果は取得元の (owner, 試験) と対で持つ。切替直後に「前の試験の結果」を出さない
  // ための reset を、effect 内の同期 setState ではなく **鍵の不一致 = 読込中** という
  // 導出で表す(react-hooks/set-state-in-effect: effect 内の同期 setState は
  // cascading render になる)。
  const key = `${userId}|${examId}`
  const [result, setResult] = useState<{ key: string; state: FetchState } | null>(null)
  const state: FetchState | null = result?.key === key ? result.state : null

  useEffect(() => {
    const controller = new AbortController()
    const setState = (next: FetchState) => {
      // abort 済み (unmount / 試験切替) の応答は成功・失敗を問わず捨てる。
      // 捨てないと、 前の試験の遅着応答が新しい試験の結果を上書きし、 鍵不一致に
      // 化けて widget ごと消える (再取得の契機も無い)。
      if (controller.signal.aborted) return
      setResult({ key, state: next })
    }

    void (async () => {
      try {
        const res = await fetch(`/api/stats/summary?exam_id=${examId}`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          setState({ kind: 'failed' })
          return
        }
        const parsed = summaryResponseSchema.safeParse(await res.json())
        if (!parsed.success) {
          setState({ kind: 'failed' })
          return
        }
        const body = parsed.data
        // 描画条件 = echo 2 本の一致(spec §9.2-3)。
        if (body.owner_user_id !== userId || body.exam_id !== examId) {
          // 不一致の内訳を 1 つだけ別扱いにする: **別試験の応答** は試験切替の
          // 遅着なので捨てるだけ(正しい試験の取得が別途進行中)。それ以外
          // (owner 不一致 / echo 欠落)は照合不能なので失敗として見せる。
          if (body.exam_id !== undefined && body.exam_id !== examId) return
          setState({ kind: 'failed' })
          return
        }
        setState({ kind: 'loaded', rows: body.weak_tags })
      } catch {
        // abort は unmount / 試験切替の正常経路。 捨てる判断は setState に集約。
        setState({ kind: 'failed' })
      }
    })()

    return () => controller.abort()
  }, [key, userId, examId])

  if (state === null) return null
  if (state.kind === 'failed') {
    return (
      <WidgetCard
        header="優先して復習"
        metric={
          <span className="text-base font-normal text-muted-foreground">
            読み込めませんでした
          </span>
        }
      />
    )
  }
  // 候補 0 はウィジェットごと非表示(閾値未満は「苦手が無い」ではなく判定していない
  // だけ — 定義 doc §4-P。「苦手なタグはありません」も出さない)。
  if (state.rows.length === 0) return null

  return (
    <WidgetCard
      header="優先して復習"
      metric={
        <span
          data-testid="weak-tags-lead"
          className="text-base font-normal text-muted-foreground"
        >
          直近 30 日の復習で正答率が低い分野です
        </span>
      }
    >
      <ul className="divide-y divide-border">
        {state.rows.map((row) => (
          <li
            key={row.option_id}
            data-testid={`weak-tag-${row.option_id}`}
            className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {row.name}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {row.category_name}
                </span>
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                正答率 {row.review_accuracy}% ・ 対象 {row.card_count}問
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link
                href={`/app/study/quick?exam=${examId}&tag=${row.option_id}`}
                prefetch={false}
              >
                この分野を 10 問
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </WidgetCard>
  )
}
