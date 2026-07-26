#!/usr/bin/env tsx
// Stripe Test Clock による downgrade / 予約取消 の回帰検証を「毎回同じ動作で回す」ための
// CC 担当パート(下ごしらえ / 時間送り / 観測 / 掃除)スクリプト。fact-finding =
// docs/audit/2026-07-09-stripe-test-clock-reservation-verification.md / 運用 doc =
// docs/ops/stripe-test-clock-verify-runbook.md。
//
// 実行(既存慣行・server-only import のため --conditions=react-server 必須):
//   node --env-file=.env.local --conditions=react-server --import tsx \
//     scripts/stripe-test-clock-verify.ts <subcommand> --user-id=<uuid> [--interval=month|year]
//   (= pnpm 経由なら: pnpm dlx でなく直接 node。tsx でも可: DATABASE_URL_APP 等を .env.local から)
//
// subcommand(人力 UI 操作を挟むため分割起動):
//   setup       : test clock 作成 → clock 付き customer 作成(+ test PM default 添付)→
//                 固定 user 行を baseline(free / stripe_customer_id=clock 顧客 / sub・予約列 clear)へ set。
//                 完了後、人力(OT)が「ログイン → app UI で upgrade Checkout → downgrade / 予約取消」を行う。
//   observe     : advance 前後で使う。users 課金列 + Stripe(sub / schedule)を dump し、
//                 DB↔Stripe の整合(決済経路が壊れていないか)を info 表示。--label=before|after 任意。
//   advance     : user の stripe_customer_id → customer.test_clock + active sub を辿り、
//                 sub.current_period_end + buffer へ clock を advance → status=ready まで polling。
//   cleanup     : customer → sub cancel → customer delete → clock delete(cascade 非依存の明示順)→
//                 固定 user 行を reset。
//
// ★ 責務境界(絶対): 予約を打つ / 取り消す独自ロジック(scheduleDowngrade /
//    cancelScheduledDowngrade / webhook release gate)と Checkout の生成は **app UI 経由必須**。
//    本 script は再実装しない(迂回すると独自層が未検証になる穴)。setup / advance / observe /
//    cleanup の 4 責務限定。
//
// ★ DB は app-role のみ(DATABASE_URL_APP + withTenantTx(固定 user.id))。owner/admin は使わない
//    (RLS-P1: owner を常設環境に置かない原則を CC 経由でも守る)。全 DB 操作は「自分の行」限定で
//    users_select/_update policy(id = app_current_user_id())下を通る。
//
// 安全性(多層 prod/live guard):
//   L1: VERCEL_ENV/NODE_ENV=production → 即 exit(1)。
//   L2: STRIPE_SECRET_KEY が rk_test_/sk_test_ でなければ exit(1)(Test Clock は test mode 専用)。
//   L3: DATABASE_URL_APP に stg/test/dev/localhost/127.0.0.1 のいずれも含まれなければ exit(1)
//       (prod DB 誤操作防止・TESTCLOCK_FORCE=1 で bypass 可)。
//   L4: --user-id(uuid)必須。setup/advance は --interval=month|year 必須。

import { eq } from 'drizzle-orm'
import Stripe from 'stripe'

import { withTenantTx } from '@/lib/db/tenant-tx'
import { users } from '@/lib/db/schema'
import { resolveFromPriceId } from '@/lib/stripe/price-mapping'

// Test Clock 操作は `billing_clock_write` 権限が要る。app の STRIPE_SECRET_KEY(rk_ Restricted
// Key)は通常この権限を持たない(実測: StripePermissionError)。専用の clock 対応 test key を
// STRIPE_TEST_CLOCK_SECRET_KEY に置く(推奨・least-privilege で app key を広げない)。無ければ
// STRIPE_SECRET_KEY に fallback(OT が app key に billing_clock_write を足した場合に動く)。
const STRIPE_KEY = process.env.STRIPE_TEST_CLOCK_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? ''
let stripe!: Stripe

