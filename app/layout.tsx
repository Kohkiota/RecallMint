import type { Metadata, Viewport } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

// brand 名は hardcode (2026-05-17 SERVICE_NAME placeholder 撤回)。
// RecallMint は具体的 project で template ではない、 別サービス流用は
// devcontainer-template repo の責務に切り出し済。
const SITE_TITLE = 'RecallMint — AI OCR × FSRS 学習アプリ'
const SITE_DESCRIPTION =
  'AI OCR で学習資料を取り込み、 FSRS 忘却曲線で効率的に復習する MCQ 学習アプリ'
const SITE_URL = 'https://recallmint.nekotest.net'
// OG / Twitter card 用画像 path。 S0-3 では placeholder (画像未配置)、 S8 で
// 本番画像を `/og-image.png` (1200×630) として `public/` に配置する。 画像が
// 存在しない間は SNS share preview は icon fallback で動作するため、 launch
// 阻害はしない。
const OG_IMAGE_PATH = '/og-image.png'

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  // Phase 1 G-pwa-1 (N-baseline-12): manifest を Next.js が <link rel="manifest">
  // として自動 inject。骨格のみ (manifest + icons + theme color)、service worker
  // / offline cache / push 通知は Phase 2 検討。
  manifest: '/manifest.json',
  // PWA follow-up: icons を明示配備。manifest.json の icons (PWA install 用)
  // と独立に、HTML <head> の <link rel="icon"> / <link rel="apple-touch-icon">
  // を browser タブ / iOS Safari ホーム画面追加に向けて Next.js 経由で inject。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'RecallMint',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: 'ja_JP',
    images: [
      {
        url: OG_IMAGE_PATH,
        width: 1200,
        height: 630,
        alt: 'RecallMint — AI OCR × FSRS 学習アプリ',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE_PATH],
  },
}

// Next.js 14+ で metadata.themeColor は deprecated、viewport export 経由が公式。
export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      appearance={{
        // Clerk SDK v7 では terms / privacy URL は appearance.options 配下に
        // 配置する (appearance.layout ではない、 公式 doc 確認済)。 SignIn /
        // SignUp / UserButton 系 component の同意 link 表示に使用、 値は
        // 内部 marketing route の現存 page を指す (12 placeholder は
        // 残置のまま、 本番値 sed 一括置換は S8)。
        options: {
          termsPageUrl: '/terms',
          privacyPageUrl: '/privacy',
        },
      }}
    >
      <html lang="ja" className={cn("font-sans", geist.variable)}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
