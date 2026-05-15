'use server'

import { redirect } from 'next/navigation'
import { stripe } from '@/lib/stripe'
import { getCurrentUser } from '@/lib/auth/ensure-user'

export async function createCheckoutSession() {
  const user = await getCurrentUser()
  if (!user) {
    // webhook race: DB row not yet synced. Throw with stable code so the
    // caller's error boundary surfaces (the `<form>` action path has no
    // ActionResult channel since this function ends in redirect()).
    throw new Error('USER_NOT_SYNCED')
  }

  const priceId = process.env.STRIPE_PRICE_ID_PRO_MONTHLY
  if (!priceId) throw new Error('STRIPE_PRICE_ID_PRO_MONTHLY is not set')

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
