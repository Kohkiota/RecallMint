'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { userSettings } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'
import { logger } from '@/lib/logger'

/**
 * user_settings.fsrs_mode を UPSERT。
 *
 * S2.2 sprint plan §T2: 既存 saveSessionLimit と同じ lazy init pattern
 * (行不在時は INSERT、 存在時は onConflictDoUpdate で UPDATE)。
 */
export async function saveFsrsMode(
  value: boolean,
): Promise<ActionResult<{ fsrsMode: boolean }>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()
  try {
    await db
      .insert(userSettings)
      .values({ userId: user.id, fsrsMode: value })
      // drizzle $onUpdate は onConflictDoUpdate で発火しないため
      // conflict branch で updatedAt を明示更新 (S2.1 T5 I-1 由来)
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { fsrsMode: value, updatedAt: new Date() },
      })
  } catch (err) {
    logger.error({ event: 'save_fsrs_mode.error', err, userId: user.id, value })
    return { ok: false, error: '保存に失敗しました。しばらくしてからお試しください' }
  }

  revalidatePath('/app/settings')
  return { ok: true, data: { fsrsMode: value } }
}
