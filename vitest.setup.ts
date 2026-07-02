import { beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
// S-cache-1: Dexie / IndexedDB を使う test のための shim。 jsdom / node の
// 両 environment で indexedDB / IDBKeyRange グローバルを供給する。 副作用 import
// 1 行で全 test に適用される (Dexie を import しない test には影響なし)。
import 'fake-indexeddb/auto'

// Fake env defaults for tests — use ??= so real env values take precedence.
// These prevent module-load-time validators (e.g. Stripe prefix check) from
// throwing during test runs.

process.env.STRIPE_SECRET_KEY ??= 'sk_test_fake_for_tests'
process.env.STRIPE_PUBLISHABLE_KEY ??= 'pk_test_fake_for_tests'
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_fake_for_tests'
process.env.STRIPE_PRICE_STANDARD_MONTHLY ??= 'price_fake_standard_monthly'
process.env.STRIPE_PRICE_STANDARD_YEARLY ??= 'price_fake_standard_yearly'
process.env.STRIPE_PRICE_PRO_MONTHLY ??= 'price_fake_pro_monthly'
process.env.STRIPE_PRICE_PRO_YEARLY ??= 'price_fake_pro_yearly'
process.env.GEMINI_API_KEY ??= 'fake_gemini_key'
process.env.GEMINI_DAILY_LIMIT ??= '1000'
process.env.DATABASE_URL ??= 'postgresql://fake:fake@localhost:5432/fake'
process.env.CLERK_SECRET_KEY ??= 'sk_test_clerk_fake'
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_clerk_fake'
process.env.CLERK_WEBHOOK_SECRET ??= 'whsec_clerk_fake'

// ResizeObserver は jsdom に存在しないため no-op stub を注入する。
// exam-card-table.tsx の Fix wave-1 ResizeObserver で参照される。
// jsdom はレイアウト 0 のため observer が発火することはないが、
// new ResizeObserver(...) が ReferenceError を投げないようにするのが目的。
if (typeof ResizeObserver === 'undefined') {
  global.ResizeObserver = class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// Reset modules before each test so dynamic imports re-evaluate
// (important for Task 1.3 Stripe prefix validation tests).
beforeEach(() => {
  vi.resetModules()
})
