import { ContactForm } from '@/components/marketing/contact-form'

// 認証外 contact page。 server component に薄化 (Phase 1 I-D で
// 抽出、 form 本体は components/marketing/contact-form.tsx)。
// (marketing) layout が MarketingHeader + MarketingFooter chrome を
// 提供、 page 側は max-w-2xl wrapper のみ。
export const metadata = {
  title: 'お問い合わせ',
  description: 'ご質問・ご要望はこちらからお送りください。',
}

export default function ContactPage() {
  return (
    <div className="max-w-2xl mx-auto w-full px-4 py-8 md:py-12">
      <ContactForm />
    </div>
  )
}
