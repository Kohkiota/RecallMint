import { describe, it, expect } from 'vitest'
import { isWebhookBypass, imageCspDirectives } from './proxy'

// T-A4 fix (audit §10.3 (b) #13): webhook bypass の構造保証 contract test。
//
// 旧 T-A4 (45a74cf) は `config.matcher` 内 negative lookahead `(?!/webhooks
// (?:$|/))` で構造保証していたが、 Next.js が config.matcher を path-to-regexp
// で評価し、 capturing group / lookahead を許容しないため Vercel build で
// 落ちた (`Error: Invalid source ... Capturing groups are not allowed`)。
// 本 fix で matcher を波 1 確定形に戻し、 webhook 除外を `isWebhookBypass()`
// による pathname check + early return に置換、 contract test を `matchesAny`
// (regex 等価性) から `isWebhookBypass` (pathname check) の unit test に
// 書き換える。 segment boundary `/api/webhooks(?:$|/)` 相当を startsWith +
// 厳密 path check で表現することで、 旧 test の検証粒度 (prefix collision
// 防御含む) を完全に維持する。
describe('proxy webhook bypass (T-A4 fix audit §10.3 (b) #13)', () => {
  it('webhook path は bypass される (clerkMiddleware の auth.protect 経路に巻き込まれない)', () => {
    // Stripe / Clerk いずれの webhook も Clerk auth context を要求しない。
    expect(isWebhookBypass('/api/webhooks/stripe')).toBe(true)
    expect(isWebhookBypass('/api/webhooks/clerk')).toBe(true)
    // sub-path も同様 (将来 webhook 系 path 追加に強い)。
    expect(isWebhookBypass('/api/webhooks/stripe/extra')).toBe(true)
    // boundary lock: bare `/api/webhooks` (no sub-path) と trailing slash も
    // 明示的に bypass、 segment 末尾の挙動を契約 pin (旧 T-A4 M1 review 反映)。
    expect(isWebhookBypass('/api/webhooks')).toBe(true)
    expect(isWebhookBypass('/api/webhooks/')).toBe(true)
  })

  it('既存 path は bypass されない (regression guard)', () => {
    // 保護 route (/app(.*)) と clerk 内部 endpoint、 webhook 以外の api は
    // 引き続き middleware を通す必要がある。
    expect(isWebhookBypass('/app')).toBe(false)
    expect(isWebhookBypass('/app/exams')).toBe(false)
    expect(isWebhookBypass('/api/entity-mutations/bulk')).toBe(false)
    expect(isWebhookBypass('/api/review-events/bulk')).toBe(false)
    expect(isWebhookBypass('/__clerk/foo')).toBe(false)
  })

  it('webhook segment boundary を超える path は bypass されない (prefix collision 防御)', () => {
    // `/api/webhooks-foo` / `/api/webhooks_audit` 等は webhook segment では
    // ないため middleware を通る必要がある。 startsWith + 厳密 path check で
    // 構造的に prefix collision を排除する契約 pin (旧 T-A4 code review I1 反映、
    // 将来 admin/diagnostic 用途で webhook prefix の route が増えた際の silent
    // bypass 防御)。
    expect(isWebhookBypass('/api/webhooks-foo')).toBe(false)
    expect(isWebhookBypass('/api/webhooks_audit')).toBe(false)
    expect(isWebhookBypass('/api/webhooksomething')).toBe(false)
  })
})

// 画像フェーズ A(spec §4): Clerk CSP に merge する追加 directive の contract。
// merge(既存 Clerk/Stripe source の保持)自体は Clerk 実装の責務(7.5.1 の
// handleExistingDirective が append+dedup)。 ここでは本 middleware が Clerk に
// 渡す directive object の形を pin する。
describe('imageCspDirectives (画像フェーズ A CSP・spec §4)', () => {
  it('R2 account 指定時、 connect-src に path-style の R2 exact origin を入れる', () => {
    const d = imageCspDirectives('acc123')
    expect(d['connect-src']).toEqual([
      'https://acc123.r2.cloudflarestorage.com',
    ])
  })

  it('R2 account 未設定時、 connect-src は空(壊れた undefined origin を作らない)', () => {
    expect(imageCspDirectives(undefined)['connect-src']).toEqual([])
    expect(imageCspDirectives('')['connect-src']).toEqual([])
  })

  it('img-src に blob:(getAssetObjectURL の blob: URL 表示用)', () => {
    expect(imageCspDirectives('acc123')['img-src']).toEqual(['blob:'])
  })

  it("worker-src に 'self' blob:(圧縮 worker の blob: worker を明示 pin)", () => {
    expect(imageCspDirectives('acc123')['worker-src']).toEqual(['self', 'blob:'])
  })
})
