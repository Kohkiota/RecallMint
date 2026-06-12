import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings } from '@/lib/db/schema'
import { createBillingPortalSession } from './actions'
import { DeleteAccountButton } from './delete-button'
import { SessionLimitForm } from './_components/session-limit-form'
import { FsrsModeForm } from './_components/fsrs-mode-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PAID_PLAN_CATALOG, planLabelFor } from '@/lib/plan-catalog'
import { resolveFromPriceId } from '@/lib/stripe/price-mapping'
import { signDeletionToken } from '@/lib/security/deletion-token'

// 解約予定日 / ダウングレード予約発効日を日本語ロケールの YYYY/MM/DD 形式に整形する
// Intl.DateTimeFormat を使い、ロケール依存の区切り文字を統一する
// (upgrade page にも同一 formatEffectiveDate があるが、 cross-module 結合を
//  避けるため共有 helper 化せず複製する既存方針に従う、 upgrade/page.tsx:11-12 参照)
function formatCancelDate(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) return null

  // 学習設定: user_settings を owner-scoped SELECT (行不在は sessionLimit=20 の暫定値)
  const db = getDb()
  const settingsRows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, user.id))
    .limit(1)
  const sessionLimit = settingsRows[0]?.sessionLimit ?? 20
  const fsrsMode = settingsRows[0]?.fsrsMode ?? false

  // audit §10.4 #11 / T-A9: 削除 status polling URL を signed token 経由化。
  // page render 時点で 24h ttl token を発行し client (delete-button) に prop
  // で渡す。 削除実行から polling までは数分〜数十秒 (POLL_MAX_ATTEMPTS=30 sec) で
  // ttl 24h は十分。 token 内 userId は clerkId なので client 側で別途保存する
  // 必要なし (token が単一の認可 + 識別 source)。
  // clerkId は schema 上 nullable (GDPR scrub 後 NULL) だが、 active session で
  // settings page に到達する user は必ず非 null。 防御的に空文字 fallback で
  // 渡し、 client 側は polling 経路に入る前に user.delete() が成功している前提で
  // token を使う (空 token → 401 で polling は no-op timeout で sign-out-deleted へ
  // 強制 navigate される既存 zombie-net で吸収)。
  const deletionStatusToken = user.clerkId
    ? signDeletionToken(user.clerkId)
    : ''

  // ダウングレード予約 (方針C) の表示用ラベル整形。 cancelAt 優先のため、 cancelAt
  // 不在で scheduledDowngradeScheduleId set のときだけ JSX 側で表示する。 ここでは
  // price → 短縮ラベル ("Standard 月額") / date → YYYY/MM/DD を確定する。
  // 整形パターンは upgrade page (app/(app)/app/upgrade/page.tsx:54-69) を inline
  // 複製 (cross-module 結合を避ける既存方針)。
  // 同条件を MF-4 (Portal ボタン非活性化) でも参照するため真偽値を 1 度だけ束ねる。
  const isDowngradeReserved =
    user.plan !== 'free' &&
    !user.cancelAt &&
    user.scheduledDowngradeScheduleId != null
  let scheduledTargetLabel: string | undefined
  let scheduledEffectiveDate: string | undefined
  if (isDowngradeReserved) {
    if (user.scheduledTargetPriceId) {
      const mapping = resolveFromPriceId(user.scheduledTargetPriceId)
      if (mapping) {
        const tier = PAID_PLAN_CATALOG[mapping.plan].label
        const intervalText = mapping.interval === 'year' ? '年額' : '月額'
        scheduledTargetLabel = `${tier} ${intervalText}`
      }
    }
    if (user.scheduledChangeEffectiveAt) {
      scheduledEffectiveDate = formatCancelDate(user.scheduledChangeEffectiveAt)
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">設定</h1>

      <section>
        <h2 className="font-bold mb-2">プラン</h2>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-700">
              現在: <span className="font-medium">{planLabelFor(user.plan, user.billingInterval)}</span>
            </p>
            {user.plan !== 'free' && user.cancelAt ? (
              // 解約予約中: cancel_at != null が解約予約中の signal (最優先表示)。
              // 「両方 set」 (解約予約 + ダウングレード予約) は path 上成立しうるが
              // (調査済)、 cancelAt 優先 = 解約が最終決定とみなして表示する。
              <p className="text-xs text-amber-700 mt-1">
                解約予約中、{formatCancelDate(user.cancelAt)} 終了
              </p>
            ) : user.plan !== 'free' && user.scheduledDowngradeScheduleId ? (
              // 方針C ダウングレード予約中: scheduledDowngradeScheduleId が
              // 真実 source。 cancelAt 不在のときのみ表示する (上の cancelAt 分岐に
              // 落ちれば優先される)。
              <p className="text-xs text-amber-700 mt-1">
                {scheduledEffectiveDate ? `${scheduledEffectiveDate} に ` : ''}
                {scheduledTargetLabel ?? '変更先プラン'} へ変更予約中
              </p>
            ) : user.subscriptionStatus ? (
              <p className="text-xs text-slate-500 mt-1">
                ステータス: {user.subscriptionStatus}
              </p>
            ) : null}
            {/* §7.3 + §7.4 拡張: 全 plan で「プラン変更」 CTA を常時表示し、
                free 限定の「プランを選択」 文言は廃止 (entry CTA 文言の出し分け
                を削除。 dashboard /app の §7.4 統一を settings にも波及)。
                「お支払い・解約を管理」 (Portal) は paid 限定を維持 — free は
                Stripe customer 不在で createBillingPortalSession が throw する
                経路 (actions.ts:15-17)。
                MF-4: ダウングレード予約中 (cancelAt 不在 かつ
                scheduledDowngradeScheduleId set) は Portal ボタンを非活性化し
                取消導線 (「プラン変更」 → upgrade page) へ誘導する誤操作防止 UX。
                整合は webhook 方向2 で担保済のため client 表示のみ。 */}
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                {user.plan !== 'free' && (
                  <form action={createBillingPortalSession}>
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      disabled={isDowngradeReserved}
                      className="px-4 py-2 text-sm font-medium"
                    >
                      お支払い・解約を管理
                    </Button>
                  </form>
                )}
                <Button asChild size="sm" className="px-4 py-2 text-sm font-medium">
                  {/* S-perf-1 follow-up: dashboard と同方針で /app/upgrade prefetch を切る。 */}
                  <Link href="/app/upgrade" prefetch={false}>プラン変更</Link>
                </Button>
              </div>
              {isDowngradeReserved && (
                <p className="text-xs text-amber-700">
                  ダウングレード予約中は支払い管理を開けません。先に「プラン変更」 から予約を取り消してください。
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* 学習設定 section — プランの次、危険な操作の前 */}
      <section>
        <h2 className="font-bold mb-2">学習設定</h2>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-700 mb-3">
              1 セッションあたりの最大 card 数
            </p>
            <SessionLimitForm initial={sessionLimit} />

            <div className="mt-6 border-t border-slate-200 pt-4">
              <p className="text-sm text-slate-700 mb-1">回答評価の入力方式</p>
              <p className="text-xs text-slate-500 mb-3">
                オフ: 正誤を自動で FSRS rating にマッピング。
                オン: Again/Hard/Good/Easy を自分で選択 (上級者向け)。
              </p>
              <FsrsModeForm initial={fsrsMode} />
            </div>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="font-bold mb-2 text-red-700">危険な操作</h2>
        <Card className="ring-red-200">
          <CardContent>
            <p className="text-sm text-slate-700 mb-3">
              アカウントを削除します。登録したカードと学習履歴は復元できません。
            </p>
            <DeleteAccountButton plan={user.plan} deletionStatusToken={deletionStatusToken} />
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="font-bold mb-2">法的情報</h2>
        <Card>
          <CardContent>
            {/* S-perf-1: 法的 4 link は閲覧率が低く、 全件 default prefetch すると
                settings page 表示時の並列 RSC SSR を 4 件積み増す。 prefetch={false}
                で抑制 (click 時の遷移は維持)。 */}
            <ul className="text-sm text-slate-700 space-y-2">
              <li>
                <Link href="/contact" prefetch={false} className="text-blue-700 hover:underline">
                  お問い合わせ
                </Link>
              </li>
              <li>
                <Link href="/terms" prefetch={false} className="text-blue-700 hover:underline">
                  利用規約
                </Link>
              </li>
              <li>
                <Link href="/privacy" prefetch={false} className="text-blue-700 hover:underline">
                  プライバシーポリシー
                </Link>
              </li>
              <li>
                <Link href="/legal" prefetch={false} className="text-blue-700 hover:underline">
                  特定商取引法に基づく表記
                </Link>
              </li>
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
