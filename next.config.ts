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
  // ②-4a-cutover smoke fix(2026-08-02): sharp(crop 経路・lib/media/crop-and-store.ts)は
  // Next の default で external 扱いされ、NFT が `@img/sharp-linux-x64` の `.node` は
  // トレースするが、その `.node` が C++ 層で dlopen する `@img/sharp-libvips-linux-x64`
  // の実バイナリ `libvips-cpp.so.<ver>` を**トレースしない**(dlopen は JS require で
  // 辿れないため)。結果 Vercel の serverless function から `.so` が脱落し、実行時に
  // `ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file` で 500。
  // local(devcontainer=linux-x64-glibc)は `.pnpm` に `.so` が実在するため再現せず、
  // smoke で初めて表面化した(module load 段階の失敗ゆえ crop ロジックは未実行)。
  // → NFT が拾えない native binary を outputFileTracingIncludes で手動包含する(Next 公式
  //   が sharp に推奨する機構)。pnpm は @img を top-level でなく `.pnpm` 実体に置くため
  //   `.pnpm/@img+...@*/...` を直接指定(version 非依存に `@*`)。install/lockfile は不変
  //   (binary は既に install 済で欠落していない=`supportedArchitectures` は不要)。
  outputFileTracingIncludes: {
    '/*': [
      './node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/**/*',
      './node_modules/.pnpm/@img+sharp-linux-x64@*/node_modules/@img/sharp-linux-x64/**/*',
    ],
  },
  experimental: {
    serverActions: {
      // Next.js 16 の framework default は 1MB。 default のまま運用すると Server
      // Action 到達前 (framework 層) で 413 が投げられ、 client は generic な
      // catch で OTHER 経路に流れる (= app 側 SIZE_LIMIT_EXCEEDED 経路に届かず
      // 「処理状況を確認できませんでした」 と誤誘導される)。
      // 値は Vercel platform の Request body hard limit と同値の 4.5MB に開放し、
      // 制限の正本を app-level に集約する: upload 経路は constants.ts の
      // TOTAL_UPLOAD_LIMIT_MB (=4MB) を client cap、 process.ts 内の
      // SIZE_LIMIT_EXCEEDED check が server-side enforcement の正本。
      // 4MB cap + multipart overhead ≒ 4.1MB 弱 < 4.5MB platform 上限 = margin 内。
      // 他の Server Action 7 件 (settings/exams/upgrade/contact) は id/name/number/
      // bool/text の小ペイロードのみで、 4.5MB 化の実用影響なし。
      bodySizeLimit: '4.5mb',
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
