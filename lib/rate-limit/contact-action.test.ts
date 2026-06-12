import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkContactRateLimit,
  __resetContactRateLimitStore,
} from './contact-action'

describe('checkContactRateLimit', () => {
  beforeEach(() => {
    __resetContactRateLimitStore()
  })

  it('5 件以内は同 key で全 allow (limit ちょうどまで通す)', () => {
    const key = 'ip:1.2.3.4'
    const now = 1_700_000_000_000
    for (let i = 0; i < 5; i++) {
      const result = checkContactRateLimit(key, now + i)
      expect(result.allowed).toBe(true)
    }
  })

  it('6 件目で block (5 件超過 → allowed:false)', () => {
    const key = 'ip:1.2.3.4'
    const now = 1_700_000_000_000
    for (let i = 0; i < 5; i++) {
      checkContactRateLimit(key, now + i)
    }
    const sixth = checkContactRateLimit(key, now + 5)
    expect(sixth.allowed).toBe(false)
    // resetAtMs は最古 timestamp + WINDOW_MS = now + 1h を期待 (1h 後に枠が空く)。
    expect(sixth.resetAtMs).toBe(now + 60 * 60 * 1000)
  })

  it('1h+1ms 経過後は古い timestamp が prune され 6 件目相当が allow', () => {
    const key = 'ip:1.2.3.4'
    const now = 1_700_000_000_000
    for (let i = 0; i < 5; i++) {
      checkContactRateLimit(key, now + i)
    }
    // window 内で blocked を再確認
    expect(checkContactRateLimit(key, now + 100).allowed).toBe(false)
    // 1h + 1ms 進めると全 timestamp が window 外 → allow
    const after = checkContactRateLimit(key, now + 60 * 60 * 1000 + 1)
    expect(after.allowed).toBe(true)
  })

  it('異なる key (IP / userId) は独立に 5 件ずつ allow', () => {
    const now = 1_700_000_000_000
    const keys = ['ip:1.2.3.4', 'ip:5.6.7.8', 'userId:u_abc']
    for (const key of keys) {
      for (let i = 0; i < 5; i++) {
        expect(checkContactRateLimit(key, now + i).allowed).toBe(true)
      }
      // 自 key は 6 件目 block
      expect(checkContactRateLimit(key, now + 5).allowed).toBe(false)
    }
    // 別 key は依然として独立に最初の 5 件 allow 済 (mutual interference なし)
    // → 既に上 loop で都度確認済。 追加で「新 key を作って即 allow」 を念のため確認。
    expect(
      checkContactRateLimit('userId:u_xyz', now + 100).allowed,
    ).toBe(true)
  })
})
