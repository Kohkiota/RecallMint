import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { AppHeader } from './_components/app-header'
import { BFCacheGuard } from './_components/bfcache-guard'
import { PullTrigger } from './_components/pull-trigger'
import { ReviewFlushTrigger } from './_components/review-flush-trigger'
import { EntityMutationFlushTrigger } from './_components/entity-mutation-flush-trigger'
import { MediaSweepTrigger } from './_components/media-sweep-trigger'
import { HygieneSweepTrigger } from './_components/hygiene-sweep-trigger'
import { ExamStatusProvider } from './_components/exam-status-live'
import { getExamStatusMap } from '@/lib/exams/source-doc-status'

// webhook race（sign-up 直後 〜 user.created webhook 受信前の数秒）で
// DB に行が無い間に表示する transitional UI。<meta http-equiv="refresh">
// で 2 秒後に自動 reload し、webhook 同期が間に合えば通常 layout に切替わる。
function SyncingPage() {
  return (
    <>
      <meta httpEquiv="refresh" content="2" />
      <main className="min-h-screen flex flex-col items-center justify-center p-4 bg-slate-50">
        <h1 className="text-2xl font-bold text-slate-900 mb-2">
          アカウントを準備しています…
        </h1>
        <p className="text-slate-600">数秒お待ちください。</p>
      </main>
    </>
  )
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()

  if (!user) {
    // webhook race: DB 行欠損のため syncing UI を render し、
    // children は描画しない（/app/** 配下は user 前提のため）。
    return <SyncingPage />
  }

  if (user.deletedAt) {
    redirect('/sign-out-deleted')
  }

  // user 確定後に owner-scope でステータス取得し provider の seed として渡す。
  // layout は server component なので server-only モジュール import・呼出 OK。
  const statusMap = await getExamStatusMap(user.id)

  return (
    <ExamStatusProvider
      initialStatuses={Object.fromEntries(statusMap)}
      userId={user.id}
    >
      <div className="min-h-screen flex flex-col">
        {/* BFCache 復元時（back/forward）の zombie state を防ぐ。
            pageshow event.persisted=true 検知 → server reload で
            middleware/layout の deletedAt チェックを再 trigger する。 */}
        <BFCacheGuard />
        {/* (app) 配下に最初に入った時点で cards / exams / study_days を Dexie に
            background pull する (cache-fix roadmap ④-1)。 layout 持続中の内部
            navigation では re-mount しないので重複発火しない。 deep link / reload /
            外部からの navigate でも 1 回 fire される。 UI なし、 失敗 silent。 */}
        <PullTrigger userId={user.id} />
        {/* 演習 push の保全 trigger。 演習画面を離れた後の未送信 pending を mount /
            フォーカス復帰 / 再接続時に回復 flush する (Web Locks 多タブ排他 + transient
            backoff retry は controller 側)。 UI なし、 失敗 silent。 */}
        <ReviewFlushTrigger userId={user.id} />
        {/* entity-mutation push の保全 trigger (S-sync-1 で旧 card-mutation-flush-trigger を
            汎用化、 配線は不変)。 inline 編集後の未送信 pending を mount / フォーカス復帰 /
            再接続 / pagehide 時に回復 flush する。 ReviewFlushTrigger と同 controller
            (createReviewFlushController) を deps 注入で entity-mutation 用に再利用
            (review-flush.ts 無変更)。 全 entity_type の pending を 1 回の汎用 flush で
            送信する (entity 別 trigger は持たない)。 UI なし、 失敗 silent。 */}
        <EntityMutationFlushTrigger userId={user.id} />
        {/* 画像フェーズ A: 起動時 self-heal sweep trigger。 stale 'uploading'(1h 超)の
            後始末 + 中断デッキ DL job('downloading' 残骸)の掃除を mount 1 回 kick する
            (Web Lock 多重タブ排他は sweepStaleMedia 内部、 UI なし、 失敗 silent)。 */}
        <MediaSweepTrigger userId={user.id} />
        {/* hygiene sprint: 共有ブラウザに残る **異 owner** のローカル残骸(mirror /
            異 owner の synced outbox / 'ready' assets / 'done' jobs / bare + 異 owner の
            sync_meta / 異 owner の Cache blob)を mount 1 回 kick で回収する。 自 owner の
            データと不可侵集合(pending 系 outbox・非 'ready' assets・'downloading' jobs)は
            owner を問わず触らない。 UI なし、 失敗 silent。 */}
        <HygieneSweepTrigger userId={user.id} />
        <AppHeader />
        <main className="flex-1 w-full">
          {children}
        </main>
      </div>
    </ExamStatusProvider>
  )
}
