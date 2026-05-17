'use server'

import { redirect } from 'next/navigation'
import { stripe } from '@/lib/stripe'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { priceIdFor, type PaidPlan, type BillingInterval } from '@/lib/stripe/price-mapping'

// 4 種類 (Standard×month/year × Pro×month/year) すべての Checkout 起動に対応。
// 旧 createCheckoutSession (Pro monthly hardcode) は廃止、 form action から
// hidden input で plan + interval を受け取る pattern に統一。
export async function createCheckoutSession(formData: FormData): Promise<void> {
  const user = await getCurrentUser()
  if (!user) {
    // webhook race: DB row not yet synced. Throw with stable code so the
    // caller's error boundary surfaces (the `<form>` action path has no
    // ActionResult channel since this function ends in redirect()).
    throw new Error('USER_NOT_SYNCED')
  }

  const plan = formData.get('plan')
  const interval = formData.get('interval')
  if (plan !== 'standard' && plan !== 'pro') {
    throw new Error(`Invalid plan: ${String(plan)}`)
  }
  if (interval !== 'month' && interval !== 'year') {
    throw new Error(`Invalid interval: ${String(interval)}`)
  }

  // priceIdFor は env 起点で fail-fast 検証済 (lib/stripe/price-mapping.ts)、
  // 4 cell exhaustive なので runtime throw は到達しない想定。
  const priceId = priceIdFor(plan as PaidPlan, interval as BillingInterval)

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.clerkId,
    // If the user already has a Stripe customer ID (e.g., from a prior upgrade
    // attempt or a cancelled sub), reuse it. Otherwise let Stripe create one
    // from the email on Checkout.
    customer: user.stripeCustomerId ?? undefined,
    customer_email: user.stripeCustomerId ? undefined : user.email,
    success_url: `${base}/app?checkout=success`,
    cancel_url: `${base}/app/upgrade`,
  })

  if (!session.url) throw new Error('Stripe Checkout session has no url')
  redirect(session.url)
}
