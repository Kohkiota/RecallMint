import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DB } from '@/lib/db'

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: vi.fn().mockResolvedValue(undefined),
}))

import { auth } from '@clerk/nextjs/server'
import { getDb } from '@/lib/db'
import { notifyOps } from '@/lib/ops'
import { submitContact } from './actions'

// Drizzle chain mock factory:
// - select().from().where().limit() → resolves to provided rows (users lookup)
// - insert().values() → resolves to undefined (success) or rejects (failure)
function makeFakeDb(opts: {
  selectRows?: Array<{ id: string }>
  insertReject?: Error
}) {
  const limit = vi.fn(() => Promise.resolve(opts.selectRows ?? []))
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))

  const values = opts.insertReject
    ? vi.fn(() => Promise.reject(opts.insertReject))
    : vi.fn(() => Promise.resolve())
  const insert = vi.fn(() => ({ values }))

  return { select, insert, _values: values } as unknown as DB & {
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
  })

  it('zod 違反 (subject 空) → ok:false + error message、 DB insert 走らず', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getDb).mockReturnValue(fake as never)

    const result = await submitContact({ ...validInput, subject: '' })

    expect(result).toEqual({ ok: false, error: '件名は必須です' })
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it('honeypot trip (website 値あり) → ok:true (silent reject)、 DB insert 走らず', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getDb).mockReturnValue(fake as never)

    const result = await submitContact({
      ...validInput,
      website: 'http://spam.example.com',
    })

    expect(result).toEqual({ ok: true })
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it('未認証 + 正常系 → ok:true、 user_id=null で contact_messages に insert', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getDb).mockReturnValue(fake as never)

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
    const fake = makeFakeDb({ selectRows: [{ id: internalUserId }] })
    vi.mocked(getDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({ ok: true })
    expect(fake._values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: internalUserId }),
    )
  })

  it('認証済 + users 未同期 (lookup 0 件) → user_id=null で insert', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_clerk_unsynced' } as never)
    const fake = makeFakeDb({ selectRows: [] })
    vi.mocked(getDb).mockReturnValue(fake as never)

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
    vi.mocked(getDb).mockReturnValue(fake as never)

    const result = await submitContact(validInput)

    expect(result).toEqual({ ok: true })
    expect(fake._values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, email: 'taro@example.com' }),
    )
    expect(notifyOps).not.toHaveBeenCalled()
  })

  it('honeypot 空文字 (送信時 default) は通常の送信扱い → insert 実行', async () => {
    const fake = makeFakeDb({})
    vi.mocked(getDb).mockReturnValue(fake as never)

    const result = await submitContact({ ...validInput, website: '' })

    expect(result).toEqual({ ok: true })
    expect(fake.insert).toHaveBeenCalledTimes(1)
  })

  it('DB insert 失敗 → ok:false + 汎用 error + notifyOps 起動', async () => {
    const fake = makeFakeDb({ insertReject: new Error('connection refused') })
    vi.mocked(getDb).mockReturnValue(fake as never)

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
    vi.mocked(getDb).mockReturnValue(fake as never)

    const result = await submitContact({ ...validInput, category: 'spam' })

    expect(result.ok).toBe(false)
    expect(fake.insert).not.toHaveBeenCalled()
  })
})
