'use client'

// ExamListLive — 試験一覧の list / 空状態を Dexie mirror (useLiveQuery) から表示する
// client component。 page.tsx (RSC) から切り出すことで:
// - getActiveExamsWithCardCount の DB SELECT を撤去 (RSC → Dexie 参照に切替)
// - Dexie 書込み (delete 等) が即時 list に live 反映される (refresh 不要)
// - mount 直後の useLiveQuery undefined 期間は skeleton で layout shift を防ぐ
//
// card_count は exams.card_count を使わず cards mirror から動的集計する。
// これにより server 側の非正規化列との整合性ズレを気にしない local-first な
// 表示が可能になる。
//
// ExamStatusBadge は ExamStatusContext を購読するため、本 component は
// page.tsx の <ExamStatusProvider> の内側で render される必要がある。

import Link from 'next/link'
import { useLiveQuery } from 'dexie-react-hooks'
import { getClientDb } from '@/lib/client-db'
import { formatRelativeJa } from '@/lib/exams/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteExamButton } from './delete-exam-button'
import { OpenCreateExamButton } from './open-create-exam-button'
import { ExamStatusBadge } from '../../_components/exam-status-live'

export function ExamListLive({ userId }: { userId: string }) {
  const exams = useLiveQuery(async () => {
    const db = getClientDb()
    const allExams = await db.exams.where('user_id').equals(userId).toArray()

    const activeExams = allExams
      .filter((e) => e.archived_at == null) // undefined も null も除外 (archived)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)) // ISO 文字列の辞書順 DESC

    // T-B4: per-exam materialize 0 の構造保証。
    // - compound index `[user_id+exam_id]` (Dexie v6) で第 1 要素 user_id を equals fix
    //   → 他 user の cards に index 経路で構造的に到達不能 (owner isolation 担保、
    //   既存 test #6 を index 構造で satisfy。 perf のためのガード撤去はしない)
    // - count() は filter 不要のため Dexie 内部で isPlainKeyRange true →
    //   native `IDBIndex.count(IDBKeyRange)` 直送 = row 本体 fetch なしの B-tree range count
    // - JS filter (.and() / .filter()) を絶対に乗せないこと (cursor 走査に落ちて
    //   materialize 0 が崩れ、 T-B4 の意味が消える。 spec §2.4 確証はこの形が前提)
    // - cards table への subscription は `where('[user_id+exam_id]')` 経由でも維持 →
    //   server pull / optimistic mutation 双方で自動再描画される
    const counts = await Promise.all(
      activeExams.map((e) =>
        db.cards.where('[user_id+exam_id]').equals([userId, e.id]).count(),
      ),
    )

    return activeExams.map((e, i) => ({
      id: e.id,
      name: e.name,
      updatedAt: e.updated_at,
      cardCount: counts[i],
    }))
  }, [userId])

  // 1) skeleton — useLiveQuery が Dexie からの値を解決するまで undefined を返す。
  //    dashboard-actions.tsx の role="status" + animate-pulse パターンに倣い、
  //    一覧相当の 3 行 skeleton card を出して layout shift を防ぐ。
  if (exams === undefined) {
    return (
      <div role="status" aria-label="読み込み中" className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[72px] w-full rounded-lg bg-slate-200 animate-pulse"
          />
        ))}
      </div>
    )
  }

  // 2) 空状態 CTA — active exam が 0 件のとき (page.tsx からの移植、文言・class 維持)
  if (exams.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-3">
          <p className="text-slate-700">まだ試験がありません。</p>
          {/* 空状態 CTA 2択 (spec §2.2): アップロード起点 / 手動作成起点。
              OpenCreateExamButton は page 上部の CreateExamForm の
              展開トリガーボタンに委譲する client component。 */}
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <Button asChild>
              <Link href="/app/upload" prefetch={false}>アップロードから始める</Link>
            </Button>
            <OpenCreateExamButton />
          </div>
        </CardContent>
      </Card>
    )
  }

  // 3) list — active exam の行一覧 (page.tsx からの移植、class/prefetch 維持)
  return (
    <ul className="space-y-2">
      {exams.map((exam) => (
        <li key={exam.id}>
          <Card>
            <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{exam.name}</span>
                  {/* 処理中 / 失敗バッジは ExamStatusContext (ExamStatusProvider wrap 済)
                      から取得。 completed exam は context に entry なし = 非表示。 */}
                  <ExamStatusBadge examId={exam.id} />
                </div>
                <div className="text-xs text-slate-500">
                  カード {exam.cardCount} 件 ・ 最終更新{' '}
                  {/* updatedAt は ISO 文字列 (Dexie 統一)、formatRelativeJa は Date を取る */}
                  {formatRelativeJa(new Date(exam.updatedAt))}
                </div>
              </div>
              <div className="flex items-start gap-2 shrink-0">
                <Button asChild variant="outline" size="sm">
                  {/* S-perf-1: 試験一覧 N 件分の Link が viewport 内で
                      並列 prefetch されると server SSR が N 件並列で走るため
                      prefetch={false}。 click 時の navigation 自体は維持、
                      遷移 fallback は loading.tsx で吸収。 */}
                  <Link href={`/app/exams/${exam.id}`} prefetch={false}>
                    詳細を見る
                  </Link>
                </Button>
                <DeleteExamButton examId={exam.id} />
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
