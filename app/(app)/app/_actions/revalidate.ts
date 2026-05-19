'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/ensure-user'

// Path 制限を型 literal で行う。任意 string を受けないことで client から
// 想定外の path を破棄されないようにする (本 sprint の Server Action は
// `<Link onClick>` 経由のみ呼ばれる前提)。
// Sprint A-2: /app/words / /app/review 撤去 (vocab frontend drop)。
// S1a: /app/upload 追加 (OCR 起動 page)。
// S1.7: /app/exams 追加 (read-only exam viewer、 S2 で正式 CRUD)。
// 残 mcq routes (/study/smart, /study/practice, /cards/[id]) は後続 Sprint で追加。
export type AppPath =
  | '/app'
  | '/app/settings'
  | '/app/quiz'
  | '/app/upload'
  | '/app/exams'

// auth gate は project 既存 convention に倣う:
// - user row 不在 (post-sign-up sync race) → null → no-op
// - Clerk session 不在 → getCurrentUser() が UnauthenticatedError を throw、
//   onClick 側 `void revalidateAppPath(...)` で promise rejection は伝播するが
//   Next.js が log するのみで navigation 自体は継続 (cache 破棄は走らない)
export async function revalidateAppPath(path: AppPath): Promise<void> {
  const user = await getCurrentUser()
  if (!user) return
  revalidatePath(path)
}
