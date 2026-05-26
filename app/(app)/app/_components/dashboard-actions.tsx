'use client'

// DashboardActions — dashboard の CTA 2 button (S-perf-3 で IDB 化)。
// `dueCount` を server SSR の props 経由ではなく Dexie `cards` (S-local-2 で mirror
// 済) から `useLiveQuery` で算出する。 これにより page.tsx の RSC 内 1 SELECT を
// 撤去でき、 さらに スマート復習 で答えた直後の Dexie 書込みが live で button 件数
// に反映される (= refresh 不要)。
//
// 役割境界:
// - server SSR の dueCount に依存しない。 props は userId と (test 注入用) now のみ。
// - 未 pull / mount 直後の useLiveQuery undefined 状態は skeleton で表示 (layout
//   shift 防止)。 既存 DashboardStats と同 pattern。
// - 右 button は「カスタム演習（準備中）」 で常時 disabled (S2.3 で復活予定)。
//
// 比較戦略:
// - cards.due は ISO8601 文字列 (Dexie 統一)。 lexicographic compare で `card.due
//   <= nowIso` が時系列正しく動く (get-dexie-session-cards.ts と同方針)。

import Link from 'next/link'
import { useLiveQuery } from 'dexie-react-hooks'
import { Button } from '@/components/ui/button'
import { getClientDb } from '@/lib/client-db'

export function DashboardActions({
  userId,
  now,
}: {
  userId: string
  // test 注入用。 production では undefined → useLiveQuery 内部で new Date() を都度
  // 評価 (= live なので秒単位の経過に追従するが、 dashboard CTA としては問題なし)。
  now?: Date
}) {
  const dueCount = useLiveQuery(
    async () => {
      const nowIso = (now ?? new Date()).toISOString()
      const cards = await getClientDb()
        .cards.where('user_id')
        .equals(userId)
        .toArray()
      return cards.filter((c) => c.due <= nowIso).length
    },
    // userId は依存に含める (component 再利用時の query 切替に追従)。 now が固定
    // Date のときは固定 nowIso、 undefined のときは初回 mount の now 固定でよく、
    // useLiveQuery の再評価は Dexie 変化通知が trigger するため deps に now は入
    // れない (test 注入は mount 時のみ評価で十分)。
    [userId],
  )

  if (dueCount === undefined) {
    return (
      <div
        role="status"
        aria-label="読み込み中"
        className="grid grid-cols-2 gap-3"
      >
        <div className="h-[60px] w-full rounded-xl bg-slate-200 animate-pulse" />
        <Button
          size="lg"
          className="w-full py-4 text-lg font-bold rounded-xl"
          disabled
        >
          カスタム演習（準備中）
        </Button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {dueCount > 0 ? (
        <Button asChild size="lg" className="w-full py-4 text-lg font-bold rounded-xl">
          <Link href="/app/study/smart" prefetch={false}>
            スマート復習（{dueCount}件）
          </Link>
        </Button>
      ) : (
        <div className="block w-full py-4 bg-slate-200 text-slate-500 rounded-xl text-center font-bold text-lg">
          復習完了！
        </div>
      )}
      <Button
        size="lg"
        className="w-full py-4 text-lg font-bold rounded-xl"
        disabled
      >
        カスタム演習（準備中）
      </Button>
    </div>
  )
}
