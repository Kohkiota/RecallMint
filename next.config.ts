import type { NextConfig } from 'next'

// Phase 1 G-baseline-3 (I-baseline-9): production grade の最低限 security
// header を全 route に適用。CSP は frame-ancestors 'none' のみで X-Frame-Options
// DENY と二重防御 (外部 origin 列挙不要、追加リスクゼロ)。Clerk + Stripe 関連の
// CSP directive は proxy.ts の clerkMiddleware({ contentSecurityPolicy: {} })
// 経由で auto 配備される (Clerk 公式 default mode)。HSTS preload は本 sprint
// scope 外 (max-age + includeSubDomains のみ)。

// Y-2 T-C6 Permissions-Policy default candidate (spec §10.2 で確定、 audit 外 OT 追加)。
// 23 directive = 22 全 deny + fullscreen=(self) のみ self 許可。 stg gate 4 step
// (DevTools MCP で /app/upgrade Stripe redirect + Clerk sign-in/up + /app 主要 page +
// /app/upload OCR upload 巡回) で violation 0 確認後 prod cutover。
// 将来 passkey/WebAuthn 採用時は publickey-credentials-get / -create を =(self) に緩和。
const PERMISSIONS_POLICY =
  'accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), ' +
  'camera=(), display-capture=(), document-domain=(), encrypted-media=(), ' +
  'fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), ' +
  'microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
  'publickey-credentials-create=(), publickey-credentials-get=(), ' +
  'screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), ' +
  'xr-spatial-tracking=()'

const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
