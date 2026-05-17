// Phase 1 E-4 法務 page smoke test (Phase 1 I-K で chrome / RG 構造変更
// に追従)。
//
// vitest 環境で .tsx を直接 import すると、tsconfig.json の jsx: "preserve"
// (Next.js 用) と vite (vite 8 / vitest 4) の import-analysis が衝突し、
// JSX transform が走らず parse 失敗する。@vitejs/plugin-react 等の依存追加は
// CLAUDE.md ライブラリ追加事前相談ルール対象なので回避し、source-level
// 文字列 grep で smoke test とする。
//
// 検証対象: 各 page / chrome (Header/Footer/Layout) の source file が必須
// 文言・link href・placeholder を含むこと、 また旧 LegalFooter / LegalLayout
// が削除されていること。 実 render は production build (`pnpm build`) 時に
// Next.js が行うので、本 test は静的検証で十分。

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../..')
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf-8')
const exists = (rel: string): boolean => existsSync(path.join(root, rel))

describe('MarketingFooter (components/marketing/marketing-footer.tsx)', () => {
  const src = read('components/marketing/marketing-footer.tsx')

  it('exports MarketingFooter as named export', () => {
    expect(src).toMatch(/export function MarketingFooter\(\)/)
  })

  it('renders 4 internal Links to /contact / /terms / /privacy / /legal', () => {
    expect(src).toContain('href="/contact"')
    expect(src).toContain('href="/terms"')
    expect(src).toContain('href="/privacy"')
    expect(src).toContain('href="/legal"')
    expect(src).toContain('お問い合わせ')
    expect(src).toContain('利用規約')
    expect(src).toContain('プライバシーポリシー')
    expect(src).toContain('特定商取引法に基づく表記')
  })

  it('uses next/link (not <a>) for navigation', () => {
    expect(src).toContain("from 'next/link'")
    const linkOpenTags = src.match(/<Link\s/g) ?? []
    expect(linkOpenTags.length).toBe(4)
  })

  it('renders RecallMint brand hardcode (SERVICE_NAME placeholder 撤回後)', () => {
    expect(src).toContain('RecallMint')
    expect(src).not.toContain('{{SERVICE_NAME}}')
  })

  it('uses mt-auto for bottom push and border-top for separation', () => {
    expect(src).toContain('mt-auto')
    expect(src).toContain('border-t')
  })
})

describe('Logo (components/brand/logo.tsx)', () => {
  const src = read('components/brand/logo.tsx')

  it('exports Logo as named export', () => {
    expect(src).toMatch(/export function Logo\(\)/)
  })

  it('renders RecallMint brand hardcode (SERVICE_NAME placeholder 撤回後)', () => {
    expect(src).toContain('RecallMint')
    expect(src).not.toContain('{{SERVICE_NAME}}')
  })
})

describe('Terms page (app/(marketing)/terms/page.tsx)', () => {
  const src = read('app/(marketing)/terms/page.tsx')

  it('has default export and metadata title', () => {
    expect(src).toMatch(/export default function TermsPage/)
    expect(src).toContain("title: '利用規約'")
  })

  it('contains all 15 章 titles', () => {
    expect(src).toContain('第1条 (適用)')
    expect(src).toContain('第2条 (利用登録)')
    expect(src).toContain('第3条 (ユーザー ID およびパスワードの管理)')
    expect(src).toContain('第4条 (料金および支払方法)')
    expect(src).toContain('第5条 (禁止事項)')
    expect(src).toContain('第6条 (本サービスの提供の停止等)')
    expect(src).toContain('第7条 (利用制限および登録抹消)')
    expect(src).toContain('第8条 (退会)')
    expect(src).toContain('第9条 (保証の否認および免責事項)')
    expect(src).toContain('第10条 (サービス内容の変更等)')
    expect(src).toContain('第11条 (利用規約の変更)')
    expect(src).toContain('第12条 (個人情報の取扱い)')
    expect(src).toContain('第13条 (通知または連絡)')
    expect(src).toContain('第14条 (権利義務の譲渡の禁止)')
    expect(src).toContain('第15条 (準拠法・裁判管轄)')
  })

  it('contains key placeholders (12 placeholder 体制、 SERVICE_NAME は hardcode 化済)', () => {
    expect(src).toContain('{{COMPANY_NAME}}')
    expect(src).not.toContain('{{SERVICE_NAME}}')
    expect(src).toContain('RecallMint')
    expect(src).toContain('{{PRICE}}')
    expect(src).toContain('{{JURISDICTION}}')
    expect(src).toContain('{{LAST_UPDATED}}')
    expect(src).toContain('{{LAUNCH_DATE}}')
  })

  it('contains max-w-3xl wrapper (旧 LegalLayout から page 内側に移譲)', () => {
    expect(src).toContain('max-w-3xl')
  })

  it('禁止事項 lists 13 items', () => {
    const start = src.indexOf('第5条 (禁止事項)')
    const end = src.indexOf('第6条 (本サービスの提供の停止等)')
    const section = src.slice(start, end)
    const liCount = (section.match(/<li>/g) ?? []).length
    expect(liCount).toBe(13)
  })
})