// --- args -----------------------------------------------------------------
type Args = { positional: string[]; flags: Record<string, string | boolean> }
function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} }
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      out.flags[k] = v ?? true
    } else {
      out.positional.push(a)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const sub = args.positional[0]
const userId = typeof args.flags['user-id'] === 'string' ? args.flags['user-id'] : ''
const interval =
  args.flags.interval === 'month' || args.flags.interval === 'year' ? args.flags.interval : null

// --- safety guards --------------------------------------------------------
function fail(msg: string): never {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
function guards(opts: { needInterval: boolean }) {
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') {
    fail('L1: production 環境では実行不可(Test Clock は test mode 専用)')
  }
  if (!STRIPE_KEY.startsWith('rk_test_') && !STRIPE_KEY.startsWith('sk_test_')) {
    fail(
      'L2: test key が無い。STRIPE_TEST_CLOCK_SECRET_KEY(推奨・billing_clock_write 権限付き)' +
        'または STRIPE_SECRET_KEY(rk_test_/sk_test_)を設定',
    )
  }
  const dbUrl = process.env.DATABASE_URL_APP ?? ''
  if (!dbUrl) fail('DATABASE_URL_APP is not set')
  const looksSafe = /stg|test|dev|localhost|127\.0\.0\.1/.test(dbUrl)
  if (!looksSafe && process.env.TESTCLOCK_FORCE !== '1') {
    fail('L3: DATABASE_URL_APP に stg/test/dev/localhost が無い(prod 疑い・TESTCLOCK_FORCE=1 で bypass 可)')
  }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) fail('L4: --user-id=<uuid> が必須')
  if (opts.needInterval && !interval) fail('L4: --interval=month|year が必須')
}

// --- DB helpers(app-role・自分の行限定)-----------------------------------
const OBSERVE_COLS = {
  plan: users.plan,
  billingInterval: users.billingInterval,
  subscriptionStatus: users.subscriptionStatus,
  currentPeriodEnd: users.currentPeriodEnd,
  cancelAt: users.cancelAt,
  stripeCustomerId: users.stripeCustomerId,
  stripeSubscriptionId: users.stripeSubscriptionId,
  scheduledDowngradeScheduleId: users.scheduledDowngradeScheduleId,
  scheduledTargetPriceId: users.scheduledTargetPriceId,
  scheduledChangeEffectiveAt: users.scheduledChangeEffectiveAt,
} as const

async function selectBilling() {
  const rows = await withTenantTx(userId, (tx) =>
    tx.select(OBSERVE_COLS).from(users).where(eq(users.id, userId)),
  )
  if (rows.length === 0) fail('固定 user 行が見つからない(id 誤り / deleted_at set / 未作成)')
  return rows[0]
}

// baseline / reset は「自分の行」の課金列のみ触る(clerk_id / deleted_at は不変 = 再ログイン維持)。
const CLEAN_BILLING = {
  plan: 'free' as const,
  billingInterval: null,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAt: null,
  stripeSubscriptionId: null,
  scheduledDowngradeScheduleId: null,
  scheduledTargetPriceId: null,
  scheduledChangeEffectiveAt: null,
}
async function setBaseline(stripeCustomerId: string) {
  await withTenantTx(userId, (tx) =>
    tx.update(users).set({ ...CLEAN_BILLING, stripeCustomerId }).where(eq(users.id, userId)),
  )
}
async function resetBilling() {
  await withTenantTx(userId, (tx) =>
    tx.update(users).set({ ...CLEAN_BILLING, stripeCustomerId: null }).where(eq(users.id, userId)),
  )
}

