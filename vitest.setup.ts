import { beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

// Fake env defaults for tests — use ??= so real env values take precedence.
// These prevent module-load-time validators (e.g. Stripe prefix check) from
// throwing during test runs.

process.env.STRIPE_SECRET_KEY ??= 'sk_test_fake_for_tests'
process.env.STRIPE_PUBLISHABLE_KEY ??= 'pk_test_fake_for_tests'
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_fake_for_tests'
process.env.STRIPE_PRICE_PRO_MONTHLY ??= 'price_fake'
process.env.GEMINI_API_KEY ??= 'fake_gemini_key'
process.env.GEMINI_DAILY_LIMIT ??= '1000'
process.env.DATABASE_URL ??= 'postgresql://fake:fake@localhost:5432/fake'
process.env.CLERK_SECRET_KEY ??= 'sk_test_clerk_fake'
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_clerk_fake'
process.env.CLERK_WEBHOOK_SECRET ??= 'whsec_clerk_fake'

// Reset modules before each test so dynamic imports re-evaluate
// (important for Task 1.3 Stripe prefix validation tests).
beforeEach(() => {
  vi.resetModules()
})