describe('Privacy page (app/(marketing)/privacy/page.tsx)', () => {
  const src = read('app/(marketing)/privacy/page.tsx')

  it('has default export and metadata title', () => {
    expect(src).toMatch(/export default function PrivacyPage/)
    expect(src).toContain("title: 'プライバシーポリシー'")
  })

  it('contains all 11 章 titles', () => {
    expect(src).toContain('第1条 (基本方針)')
    expect(src).toContain('第2条 (取得する個人情報の項目)')
    expect(src).toContain('第3条 (利用目的)')
    expect(src).toContain('第4条 (第三者提供)')
    expect(src).toContain('第5条 (個人データの取扱いの委託)')
    expect(src).toContain('第6条 (外国にある第三者への個人データの提供)')
    expect(src).toContain('第7条 (安全管理措置および外的環境の把握)')
    expect(src).toContain('第8条 (Cookie その他の技術)')
    expect(src).toContain('第9条 (開示・訂正・利用停止等の請求)')
    expect(src).toContain('第10条 (プライバシーポリシーの変更)')
    expect(src).toContain('第11条 (お問い合わせ窓口)')
  })

  it('lists the 5 SaaS delegates with correct names', () => {
    expect(src).toContain('Clerk, Inc.')
    expect(src).toContain('Stripe, Inc.')
    expect(src).toContain('Neon, Inc.')
    expect(src).toContain('Vercel, Inc.')
    expect(src).toContain('Google LLC')
  })

  it('links to each delegate privacy policy URL', () => {
    expect(src).toContain('https://clerk.com/legal/privacy')
    expect(src).toContain('https://stripe.com/jp/privacy')
    expect(src).toContain('https://neon.com/privacy-policy')
    expect(src).toContain('https://vercel.com/legal/privacy-policy')
    expect(src).toContain('https://policies.google.com/privacy')
  })

  it('contains key placeholders', () => {
    expect(src).toContain('{{COMPANY_NAME}}')
    expect(src).toContain('{{EMAIL}}')
    expect(src).toContain('{{DISCLOSURE_FEE}}')
    expect(src).toContain('{{LAST_UPDATED}}')
    expect(src).toContain('{{LAUNCH_DATE}}')
  })

  it('contains max-w-3xl wrapper (旧 LegalLayout から page 内側に移譲)', () => {
    expect(src).toContain('max-w-3xl')
  })
})

describe('Commerce disclosure page (app/(marketing)/legal/page.tsx)', () => {
  const src = read('app/(marketing)/legal/page.tsx')

  it('has default export and metadata title', () => {
    expect(src).toMatch(/export default function CommerceDisclosurePage/)
    expect(src).toContain("title: '特定商取引法に基づく表記'")
  })

  it('contains the request-on-disclosure clause and EMAIL placeholder', () => {
    expect(src).toContain('ご請求があった場合は遅滞なく開示します')
    expect(src).toContain('{{EMAIL}}')
  })

  it('contains required disclosure items', () => {
    expect(src).toContain('販売事業者')
    expect(src).toContain('運営責任者')
    expect(src).toContain('所在地')
    expect(src).toContain('電話番号')
    expect(src).toContain('メールアドレス')
    expect(src).toContain('受付時間')
    expect(src).toContain('ホームページ URL')
    expect(src).toContain('販売価格')
    expect(src).toContain('商品代金以外の必要料金')
    expect(src).toContain('引渡時期')
    expect(src).toContain('支払方法')
    expect(src).toContain('支払時期')
    expect(src).toContain('返品・キャンセル等')
    expect(src).toContain('動作環境')
  })

  it('contains key placeholders', () => {
    expect(src).toContain('{{EMAIL}}')
    expect(src).toContain('{{DOMAIN}}')
    expect(src).toContain('{{PRICE}}')
    expect(src).toContain('{{BUSINESS_HOURS}}')
    expect(src).toContain('{{LAST_UPDATED}}')
  })

  it('contains max-w-3xl wrapper (旧 LegalLayout から page 内側に移譲)', () => {
    expect(src).toContain('max-w-3xl')
  })
})

