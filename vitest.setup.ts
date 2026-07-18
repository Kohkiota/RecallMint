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
process.env.DATABASE_URL_APP ??= 'postgresql://fake:fake@localhost:5432/fake'
process.env.CLERK_SECRET_KEY ??= 'sk_test_clerk_fake'
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_clerk_fake'
process.env.CLERK_WEBHOOK_SECRET ??= 'whsec_clerk_fake'
// R2 (画像フェーズ A)。 lib/storage/r2.ts が module load で fail-fast するため、
// 画像 gallery を transitive import する component test 全般で必要 (STRIPE/CLERK と同方針)。
// r2.test.ts は自前で set/delete して fail-fast を検証するので ??= で衝突しない。
process.env.R2_ACCOUNT_ID ??= 'fake_r2_account'
process.env.R2_ACCESS_KEY_ID ??= 'fake_r2_access_key'
process.env.R2_SECRET_ACCESS_KEY ??= 'fake_r2_secret_key'
process.env.R2_BUCKET_NAME ??= 'fake-r2-bucket'

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

// S2-2: element virtualizer (TanStack) は scroll 元の size と行高を offsetWidth/offsetHeight
// で読む (virtual-core の getRect / measureElement = 共に offset* 経由)。 jsdom は layout を
// 計算せず offset* に 0 を返すため、 scroll container の outerSize=0 → calculateRange が null →
// 行が 1 つも描画されない (element virtualizer は window virtualizer と違い innerHeight
// fallback を持たない)。 ResizeObserver stub と同種の jsdom layout shim として、 非ゼロの
// offset* を返す。 これで container が有限高を持ち仮想化窓が成立する (窓は依然 min(overscan+1,
// N) 程度に「有界」= 全 N を mount しない性質を保つ)。
// 注意: リポジトリの source / test は offsetWidth/offsetHeight を数値参照しない (grep 済) ため
//   非ゼロ供給による回帰はない (whole-repo test green で担保)。
if (typeof HTMLElement !== 'undefined') {
  const STUB_OFFSET = 40
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return STUB_OFFSET
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return STUB_OFFSET
    },
  })
}

// Reset modules before each test so dynamic imports re-evaluate
// (important for Task 1.3 Stripe prefix validation tests).
beforeEach(() => {
  vi.resetModules()
})
