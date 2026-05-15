import type { NextConfig } from 'next'

// Phase 1 G-baseline-3 (I-baseline-9): production grade の最低限 security
// header を全 route に適用。CSP は frame-ancestors 'none' のみで X-Frame-Options
// DENY と二重防御 (外部 origin 列挙不要、追加リスクゼロ)。Clerk + Stripe 関連の
// CSP directive は middleware.ts の clerkMiddleware({ contentSecurityPolicy: {} })
// 経由で auto 配備される (Clerk 公式 default mode)。HSTS preload は本 sprint
// scope 外 (max-age + includeSubDomains のみ)。
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/node_modules/**',
          '**/.next/**',
          '**/.git/**',
          '**/.playwright-mcp/**',
        ],
      }
    }
    return config
  },
}

export default nextConfig
