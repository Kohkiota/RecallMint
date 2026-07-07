import '@/lib/clerk/env-check' // env prefix validation (side-effect, Node runtime)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedRoute = createRouteMatcher(['/app(.*)'])

// T-A4 fix (audit §10.3 (b) #13、 Vercel build error 起因 修正):
// 旧実装は config.matcher 内に negative lookahead `(?!/webhooks(?:$|/))` で
// webhook bypass を構造保証していたが、 Next.js は config.matcher を path-to-
// regexp parser で評価し、 capturing group / lookahead を許容しない:
//   Error: Invalid source '/((api(?!/webhooks(?:$|/))|trpc))(.*)':
//   Capturing groups are not allowed at 2 at "matcher[1]"
// vitest / typecheck / lint は内部 js regex として動作するため検出不能、 Vercel
// build (path-to-regexp 経由) で初めて parse 失敗を表面化した。 fix 方針:
//   1. config.matcher を T-A4 以前 (波 1 確定) の lookahead なし形に戻す
//   2. webhook 除外は本 callback 内の early return で構造保証 (Clerk auth
//      context を要求しない = auth.protect / clerkMiddleware の内部処理を
//      実行する前に return)
//   3. `isWebhookBypass()` を export し、 proxy.test.ts で segment boundary
//      込みの contract を unit test で固定
// 構造保証の強度は T-A4 と同等 (segment boundary `/api/webhooks(?:$|/)` 相当の
// startsWith + 厳密 path check で prefix collision を排除)。

// Phase 1 G-baseline-3 (I-baseline-9): Clerk auto CSP default mode を採用、
// Clerk + Stripe redirect 等の必要 origin を Clerk 側が自動配備する。空 object
// で「default 構築」を指示、追加 directive は本 sprint scope 外。next.config.ts
// の Content-Security-Policy: frame-ancestors 'none' と二重防御で並ぶ層。
// 副作用: Vercel Live / Speed Insights が preview で動かなくなるが、補助機能
// 無効化は実害なし (spec §3 Assumption 10、§9 Q6 で OT 確認済)。

// webhook bypass の構造保証 (T-A4 fix)。 `/api/webhooks/<provider>` 配下のみ
// bypass、 `/api/webhooks-foo` / `/api/webhooksomething` 等の prefix collision
// は **bypass しない** (= 通常通り clerkMiddleware が走る)。 segment boundary
// は `pathname === '/api/webhooks'` (bare) または `pathname.startsWith('/api/
// webhooks/')` で表現 (path-to-regexp の `(?:$|/)` lookahead と等価 semantics)。
export function isWebhookBypass(pathname: string): boolean {
  return pathname === '/api/webhooks' || pathname.startsWith('/api/webhooks/')
}

export default clerkMiddleware(
  async (auth, req) => {
    // T-A4 fix: webhook path は Clerk auth context 一切要求しない構造保証。
    // matcher は通過するが本 callback 内で即 return し auth.protect 経路に
    // 巻き込まれない。 wire format / 実 webhook routes (`app/api/webhooks/
    // {clerk,stripe}/route.ts`) の挙動は完全不変 (両 route とも独自 Svix /
    // Stripe signature verify で auth context を使わず、 middleware の bypass
    // も「auth context 不要」 状態を構造で gate するだけ)。
    if (isWebhookBypass(req.nextUrl.pathname)) {
      return
    }
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
    '/__clerk/(.*)',
  ],
}
