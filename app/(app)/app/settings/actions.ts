'use server'

import { redirect } from 'next/navigation'
import { stripe } from '@/lib/stripe'
import { getCurrentUser } from '@/lib/auth/ensure-user'

export async function createBillingPortalSession() {
  const user = await getCurrentUser()
  if (!user) {
    // webhook race: DB row not yet synced. Throw so the caller's error
    // boundary surfaces while `<meta http-equiv="refresh">` recovers users
    // who land on /app first. Stable code lets future callers pattern-match.
    throw new Error('USER_NOT_SYNCED')
  }
  if (!user.stripeCustomerId) {
    throw new Error('Stripe customer is not set for this user')
  }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${base}/app/settings`,
  })
  redirect(session.url)
}
