import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { requireWebhookSecret } from './webhook-secret-gate'

// audit §10.3 (b) #17 / T-A8。 3-tier env-aware contract:
//   production (VERCEL_ENV='production')  + env 欠落 → throw
//   production                            + env 設定 → return string
//   preview    (VERCEL_ENV='preview')     + env 欠落 → logger.warn + return ''
//   local / dev (VERCEL_ENV 未設定)        + env 欠落 → return '' silently (warn なし)
//
// synthetic env key で self-contained 化 — vitest.setup.ts が
// CLERK_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET を pre-populate しているため
// 実 env key を test 内で削除しても他 test (webhook route.test.ts) と
// cross-pollute する。 helper は envKey 引数を任意 string で受けるので、
// synthetic key で等価検証可能 (`requireWebhookSecret` 内部実装は
// process.env[envKey] / process.env.VERCEL_ENV のみ参照)。

const ENV_KEY = '__WEBHOOK_SECRET_GATE_TEST_KEY'
const LABEL = 'TestWebhook'
const ORIG_VERCEL = process.env.VERCEL_ENV
const ORIG_TARGET = process.env[ENV_KEY]

// logger は warn を spy したいので mock 化。 log-gate.test.ts と違い helper が
// logger.warn を呼ぶため、 mock 化しないと test 出力に warn が漏れる + 呼び出し
// 検証ができない。
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '@/lib/logger'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  if (ORIG_VERCEL === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = ORIG_VERCEL
  if (ORIG_TARGET === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ORIG_TARGET
})

describe('requireWebhookSecret', () => {
  it('production + env 欠落 → throw (audit §10.3 (b) #17 文言を含む)', () => {
    process.env.VERCEL_ENV = 'production'
    delete process.env[ENV_KEY]
    expect(() => requireWebhookSecret(ENV_KEY, LABEL)).toThrow(
      /must be set in production/,
    )
    // envKey が message に含まれる (どの secret が欠落しているか identify 可能)
    expect(() => requireWebhookSecret(ENV_KEY, LABEL)).toThrow(
      new RegExp(ENV_KEY),
    )
    // audit ref が message に含まれる (root cause grep 用)
    expect(() => requireWebhookSecret(ENV_KEY, LABEL)).toThrow(/10\.3.*17/)
  })

  it('production + env 設定済 → return string (env 値そのまま)', () => {
    process.env.VERCEL_ENV = 'production'
    process.env[ENV_KEY] = 'whsec_prod_value'
    expect(requireWebhookSecret(ENV_KEY, LABEL)).toBe('whsec_prod_value')
    // 設定済の場合は warn / error も呼ばれない
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('preview + env 欠落 → logger.warn + return "" (signature verify は失敗するが route は 400 経路)', () => {
    process.env.VERCEL_ENV = 'preview'
    delete process.env[ENV_KEY]
    expect(requireWebhookSecret(ENV_KEY, LABEL)).toBe('')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'webhook.secret.missing_preview',
      label: LABEL,
      envKey: ENV_KEY,
    })
  })

  it('local / dev (VERCEL_ENV 未設定) + env 欠落 → silent skip (return "", warn なし)', () => {
    delete process.env.VERCEL_ENV
    delete process.env[ENV_KEY]
    expect(requireWebhookSecret(ENV_KEY, LABEL)).toBe('')
    // local では warn / error 一切呼ばない (dev noise 防止)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
