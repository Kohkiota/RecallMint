import '@/lib/clerk' // env prefix validation (side-effect, Edge runtime)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedRoute = createRouteMatcher(['/app(.*)'])

// Phase 1 G-baseline-3 (I-baseline-9): Clerk auto CSP default mode を採用、
// Clerk + Stripe redirect 等の必要 origin を Clerk 側が自動配備する。空 object
// で「default 構築」を指示、追加 directive は本 sprint scope 外。next.config.ts
// の Content-Security-Policy: frame-ancestors 'none' と二重防御で並ぶ層。
// 副作用: Vercel Live / Speed Insights が preview で動かなくなるが、補助機能
// 無効化は実害なし (spec §3 Assumption 10、§9 Q6 で OT 確認済)。
export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect()
    }
  },
  {
    contentSecurityPolicy: {},
  },
)

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
