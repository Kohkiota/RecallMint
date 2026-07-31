// spec §3 C-5: parseDailyLimit(upload-guard.ts から切出)の unit test。
// 実 Gemini API は叩かない(pure 関数、env のみ mock)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDailyLimit } from './daily-limit'

describe('parseDailyLimit', () => {
  let originalVercelEnv: string | undefined

  beforeEach(() => {
    originalVercelEnv = process.env.VERCEL_ENV
  })

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV
    } else {
      process.env.VERCEL_ENV = originalVercelEnv
    }
  })

  describe('非 production (VERCEL_ENV != "production")', () => {
    beforeEach(() => {
      delete process.env.VERCEL_ENV
    })

    it('unset (undefined) → null(guard off)', () => {
      expect(parseDailyLimit(undefined)).toBeNull()
    })

    it('空文字 → null(guard off)', () => {
      expect(parseDailyLimit('')).toBeNull()
    })

    it('非数値文字列 → null(guard off)', () => {
      expect(parseDailyLimit('not-a-number')).toBeNull()
    })

    it('0 → null(guard off、正の値のみ有効)', () => {
      expect(parseDailyLimit('0')).toBeNull()
    })

    it('負の値 → null(guard off)', () => {
      expect(parseDailyLimit('-5')).toBeNull()
    })

    it('有効な正の整数文字列 → 数値化して返す', () => {
      expect(parseDailyLimit('1000')).toBe(1000)
      expect(parseDailyLimit('1')).toBe(1)
    })
  })

  describe('production (VERCEL_ENV=="production")', () => {
    beforeEach(() => {
      process.env.VERCEL_ENV = 'production'
    })

    it('unset (undefined) → throw(fail-fast)', () => {
      expect(() => parseDailyLimit(undefined)).toThrow(
        'GEMINI_DAILY_LIMIT must be set in production',
      )
    })

    it('空文字 → throw(fail-fast)', () => {
      expect(() => parseDailyLimit('')).toThrow(
        'GEMINI_DAILY_LIMIT must be set in production',
      )
    })

    it('非数値文字列 → throw(fail-fast)', () => {
      expect(() => parseDailyLimit('not-a-number')).toThrow(
        'GEMINI_DAILY_LIMIT must be set in production',
      )
    })

    it('0 → throw(fail-fast、正の値のみ有効)', () => {
      expect(() => parseDailyLimit('0')).toThrow(
        'GEMINI_DAILY_LIMIT must be set in production',
      )
    })

    it('有効な正の整数文字列 → 数値化して返す(throw しない)', () => {
      expect(parseDailyLimit('500')).toBe(500)
    })
  })
})
