import { describe, it, expect } from 'vitest'
import { clerkWebhookEventSchema } from './clerk-webhook'

describe('clerkWebhookEventSchema', () => {
  it('case 1: user.created / user.deleted の minimal valid payload で safeParse success + narrowed data', () => {
    const created = {
      type: 'user.created',
      data: {
        id: 'user_abc',
        email_addresses: [{ email_address: 'new@example.com' }],
      },
    }
    const createdResult = clerkWebhookEventSchema.safeParse(created)
    expect(createdResult.success).toBe(true)
    if (createdResult.success) {
      // narrowed: type literal で discriminated union
      expect(createdResult.data.type).toBe('user.created')
      if (createdResult.data.type === 'user.created') {
        expect(createdResult.data.data.id).toBe('user_abc')
        expect(createdResult.data.data.email_addresses?.[0]?.email_address).toBe(
          'new@example.com',
        )
      }
    }

    const deleted = { type: 'user.deleted', data: { id: 'user_xyz' } }
    const deletedResult = clerkWebhookEventSchema.safeParse(deleted)
    expect(deletedResult.success).toBe(true)
    if (deletedResult.success) {
      expect(deletedResult.data.type).toBe('user.deleted')
      if (deletedResult.data.type === 'user.deleted') {
        expect(deletedResult.data.data.id).toBe('user_xyz')
      }
    }

    // user.created で email_addresses 省略 (optional) でも success
    const createdNoEmail = {
      type: 'user.created',
      data: { id: 'user_no_email' },
    }
    const createdNoEmailResult = clerkWebhookEventSchema.safeParse(createdNoEmail)
    expect(createdNoEmailResult.success).toBe(true)
  })

  it('case 2: unknown field 含む payload も success (Clerk schema drift 耐性)', () => {
    // Clerk が将来 payload に field を追加しても、 unknown field は ignore して
    // 既存 field の narrow を維持する (default object schema = passthrough/strip 挙動、
    // .strict() を呼んでいないので reject されない)。
    const createdWithExtra = {
      type: 'user.created',
      data: {
        id: 'user_drift',
        email_addresses: [
          { email_address: 'drift@example.com', primary: true },
        ],
        unknown_field: 'future_clerk_field',
        first_name: 'Taro',
      },
      object: 'event',
      extra_field: { nested: 'value' },
      timestamp: 1700000000,
    }
    const createdResult = clerkWebhookEventSchema.safeParse(createdWithExtra)
    expect(createdResult.success).toBe(true)
    if (createdResult.success && createdResult.data.type === 'user.created') {
      // 既存 field は narrowed type で取得可能
      expect(createdResult.data.data.id).toBe('user_drift')
      expect(createdResult.data.data.email_addresses?.[0]?.email_address).toBe(
        'drift@example.com',
      )
    }

    const deletedWithExtra = {
      type: 'user.deleted',
      data: { id: 'user_del_drift', deleted: true, object: 'user' },
      instance_id: 'ins_xxx',
    }
    const deletedResult = clerkWebhookEventSchema.safeParse(deletedWithExtra)
    expect(deletedResult.success).toBe(true)
    if (deletedResult.success && deletedResult.data.type === 'user.deleted') {
      expect(deletedResult.data.data.id).toBe('user_del_drift')
    }
  })

  it('case 3: 必須 field 欠落 = fail', () => {
    // data.id 欠落
    const missingId = {
      type: 'user.created',
      data: { email_addresses: [{ email_address: 'noId@example.com' }] },
    }
    const missingIdResult = clerkWebhookEventSchema.safeParse(missingId)
    expect(missingIdResult.success).toBe(false)

    // user.deleted の data.id 欠落
    const deletedMissingId = { type: 'user.deleted', data: {} }
    const deletedMissingIdResult =
      clerkWebhookEventSchema.safeParse(deletedMissingId)
    expect(deletedMissingIdResult.success).toBe(false)

    // type 欠落
    const missingType = { data: { id: 'user_no_type' } }
    const missingTypeResult = clerkWebhookEventSchema.safeParse(missingType)
    expect(missingTypeResult.success).toBe(false)

    // type が未対応値 (discriminated union 外) = fail (handler は 200 + warn で吸収)
    const unknownType = { type: 'session.created', data: { id: 'sess_x' } }
    const unknownTypeResult = clerkWebhookEventSchema.safeParse(unknownType)
    expect(unknownTypeResult.success).toBe(false)
  })
})
