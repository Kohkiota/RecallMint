import Link from 'next/link'

// 未認証 marketing chrome の Footer。 (marketing) RG layout が配備、 top
// / contact / legal 3 page で共通表示。 旧 `components/legal-footer.tsx`
// (3 link) を 4 link 化 (Contact 先頭追加) で吸収廃止した後継。
//
// brand 名は hardcode (2026-05-17 SERVICE_NAME placeholder 撤回)、 © の年は
// `new Date().getFullYear()` で実行時生成 (年跨ぎ後の表示崩れ自動回避、
// 既存 LegalFooter pattern 踏襲)。
export function MarketingFooter() {
  return (
    <footer className="mt-auto border-t border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <p className="text-xs text-slate-500">
          © {new Date().getFullYear()} RecallMint
        </p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Link
            href="/contact"
            className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            お問い合わせ
          </Link>
          <Link
            href="/terms"
            className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            利用規約
          </Link>
          <Link
            href="/privacy"
            className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            プライバシーポリシー
          </Link>
          <Link
            href="/legal"
            className="text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            特定商取引法に基づく表記
          </Link>
        </nav>
      </div>
    </footer>
  )
}
