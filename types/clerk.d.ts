// Clerk sessionClaims の型拡張 (publicMetadata を JWT template 経由で expose した
// claim を型安全に読むため)。 `auth()` から返る `sessionClaims` に直 access する
// pattern を `lib/auth/ensure-user.ts` の `getAuthContext()` 経由で使う想定。
//
// 前提:
// - Clerk Dashboard → Configure → Sessions → Customize session token で
//   publicMetadata 内の dbUserId / plan を平 claim として expose する設定が
//   dev / prod 両方で実施済。
// - 設定 docs: `docs/superpowers/sessions/2026-05-26-jwt-template-setup.md`
// - billingInterval / cancelAt は本 sprint では JWT に乗せない。 これらが必要な
//   page (`/app/page.tsx` の upgrade hide / `/app/settings` / `/app/upgrade`)
//   は `getCurrentUser()` 経由で users 行を直接読む既存経路を維持する。
//
// 注意:
// - Clerk publicMetadata は同 user に対する update 後、 既存セッションの JWT が
//   refresh されるまで反映されない (= 旧 claim が残る window がある)。 consumer
//   側は stale plan を許容するか、 必要時 force refresh する。
// - Clerk JWT が standard claim のみで publicMetadata 由来 claim が乗らない
//   default session の場合 (= template 未設定 / 旧セッション持ち越し)、 全 claim
//   は undefined として扱われ、 consumer 側で getCurrentUser() への fallback が
//   発火する設計を `getAuthContext()` で担保する。

import type { Plan } from '@/lib/auth/plan-limits'

declare global {
  interface CustomJwtSessionClaims {
    // Clerk publicMetadata.dbUserId に対応 (= users.id の UUID 文字列)。
    dbUserId?: string
    // Clerk publicMetadata.plan に対応 ('free' | 'standard' | 'pro')。
    plan?: Plan
  }
}

export {}
