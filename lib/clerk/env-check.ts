// Clerk env prefix validation (CLAUDE.md §Clerk-1)。
//
// 環境依存:
// - `VERCEL_ENV === 'production'` → `pk_live_` / `sk_live_` 必須、test keys 拒否
// - それ以外 (preview / development / undefined) → `pk_test_` / `sk_test_` 必須、live keys 拒否
//
// 旧実装 (Phase 1 D 系列以前) は test keys のみを許可していたが、production
// instance への切替時にこの guard 自体が deploy 阻害となるため Phase 1 E-2 で
// 環境依存に変更。詳細:
// docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md
//
// Imported as a side-effect from proxy.ts (Node runtime) and
// lib/auth/ensure-user.ts (Node runtime) for fail-fast.
// lib/stripe.ts も同 VERCEL_ENV-aware pattern (両者で形式統一)。

const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
const sk = process.env.CLERK_SECRET_KEY
const isProd = process.env.VERCEL_ENV === 'production'

if (!pk) {
  throw new Error('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set')
}

if (!sk) {
  throw new Error('CLERK_SECRET_KEY is not set')
}

if (isProd) {
  if (!pk.startsWith('pk_live_')) {
    throw new Error(
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_live_ when VERCEL_ENV=production. ` +
        `Test keys (pk_test_) are not allowed in production. ` +
        `Got prefix: ${pk.slice(0, 8)}...`,
    )
  }
  if (!sk.startsWith('sk_live_')) {
    throw new Error(
      `CLERK_SECRET_KEY must start with sk_live_ when VERCEL_ENV=production. ` +
        `Test keys (sk_test_) are not allowed in production. ` +
        `Got prefix: ${sk.slice(0, 8)}...`,
    )
  }
} else {
  if (!pk.startsWith('pk_test_')) {
    throw new Error(
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_test_ in non-production environments. ` +
        `Live keys (pk_live_) are only permitted when VERCEL_ENV=production. ` +
        `Got prefix: ${pk.slice(0, 8)}...`,
    )
  }
  if (!sk.startsWith('sk_test_')) {
    throw new Error(
      `CLERK_SECRET_KEY must start with sk_test_ in non-production environments. ` +
        `Live keys (sk_live_) are only permitted when VERCEL_ENV=production. ` +
        `Got prefix: ${sk.slice(0, 8)}...`,
    )
  }
}

// Mark this file as a module (no exports, side-effect only) so dynamic
// `import('./clerk')` is well-typed in tests and TypeScript treats this
// as ES module rather than a script.
export {}
