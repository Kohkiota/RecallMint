import { describe, it, expect } from 'vitest'

import nextConfig from './next.config'

describe('next.config security headers', () => {
  it('includes Permissions-Policy with spec §10.2 default candidate directives', async () => {
    const rules = await nextConfig.headers!()
    expect(rules).toHaveLength(1)
    expect(rules[0].source).toBe('/:path*')

    const headers = rules[0].headers
    const perm = headers.find((h) => h.key === 'Permissions-Policy')
    expect(perm).toBeDefined()

    // spec §10.2 default candidate の代表 4 directive を assert
    // (記憶ベース固定禁止 — spec 文言の引き写しを検証)
    expect(perm!.value).toContain('camera=()')
    expect(perm!.value).toContain('fullscreen=(self)')
    expect(perm!.value).toContain('publickey-credentials-get=()')
    expect(perm!.value).toContain('xr-spatial-tracking=()')

    // 全 23 directive count (comma + space separator、 single line):
    const directives = perm!.value.split(',').map((s) => s.trim())
    expect(directives).toHaveLength(23)
  })

  it('既存 5 header (HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / CSP) を不変維持 + Permissions-Policy を 6 番目に追加', async () => {
    const rules = await nextConfig.headers!()
    const headerKeys = rules[0].headers.map((h) => h.key)
    expect(headerKeys).toEqual([
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Content-Security-Policy',
      'Permissions-Policy',
    ])

    // 既存 header の value も不変であること
    const headers = rules[0].headers
    expect(headers.find((h) => h.key === 'Strict-Transport-Security')!.value).toBe(
      'max-age=31536000; includeSubDomains',
    )
    expect(headers.find((h) => h.key === 'X-Frame-Options')!.value).toBe('DENY')
    expect(headers.find((h) => h.key === 'X-Content-Type-Options')!.value).toBe('nosniff')
    expect(headers.find((h) => h.key === 'Referrer-Policy')!.value).toBe(
      'strict-origin-when-cross-origin',
    )
    expect(headers.find((h) => h.key === 'Content-Security-Policy')!.value).toBe(
      "frame-ancestors 'none'",
    )
  })

  it('experimental.serverActions.bodySizeLimit が 4.5mb で固定 (drift 防止、 incident hotfix 6c7e99e)', () => {
    // Next.js 16 で experimental.serverActions の型は any 寄りで narrow には cast が必要。
    const exp = nextConfig.experimental as
      | { serverActions?: { bodySizeLimit?: string } }
      | undefined
    expect(exp?.serverActions?.bodySizeLimit).toBe('4.5mb')
  })
})