// --- Stripe helpers -------------------------------------------------------
async function firstSubscription(customerId: string): Promise<Stripe.Subscription | null> {
  const { data } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 })
  // active/trialing/past_due を優先、無ければ先頭(canceled 含む)を返す。
  return (
    data.find((s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due') ??
    data[0] ??
    null
  )
}

function scheduleIdOf(s: Stripe.Subscription | null): string | null {
  if (!s || !s.schedule) return null
  return typeof s.schedule === 'string' ? s.schedule : s.schedule.id
}

async function dumpStripe(customerId: string) {
  const s = await firstSubscription(customerId)
  let schedule: Stripe.SubscriptionSchedule | null = null
  const scheduleId = scheduleIdOf(s)
  if (scheduleId) schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
  const item = s?.items.data[0]
  const priceId = item?.price.id ?? null
  const mapped = priceId ? resolveFromPriceId(priceId) : null
  return {
    subscription: s
      ? {
          id: s.id,
          status: s.status,
          current_period_end: item?.current_period_end ?? null,
          priceId,
          mapped, // { plan, interval } | null(=script が Stripe→期待 plan を逆引き)
          cancel_at: s.cancel_at,
          cancel_at_period_end: s.cancel_at_period_end,
          scheduleId,
        }
      : null,
    schedule: schedule
      ? { id: schedule.id, status: schedule.status, end_behavior: schedule.end_behavior }
      : null,
  }
}

async function observe(label: string) {
  const db = await selectBilling()
  const st = db.stripeCustomerId ? await dumpStripe(db.stripeCustomerId) : null
  console.log(`\n===== observe [${label}] =====`)
  console.log('DB(users):', JSON.stringify(db, null, 2))
  console.log('Stripe:', JSON.stringify(st, null, 2))
  // DB↔Stripe 整合(決済経路の回帰観点): 現 Stripe sub の active price から逆引きした
  // (plan, interval) が DB と一致するか。lag/未反映は info(hard fail しない)。
  const mapped = st?.subscription?.mapped ?? null
  if (mapped) {
    const ok = db.plan === mapped.plan && db.billingInterval === mapped.interval
    console.log(
      `DB↔Stripe consistency: ${ok ? 'OK' : 'MISMATCH'} ` +
        `(DB=${db.plan}/${db.billingInterval} vs Stripe=${mapped.plan}/${mapped.interval})`,
    )
  } else if (st?.subscription) {
    console.log('DB↔Stripe consistency: (price 未マッピング — STRIPE_PRICE_* env 外の price)')
  } else {
    console.log('DB↔Stripe consistency: (Stripe sub 無し — 加入前 or 解約後)')
  }
}

// --- subcommands ----------------------------------------------------------
const TEST_PM = 'pm_card_visa' // Stripe test 共有 PaymentMethod

async function cmdSetup() {
  const now = Math.floor(Date.now() / 1000)
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: now,
    name: `recallmint-testclock-${interval}-${now}`,
  })
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    email: `komail9server+clerk_testclock@gmail.com`,
    description: `RecallMint Test Clock verify (${interval}) user=${userId}`,
  })
  // test PM を default に(advance 時の更新/切替請求が PM 無しで失敗しないように)。
  // attach は共有 token(pm_card_visa)を customer 固有 PM(pm_xxx)として複製し返すため、
  // default には token でなく **返り値の pm.id** を使う(token を渡すと "not attached" で失敗)。
  const pm = await stripe.paymentMethods.attach(TEST_PM, { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  // 固定 user 行を baseline(free + この clock 顧客)へ。app Checkout がこの顧客を再利用する。
  await setBaseline(customer.id)
  console.log('✅ setup 完了')
  console.log(`  test_clock = ${clock.id}(frozen=${now})`)
  console.log(`  customer   = ${customer.id}(test_clock 紐付き・PM=${TEST_PM} default)`)
  console.log(`  固定 user 行 = free / stripe_customer_id=${customer.id} / sub・予約列 clear`)
  console.log('\n👉 次に人力(OT):')
  console.log(`   1. stg に固定アカウントでログイン`)
  console.log(`   2. app UI で ${interval} プランに upgrade(Checkout — この clock 顧客の sub になる)`)
  console.log(`   3. app UI で downgrade もしくは 予約取消(= 検証本体の独自ロジック)`)
  console.log(`   その後 CC が: observe(before) → advance → observe(after) → cleanup`)
}

async function cmdAdvance() {
  const db = await selectBilling()
  if (!db.stripeCustomerId) fail('stripe_customer_id 未設定(setup 未実行 or reset 済)')
  const customer = await stripe.customers.retrieve(db.stripeCustomerId)
  if (customer.deleted) fail('customer が削除済')
  const clockId = typeof customer.test_clock === 'string' ? customer.test_clock : customer.test_clock?.id
  if (!clockId) fail('customer に test_clock が紐付いていない(clock 非対応顧客)')
  const s = await firstSubscription(db.stripeCustomerId)
  if (!s) fail('active subscription が無い(人力の upgrade Checkout 未実施?)')
  const item = s.items.data[0]
  const subInterval = item?.price.recurring?.interval
  if (subInterval !== interval) {
    fail(`--interval=${interval} だが sub の interval=${subInterval}(不一致・想定シナリオ違い)`)
  }
  const periodEnd = item?.current_period_end
  if (!periodEnd) fail('current_period_end 取得不可')
  // period_end の 1 日後へ 1 回で advance(罠3: 最短 sub の 2 課金間隔以内 = 十分内側)。
  const target = periodEnd + 86400
  console.log(`advance: clock=${clockId} → frozen_time=${target}(period_end ${periodEnd} + 1d)`)
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: target })
  // 非同期: status=ready まで polling(webhook 到達も advance 完了後)。
  for (let i = 0; i < 60; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (c.status === 'ready') {
      console.log('✅ advance 完了(status=ready)。webhook 反映まで数秒待って observe(after) 推奨。')
      return
    }
    if (c.status === 'internal_failure') fail('test clock advance が internal_failure')
    await new Promise((r) => setTimeout(r, 2000))
  }
  fail('advance が 120s 以内に ready にならなかった(要 Stripe dashboard 確認)')
}

