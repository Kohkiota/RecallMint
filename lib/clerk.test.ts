import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// Phase 1 E-2: env-dependent validation
// - VERCEL_ENV === 'production' → pk_live_ / sk_live_ 必須
// - それ以外 → pk_test_ / sk_test_ 必須
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV

beforeEach(() => {
  // vitest.setup.ts already calls vi.resetModules() in a global beforeEach,
  // but we set the base values here so each test can mutate them cleanly.
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_fake_for_tests'
  process.env.CLERK_SECRET_KEY = 'sk_test_fake_for_tests'
  // VERCEL_ENV を non-production 初期化 (各 test が必要なら override)
  delete process.env.VERCEL_ENV
})

afterEach(() => {
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV
})

describe('Clerk env prefix validation (non-production)', () => {
  it('Unset NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY throws with key name', async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    await expect(import('./clerk')).rejects.toThrow(
      /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/,
    )
  })

  it('Unset CLERK_SECRET_KEY throws with key name', async () => {
    delete process.env.CLERK_SECRET_KEY
    await expect(import('./clerk')).rejects.toThrow(/CLERK_SECRET_KEY/)
  })

  it('pk_live_ publishable key is rejected with message mentioning pk_test_', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_live_abc123'
    await expect(import('./clerk')).rejects.toThrow(/pk_test_/)
  })

  it('sk_live_ secret key is rejected with message mentioning sk_test_', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_live_abc123'
    await expect(import('./clerk')).rejects.toThrow(/sk_test_/)
  })

  it('pk_test_ + sk_test_ keys are accepted', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_abc123'
    process.env.CLERK_SECRET_KEY = 'sk_test_abc123'
    await expect(import('./clerk')).resolves.toBeDefined()
  })

  it('VERCEL_ENV=preview is treated as non-production (test keys required)', async () => {
    process.env.VERCEL_ENV = 'preview'
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_abc123'
    process.env.CLERK_SECRET_KEY = 'sk_test_abc123'
    await expect(import('./clerk')).resolves.toBeDefined()
  })

  it('VERCEL_ENV=development is treated as non-production (test keys required)', async () => {
    process.env.VERCEL_ENV = 'development'
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_abc123'
    process.env.CLERK_SECRET_KEY = 'sk_test_abc123'
    await expect(import('./clerk')).resolves.toBeDefined()
  })

  it('VERCEL_ENV=preview rejects pk_live_ (live keys not allowed outside production)', async () => {
    process.env.VERCEL_ENV = 'preview'
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_live_abc123'
    await expect(import('./clerk')).rejects.toThrow(/pk_test_/)
  })
})

describe('Clerk env prefix validation (VERCEL_ENV=production)', () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = 'production'
  })

  it('pk_live_ + sk_live_ keys are accepted', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_live_abc123'
    process.env.CLERK_SECRET_KEY = 'sk_live_abc123'
    await expect(import('./clerk')).resolves.toBeDefined()
  })

  it('pk_test_ publishable key is rejected with message mentioning pk_live_', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_abc123'
    process.env.CLERK_SECRET_KEY = 'sk_live_abc123'
    await expect(import('./clerk')).rejects.toThrow(/pk_live_/)
  })

  it('sk_test_ secret key is rejected with message mentioning sk_live_', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_live_abc123'
    process.env.CLERK_SECRET_KEY = 'sk_test_abc123'
    await expect(import('./clerk')).rejects.toThrow(/sk_live_/)
  })

  it('Unset NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY throws (env-independent)', async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    await expect(import('./clerk')).rejects.toThrow(
      /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/,
    )
  })

  it('Unset CLERK_SECRET_KEY throws (env-independent)', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_live_abc123'
    delete process.env.CLERK_SECRET_KEY
    await expect(import('./clerk')).rejects.toThrow(/CLERK_SECRET_KEY/)
  })
})
