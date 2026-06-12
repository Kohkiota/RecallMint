// Clerk webhook payload zod schema (audit §10.3 (b) #10)。
//
// 目的: Clerk webhook (`user.created` / `user.deleted`) payload を最小 field set
// で validate し、 unknown field は drift 耐性で ignore する。 schema drift で
// silently miss する経路を解消、 verify 後の `as ClerkEvent` cast を排除して
// narrowed type で handler logic に渡す。
//
// drift 耐性: zod の default object schema は unknown field を ignore する
// (= strict() を呼ばなければ pass)。 Clerk が将来 payload に field を追加しても、
// 既存 field の narrow を維持して silent miss しない。
//
// shared 不付 (Y-1 T5 + T-A1〜T-A5 helper precedent と同方針): server-only import
// を付けない — zod schema は client-side でも safe に再利用可能 (実際には
// webhook handler は server 専用だが、 schema の portability は維持)。
//
// 参照: https://clerk.com/docs/webhooks/overview

import { z } from 'zod'

const clerkUserCreatedSchema = z.object({
  type: z.literal('user.created'),
  data: z.object({
    id: z.string(),
    email_addresses: z
      .array(z.object({ email_address: z.string() }))
      .optional(),
  }),
})

const clerkUserDeletedSchema = z.object({
  type: z.literal('user.deleted'),
  data: z.object({
    id: z.string(),
  }),
})

export const clerkWebhookEventSchema = z.discriminatedUnion('type', [
  clerkUserCreatedSchema,
  clerkUserDeletedSchema,
])

export type ClerkWebhookEvent = z.infer<typeof clerkWebhookEventSchema>
