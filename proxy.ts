import '@/lib/clerk' // env prefix validation (side-effect, Node runtime)
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

// T-A4 (audit §10.3 (b) #13): webhook (`/api/webhooks/*`) は Clerk auth context
// を一切要求しない構造保証。 第 1 matcher (catch-all) の negative lookahead に
// `api/webhooks(?:$|/)` を追加し、 第 2 matcher (旧 `/(api|trpc)(.*)`) も `api`
// 直下で `/webhooks(?:$|/)` を negative lookahead で除外する。 segment boundary
// `(?:$|/)` で「webhooks segment ぴったり」 or 「webhooks/ 配下」 にのみ bypass
// を適用、 `/api/webhooks-foo` 等の prefix collision を構造的に排除 (T-A4 code
// review I1 反映)。 Next.js は config.matcher を OR 評価するため、 全 pattern で
// webhook を除外しないと bypass が成立しない (proxy.test.ts header コメント参照)。
// isProtectedRoute の matcher 拡張 regression が webhook を auth.protect 経路に
// 巻き込むことを構造で防ぐ。 contract は proxy.test.ts で boundary 込み 2 case
// (webhook bypass + 既存 path 維持 + prefix collision 防御) で保証。
export const config = {
  matcher: [
    '/((?!_next|api/webhooks(?:$|/)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/((api(?!/webhooks(?:$|/))|trpc))(.*)',
    '/__clerk/(.*)',
  ],
}
