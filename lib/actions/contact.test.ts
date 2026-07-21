import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DB } from '@/lib/db'

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}))

// RLS-P3 (Task 1): contact.ts's anonymous contact write now calls
// getNonTenantDb() instead of getDb() (same underlying connection — mechanical
// mock-target rename, assertions/behavior unchanged).
vi.mock('@/lib/db', () => ({
  getNonTenantDb: vi.fn(),
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('next/headers', () => ({
  // 各 test ごとに別 IP を返して rate limit bucket を分離する
  // (in-memory LRU が test 間で共有されるため)。
  headers: vi.fn(),
}))

import { auth } from '@clerk/nextjs/server'
import { headers } from 'next/headers'
import { getNonTenantDb } from '@/lib/db'
import { notifyOps } from '@/lib/ops'
import { submitContact } from './contact'
import { __resetContactRateLimitStore } from '@/lib/rate-limit/contact-action'

// 各 test に固有の IP を割り当てて rate limit bucket を分離する helper。
let testIpCounter = 0
function makeFakeHeaders(ip?: string) {
  const finalIp = ip ?? `10.0.0.${++testIpCounter}`
  return {
    get: (name: string) => {
      if (name === 'x-forwarded-for') return finalIp
      return null
    },
  } as unknown as Headers
}

// Drizzle mock factory:
// - execute(sql`SELECT id FROM app_bootstrap_user_from_clerk(...)`) → resolves to
//   provided bootstrap rows (認証済 user の内部 id 解決)。
// - insert().values() → resolves to undefined (success) or rejects (failure)
function makeFakeDb(opts: {
  bootstrapRows?: Array<{ id: string }>
  insertReject?: Error
}) {
  const execute = vi.fn(() => Promise.resolve(opts.bootstrapRows ?? []))

  const values = opts.insertReject
    ? vi.fn(() => Promise.reject(opts.insertReject))
    : vi.fn(() => Promise.resolve())
  const insert = vi.fn(() => ({ values }))

  return { execute, insert, _values: values } as unknown as DB & {
    _values: ReturnType<typeof vi.fn>
  }
}

describe('submitContact', () => {
  const validInput = {
    email: 'taro@example.com',
    category: 'general' as const,
    subject: 'お問い合わせ',
    body: 'はじめまして。',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(auth).mockResolvedValue({ userId: null } as never)
    vi.mocked(headers).mockResolvedValue(makeFakeHeaders() as never)
    __resetContactRateLimitStore()
  })

  it('zod 違反 (subject 空) → ok:false + error message、 DB insert 走らず', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact({ ...validInput, subject: '' })

    expect(result).toEqual({ ok: false, error: '件名は必須です' })
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it('honeypot trip (website 値あり) → ok:true (silent reject)、 DB insert 走らず', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact({
      ...validInput,
      website: 'http://spam.example.com',
    })

    expect(result).toEqual({ ok: true })
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it('未認証 + 正常系 → ok:true、 user_id=null で contact_messages に insert', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({ ok: true })
    expect(fake.insert).toHaveBeenCalledTimes(1)
    expect(fake._values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        email: 'taro@example.com',
        category: 'general',
        subject: 'お問い合わせ',
        body: 'はじめまして。',
      }),
    )
  })

  it('認証済 + 正常系 → ok:true、 user_id=内部 user.id で insert', async () => {
    const internalUserId = '00000000-0000-0000-0000-000000000123'
    vi.mocked(auth).mockResolvedValue({ userId: 'user_clerk_1' } as never)
    const fake = makeFakeDb({ bootstrapRows: [{ id: internalUserId }] })
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({ ok: true })
    expect(fake._values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: internalUserId }),
    )
  })

  it('認証済 + users 未同期 (lookup 0 件) → user_id=null で insert', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_clerk_unsynced' } as never)
    const fake = makeFakeDb({ bootstrapRows: [] })
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({ ok: true })
    expect(fake._values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null }),
    )
  })

  it('auth() throw (Clerk SDK 一時障害) → user_id=null で insert、 notifyOps 起動せず', async () => {
    // 防御パス: Clerk SDK の一時障害 (network blip / 内部エラー) を DB insert
    // 失敗と区別する。 ここで notifyOps が起動すると ops に偽信号が流れる
    // (DB は健全) ため、 必ず匿名扱いで insert を完遂し ok:true を返すこと。
    vi.mocked(auth).mockRejectedValue(new Error('clerk SDK timeout'))
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({ ok: true })
    expect(fake._values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, email: 'taro@example.com' }),
    )
    expect(notifyOps).not.toHaveBeenCalled()
  })

  it('honeypot 空文字 (送信時 default) は通常の送信扱い → insert 実行', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact({ ...validInput, website: '' })

    expect(result).toEqual({ ok: true })
    expect(fake.insert).toHaveBeenCalledTimes(1)
  })

  it('DB insert 失敗 → ok:false + 汎用 error + notifyOps 起動', async () => {
    const fake = makeFakeDb({ insertReject: new Error('connection refused') })
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({
      ok: false,
      error: '送信に失敗しました。時間をおいて再度お試しください。',
    })
    expect(notifyOps).toHaveBeenCalledTimes(1)
    expect(notifyOps).toHaveBeenCalledWith(
      'contact_messages insert failed',
      expect.objectContaining({
        email: 'taro@example.com',
        category: 'general',
        subject: 'お問い合わせ',
      }),
    )
  })

  it('category enum 外 → ok:false + zod error message', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)

    const result = await submitContact({ ...validInput, category: 'spam' })

    expect(result.ok).toBe(false)
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it('rate limit 突破 (同 IP で 6 件目) → ok:false + error:"rate_limited"、 6 件目の DB insert 走らず', async () => {
    // audit §10.3 (b) #15、 T-A7: 同 IP で 5 req/h を超えた 6 件目は
    // gate で弾く (DB insert / notifyOps 双方走らない)。
    const fake = makeFakeDb({})
    vi.mocked(getNonTenantDb).mockReturnValue(fake as never)
    // 全 6 件で同一 IP を返す (固定 fakeHeaders)。
    vi.mocked(headers).mockResolvedValue(
      makeFakeHeaders('192.0.2.99') as never,
    )

    for (let i = 0; i < 5; i++) {
      const ok = await submitContact(validInput)
      expect(ok).toEqual({ ok: true })
    }
    expect(fake.insert).toHaveBeenCalledTimes(5)

    const blocked = await submitContact(validInput)
    expect(blocked).toEqual({ ok: false, error: 'rate_limited' })
    // 6 件目は gate で弾かれているため DB insert 数は 5 件のまま。
    expect(fake.insert).toHaveBeenCalledTimes(5)
    expect(notifyOps).not.toHaveBeenCalled()
  })
})
