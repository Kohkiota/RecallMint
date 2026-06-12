import { describe, it, expect } from 'vitest'
import { config } from './proxy'

// T-A4 (audit §10.3 (b) #13): proxy.ts matcher の webhook bypass を構造保証する
// contract test。 Next.js は config.matcher 配列のうち **いずれか** に hit すれば
// middleware を走らせる仕様 (= 配列 OR)。 したがって webhook bypass は「全 pattern
// が webhook path を弾く」 ことで成立し、 ある pattern だけ修正しても他で拾われ
// うる regression を本 test が catch する。
// matcher 文字列は path-to-regexp 風だが、 現状利用している sub-set ( `(...)` /
// `(.*)` / negative lookahead `(?!...)` / character class) は JS RegExp として
// そのまま有効なため、 `^...$` でラップして直接 test する (Next.js 内部変換と
// 同等)。
function matchesAny(path: string): boolean {
  return config.matcher.some((pattern) => {
    const regex = new RegExp('^' + pattern + '$')
    return regex.test(path)
  })
}

describe('proxy matcher webhook bypass (T-A4 audit §10.3 (b) #13)', () => {
  it('webhook path は matcher に hit しない (clerkMiddleware を通らない)', () => {
    // Stripe / Clerk いずれの webhook も Clerk auth context を要求しない構造保証。
    expect(matchesAny('/api/webhooks/stripe')).toBe(false)
    expect(matchesAny('/api/webhooks/clerk')).toBe(false)
    // sub-path も同様に bypass される (将来 webhook 系 path 追加に強い)。
    expect(matchesAny('/api/webhooks/stripe/extra')).toBe(false)
    // boundary lock (code review I1 反映): bare `/api/webhooks` (no sub-path)
    // と trailing slash も明示的に bypass、 segment 末尾の挙動を契約 pin。
    expect(matchesAny('/api/webhooks')).toBe(false)
    expect(matchesAny('/api/webhooks/')).toBe(false)
  })

  it('既存 path は matcher に hit する (regression guard)', () => {
    // 保護 route (/app(.*)) と clerk 内部 endpoint、 webhook 以外の api は
    // 引き続き middleware を通す必要がある。
    expect(matchesAny('/app')).toBe(true)
    expect(matchesAny('/app/exams')).toBe(true)
    expect(matchesAny('/api/entity-mutations/bulk')).toBe(true)
    expect(matchesAny('/api/review-events/bulk')).toBe(true)
    expect(matchesAny('/__clerk/foo')).toBe(true)
  })

  it('webhook segment boundary を超える path は bypass されない (prefix collision 防御、 code review I1)', () => {
    // `/api/webhooks-foo` / `/api/webhooks_audit` 等は webhook segment では
    // ないため middleware を通る必要がある。 segment boundary `(?:$|/)` で
    // 構造的に prefix collision を排除する契約 pin (将来 admin/diagnostic
    // 用途で webhook prefix の route が増えた際の silent bypass 防御)。
    expect(matchesAny('/api/webhooks-foo')).toBe(true)
    expect(matchesAny('/api/webhooks_audit')).toBe(true)
    expect(matchesAny('/api/webhooksomething')).toBe(true)
  })
})
