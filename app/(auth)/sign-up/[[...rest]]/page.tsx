import { SignUp } from '@clerk/nextjs'

// (auth) layout が AuthHeader + main center を担当、 page は Clerk
// SignUp primitive 直書きのみ。
export default function Page() {
  return <SignUp />
}