async function cmdCleanup() {
  const db = await selectBilling()
  const customerId = db.stripeCustomerId
  if (customerId) {
    const customer = await stripe.customers.retrieve(customerId)
    if (!customer.deleted) {
      const clockId =
        typeof customer.test_clock === 'string' ? customer.test_clock : customer.test_clock?.id
      // cascade に依存せず明示順で削除(sub cancel → customer del → clock del)。
      const s = await firstSubscription(customerId)
      if (s && s.status !== 'canceled') {
        try {
          await stripe.subscriptions.cancel(s.id)
        } catch (e) {
          console.warn('  sub cancel 失敗(既に消えている可能性): ' + (e as Error).message)
        }
      }
      try {
        await stripe.customers.del(customerId)
        console.log(`  customer ${customerId} delete`)
      } catch (e) {
        console.warn('  customer del 失敗: ' + (e as Error).message)
      }
      if (clockId) {
        try {
          await stripe.testHelpers.testClocks.del(clockId)
          console.log(`  test_clock ${clockId} delete`)
        } catch (e) {
          console.warn('  clock del 失敗(auto-delete 対象): ' + (e as Error).message)
        }
      }
    }
  }
  await resetBilling()
  console.log('✅ cleanup 完了(固定 user 行 reset・clerk_id/deleted_at 不変 = 再利用可)')
}

// --- main -----------------------------------------------------------------
async function main() {
  const needInterval = sub === 'setup' || sub === 'advance'
  if (!['setup', 'observe', 'advance', 'cleanup'].includes(sub)) {
    fail('subcommand = setup | observe | advance | cleanup')
  }
  guards({ needInterval })
  // guards 通過後に client を張る(L2 で test key を確認済)。billing_clock_write が無い key は
  // 各 clock 呼出で StripePermissionError になる(実測・key 権限を OT が付与する)。
  stripe = new Stripe(STRIPE_KEY)
  switch (sub) {
    case 'setup':
      await cmdSetup()
      break
    case 'observe':
      await observe(typeof args.flags.label === 'string' ? args.flags.label : 'now')
      break
    case 'advance':
      await cmdAdvance()
      break
    case 'cleanup':
      await cmdCleanup()
      break
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