describe('Marketing layout (app/(marketing)/layout.tsx)', () => {
  const src = read('app/(marketing)/layout.tsx')

  it('imports MarketingHeader + MarketingFooter and renders both', () => {
    expect(src).toContain("from '@/components/marketing/marketing-header'")
    expect(src).toContain("from '@/components/marketing/marketing-footer'")
    expect(src).toContain('<MarketingHeader />')
    expect(src).toContain('<MarketingFooter />')
  })

  it('does not import the deleted LegalFooter', () => {
    expect(src).not.toContain('legal-footer')
    expect(src).not.toContain('LegalFooter')
  })
})

describe('Auth layout (app/(auth)/layout.tsx)', () => {
  const src = read('app/(auth)/layout.tsx')

  it('imports AuthHeader and renders it', () => {
    expect(src).toContain("from '@/components/auth/auth-header'")
    expect(src).toContain('<AuthHeader />')
  })

  it('does not import any footer (auth は footer なし方針)', () => {
    expect(src).not.toContain('legal-footer')
    expect(src).not.toContain('LegalFooter')
    expect(src).not.toContain('marketing-footer')
    expect(src).not.toContain('MarketingFooter')
  })
})

describe('LegalFooter / LegalLayout removed (Phase 1 I-K)', () => {
  it('components/legal-footer.tsx is deleted', () => {
    expect(exists('components/legal-footer.tsx')).toBe(false)
  })

  it('app/(legal)/layout.tsx is deleted', () => {
    expect(exists('app/(legal)/layout.tsx')).toBe(false)
  })

  it('(legal) Route Group folder is removed', () => {
    expect(exists('app/(legal)')).toBe(false)
  })
})

describe('Marketing / Auth pages do not import LegalFooter directly', () => {
  const pages = [
    'app/(marketing)/page.tsx',
    'app/(marketing)/contact/page.tsx',
    'app/(marketing)/terms/page.tsx',
    'app/(marketing)/privacy/page.tsx',
    'app/(marketing)/legal/page.tsx',
    'app/(auth)/sign-in/[[...rest]]/page.tsx',
    'app/(auth)/sign-up/[[...rest]]/page.tsx',
    'app/(auth)/sign-out-deleted/page.tsx',
  ]

  for (const p of pages) {
    it(`${p} does not import legal-footer`, () => {
      const src = read(p)
      expect(src).not.toContain("from '@/components/legal-footer'")
      expect(src).not.toContain('<LegalFooter')
    })
  }
})

describe('/app/settings legal links section', () => {
  // I-K commit 2 で path を app/(app)/app/settings/page.tsx に書換、 さらに
  // 法的情報 section の ul 先頭に Contact link を追加 (CS 入口最上位)。
  const src = read('app/(app)/app/settings/page.tsx')

  it('contains 法的情報 section heading', () => {
    expect(src).toContain('法的情報')
  })

  it('renders 4 internal Links to /contact / /terms / /privacy / /legal', () => {
    expect(src).toContain('href="/contact"')
    expect(src).toContain('href="/terms"')
    expect(src).toContain('href="/privacy"')
    expect(src).toContain('href="/legal"')
    expect(src).toContain('お問い合わせ')
  })

  it('uses internal Link (not <a> external) — 4 links in section', () => {
    const start = src.indexOf('法的情報')
    const end = src.indexOf('</section>', start)
    const section = src.slice(start, end)
    const linkOpenTags = section.match(/<Link\s/g) ?? []
    expect(linkOpenTags.length).toBe(4)
  })
})
