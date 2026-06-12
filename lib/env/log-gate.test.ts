import { describe, it, expect, afterEach } from 'vitest'
import { isLogGateOpen } from './log-gate'

// 2 段 gate helper の test (audit §10.3 (b) #5)。
// 既定 contract: production (= VERCEL_ENV === 'production') では
//   env[key]==='1' && LOG_GATE_ALLOW_PROD==='1' の AND。
// 非 production (preview / dev / undefined) では env[key]==='1' のみ。
// 値は '1' 比較のみ受理 ('true' / 'yes' 等は false)。

// synthetic key で test を self-contained 化、 同 vitest run で並走する
// gemini.test.ts / serialize-db-error.test.ts (実 OCR_DEBUG_LOG /
// BULK_FULL_PARAMS_LOG を mock する) との cross-test pollution を防ぐ。
// helper 自身は envKey 引数を任意 string で受けるので、 synthetic key で
// 等価検証可能 (`isLogGateOpen` 内部実装は process.env[envKey] === '1' のみ)。
const ENV_KEY = '__LOG_GATE_TEST_KEY'
const ORIG_VERCEL = process.env.VERCEL_ENV
const ORIG_ALLOW = process.env.LOG_GATE_ALLOW_PROD
const ORIG_TARGET = process.env[ENV_KEY]

afterEach(() => {
  if (ORIG_VERCEL === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = ORIG_VERCEL
  if (ORIG_ALLOW === undefined) delete process.env.LOG_GATE_ALLOW_PROD
  else process.env.LOG_GATE_ALLOW_PROD = ORIG_ALLOW
  if (ORIG_TARGET === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ORIG_TARGET
})

describe('isLogGateOpen', () => {
  it('production: env=1 + LOG_GATE_ALLOW_PROD=1 → true (2 段 gate 通過)', () => {
    process.env.VERCEL_ENV = 'production'
    process.env.LOG_GATE_ALLOW_PROD = '1'
    process.env[ENV_KEY] = '1'
    expect(isLogGateOpen(ENV_KEY)).toBe(true)
  })

  it('production: env=1 + LOG_GATE_ALLOW_PROD 未設定 → false (2 段目で fail-safe)', () => {
    process.env.VERCEL_ENV = 'production'
    delete process.env.LOG_GATE_ALLOW_PROD
    process.env[ENV_KEY] = '1'
    expect(isLogGateOpen(ENV_KEY)).toBe(false)
  })

  it('preview: env=1 → true (非 prod は LOG_GATE_ALLOW_PROD 不要)', () => {
    process.env.VERCEL_ENV = 'preview'
    delete process.env.LOG_GATE_ALLOW_PROD
    process.env[ENV_KEY] = '1'
    expect(isLogGateOpen(ENV_KEY)).toBe(true)
  })

  it('dev (VERCEL_ENV=development): env=1 → true', () => {
    process.env.VERCEL_ENV = 'development'
    delete process.env.LOG_GATE_ALLOW_PROD
    process.env[ENV_KEY] = '1'
    expect(isLogGateOpen(ENV_KEY)).toBe(true)
  })

  it('env 未設定 → false (どの環境でも)', () => {
    delete process.env.VERCEL_ENV
    delete process.env.LOG_GATE_ALLOW_PROD
    delete process.env[ENV_KEY]
    expect(isLogGateOpen(ENV_KEY)).toBe(false)
  })
})
