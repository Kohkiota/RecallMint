'use client'

// sign-out 時のローカル残骸掃除の発火点(tag mirror hygiene sprint / spec §4.3)。
//
// 遷移イベントではなく **状態駆動** で発火する — Clerk の <UserButton /> による
// sign-out・session 失効・退会がどれも同じ経路を通るため。 発火集合は「sign-out」
// より広く、 匿名 visitor の marketing page 訪問も含む(その場合 Dexie 部は
// Dexie.exists guard で no-op)。
//
// 発火は保証にしない(useAuth の cross-tab 反映は未検証): 発火しなかった残骸は
// 次の sign-in の sweep が回収する。 並走の dedup は module 側の in-flight guard。

import { useEffect } from 'react'
import { useAuth } from '@clerk/nextjs'
import { purgeAllLocalData } from '@/lib/sync/local-hygiene'

export function SignOutPurge() {
  const { isLoaded, isSignedIn } = useAuth()

  useEffect(() => {
    if (!isLoaded || isSignedIn) return
    // fire-and-forget・失敗 silent(best-effort ゆえ UI へは出さない)。
    void purgeAllLocalData().catch(() => {})
  }, [isLoaded, isSignedIn])

  return null
}
