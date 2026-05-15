import { MarketingHeader } from '@/components/marketing/marketing-header'
import { MarketingFooter } from '@/components/marketing/marketing-footer'

// 未認証 marketing chrome の RG layout。 (marketing) RG 配下の top (`/`)
// / contact / terms / privacy / legal page を共通 chrome (Header + Footer)
// で wrap。 main は full-flex で page 側が内側 wrapper を選択 (top =
// center 配置 / contact = max-w-2xl / legal = max-w-3xl、 spec §4.6 page
// 別 wrapper pattern)。
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <MarketingHeader />
      <main className="flex-1 flex flex-col">{children}</main>
      <MarketingFooter />
    </div>
  )
}
