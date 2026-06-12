import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  signDeletionToken,
  verifyDeletionToken,
} from './deletion-token'

// audit §10.4 #11 / T-A9 重要 fix (削除 + 認証)。 HMAC-SHA256 + ttl 24h signed
// token contract:
//   sign       : `<userIdB64>.<expB64>.<hmacB64>` (3 segments base64url)
//   verify ok  : { ok:true, userId, expired:false }
//   verify exp : { ok:true, userId, expired:true } (caller は 410 Gone で扱う)
//   verify ng  : { ok:false, error:'invalid_format' | 'invalid_hmac' } (caller は 401)
//   prod 必須  : DELETION_TOKEN_SECRET 欠落 + VERCEL_ENV='production' → throw
//
// VERCEL_ENV / DELETION_TOKEN_SECRET の orig 値を保存して afterEach で復元
// (webhook-secret-gate.test.ts と同 pattern、 cross-test pollute 防止)。

const ORIG_VERCEL = process.env.VERCEL_ENV
const ORIG_SECRET = process.env.DELETION_TOKEN_SECRET

beforeEach(() => {
  // local / dev (VERCEL_ENV 未設定) を既定にする — helper は dev-only dummy
  // secret を返す経路に流れる。
  delete process.env.VERCEL_ENV
  delete process.env.DELETION_TOKEN_SECRET
})

afterEach(() => {
  if (ORIG_VERCEL === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = ORIG_VERCEL
  if (ORIG_SECRET === undefined) delete process.env.DELETION_TOKEN_SECRET
  else process.env.DELETION_TOKEN_SECRET = ORIG_SECRET
})

describe('signDeletionToken / verifyDeletionToken', () => {
  it('sign: 期待 format = 3 segment base64url を返す', () => {
    const token = signDeletionToken('user_abc123')
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    // base64url 文字集合のみ (A-Z a-z 0-9 _ - 、 padding なし)
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('verify 成功: sign → verify で { ok:true, userId, expired:false } 返却', () => {
    const userId = 'user_abc123'
    const token = signDeletionToken(userId)
    const result = verifyDeletionToken(token)
    expect(result).toEqual({ ok: true, userId, expired: false })
  })

  it('verify 失敗 (format): segment 数 != 3 → { ok:false, error:"invalid_format" }', () => {
    // segment 不足 / 過剰どちらも format 不正として扱う
    expect(verifyDeletionToken('invalid')).toEqual({
      ok: false,
      error: 'invalid_format',
    })
    expect(verifyDeletionToken('a.b')).toEqual({
      ok: false,
      error: 'invalid_format',
    })
    expect(verifyDeletionToken('a.b.c.d')).toEqual({
      ok: false,
      error: 'invalid_format',
    })
  })

  it('verify 期限切れ: ttl 超過時刻で verify → { ok:true, userId, expired:true }', () => {
    const userId = 'user_abc123'
    const signTime = Date.now()
    const token = signDeletionToken(userId, signTime)
    // 24h + 1ms 後 = exp_ts < now で expired
    const TTL_MS = 24 * 60 * 60 * 1000
    const result = verifyDeletionToken(token, signTime + TTL_MS + 1)
    expect(result).toEqual({ ok: true, userId, expired: true })
  })

  it('verify 失敗 (HMAC mismatch): 他 secret で sign した token → { ok:false, error:"invalid_hmac" }', () => {
    // 本物 secret で sign
    process.env.DELETION_TOKEN_SECRET = 'real-secret'
    const realToken = signDeletionToken('user_abc123')
    // 改ざん: 偽 secret で再 sign した hmac で差し替え
    const [userIdB64, expB64] = realToken.split('.')
    const fakeHmac = createHmac('sha256', 'other-secret')
      .update(`${userIdB64}.${expB64}`)
      .digest('base64url')
    const tampered = `${userIdB64}.${expB64}.${fakeHmac}`
    const result = verifyDeletionToken(tampered)
    expect(result).toEqual({ ok: false, error: 'invalid_hmac' })
  })

  it('production + DELETION_TOKEN_SECRET 欠落 → throw (audit §10.4 #11 文言を含む)', () => {
    process.env.VERCEL_ENV = 'production'
    delete process.env.DELETION_TOKEN_SECRET
    expect(() => signDeletionToken('user_abc123')).toThrow(
      /must be set in production/,
    )
    expect(() => signDeletionToken('user_abc123')).toThrow(/10\.4.*11/)
    // verify 経路も同 helper を経由するので同様に throw
    expect(() => verifyDeletionToken('a.b.c')).toThrow(/must be set in production/)
  })
})
