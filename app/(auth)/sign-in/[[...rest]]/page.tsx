import { SignIn } from '@clerk/nextjs'

// (auth) layout が AuthHeader + main center を担当、 page は Clerk
// SignIn primitive 直書きのみ。
export default function Page() {
  return <SignIn />
}
