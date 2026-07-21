'use server'

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { userSettings } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'
import { logger } from '@/lib/logger'

export async function saveSessionLimit(value: number | null): Promise<ActionResult<void>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  // null = 上限なし (valid). Integer check + range validation (1〜200) for non-null.
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 200)) {
    return { ok: false, error: '1〜200 で指定してください' }
  }

  const db = getDb()
  try {
    await withTenantTx(db, user.id, (tx) =>
      tx
        .insert(userSettings)
        .values({ userId: user.id, sessionLimit: value })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { sessionLimit: value, updatedAt: new Date() },
        }),
    )
  } catch (err) {
    logger.error({ event: 'save_session_limit.error', err, userId: user.id, value })
    return { ok: false, error: '保存に失敗しました。しばらくしてからお試しください' }
  }

  // S-cache-2a: revalidatePath('/app/settings') は撤去。 session-limit-form は
  // local state (value + 「保存しました」 message) で UI を完結させ、 server 派生
  // value を画面に再表示する経路を持たない (`router.refresh()` 呼出無し)。
  // 加えて Next.js 15 default `staleTimes.dynamic = 0` 下では /app/settings 自体が
  // router cache に乗らないため、 次回 navigation で必ず fresh server fetch される。
  // = 同 path への revalidatePath は no-op。
  return { ok: true }
}
