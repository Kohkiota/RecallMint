import { AuthHeader } from '@/components/auth/auth-header'

// auth chrome の RG layout。 (auth) RG 配下の sign-in / sign-up /
// sign-out-deleted page を共通 chrome (AuthHeader のみ、 footer なし)
// で wrap。 main は center 配置 (Clerk SignIn / SignUp / 削除済み message
// 全部 center 系)。
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <AuthHeader />
      <main className="flex-1 flex items-center justify-center p-4">
        {children}
      </main>
    </div>
  )
}
