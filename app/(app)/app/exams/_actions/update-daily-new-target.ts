'use server'

import { and, eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { exams } from '@/lib/db/schema'
import {
  dailyNewTargetSchema,
  firstDailyNewTargetError,
} from '@/lib/exams/daily-new-target'
import { logger } from '@/lib/logger'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { reportRlsContextFailure } from '@/lib/db/report-rls-context-failure'
import type { ActionResult } from '@/lib/actions/result'

// 試験ごとの新規/日上限 (K) 設定 server action (Dash-1 Home v1 spec §8.1)。
// rename-exam.ts と同型: 認証 → zod 検証 → tenant-scoped UPDATE → updated_at bump →
// ActionResult。 exam の書込は entity_mutations (outbox) に載せない既存の不変条件
// (既存 4 件の exam 書込 = create / rename / delete / move はいずれも server action 直)。
//
// null = 既定 DAILY_NEW_DEFAULT に追従、 0 = 新規を出さない明示値
// (dailyNewTargetSchema 側のコメント参照)。
//
// UPDATE は daily_new_target + content_version。 updated_at は drizzle の $onUpdate が
// bump し、 増分 pull の cursor がその値を拾って mirror へ伝播する (明示 SET しない)。
// content_version は spec §8.1 の要求どおり同時に +1 する。 exams の content_version は
// 現状 pull で mirror へ運ばれるだけで比較する consumer は無い (exams は outbox に載らない
// ため楽観ロックの対象外 — cards 側とは別軸)。 それでも spec の要求どおり bump する。
//
// rename-exam.ts と異なり revalidatePath は呼ばない: daily_new_target を server render
// する RSC surface が現状存在しない (grep 済 — upload page の投入先 dropdown は exam 名
// のみ依存) ため、 呼んでも no-op になる。 no-op な呼出をコピーしない (簡潔性規律)。
export async function updateDailyNewTarget(
  examId: string,
  value: number | null,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = dailyNewTargetSchema.safeParse(value)
  if (!parsed.success)
    return { ok: false, error: firstDailyNewTargetError(parsed.error) }

  try {
    // RLS-P2 §B: exams は RLS-on ゆえ UPDATE も WITH CHECK 対象。 withTenantTx で
    // tenant context (app.user_id GUC) を張った tx 内で実行する。
    // WHERE user_id = ? で他 user の exam を構造的に保護 (RLS と二重防御)。
    const updated = await withTenantTx(user.id, (tx) =>
      tx
        .update(exams)
        .set({
          dailyNewTarget: parsed.data,
          contentVersion: sql`${exams.contentVersion} + 1`,
        })
        .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))
        .returning({ id: exams.id }),
    )

    // 0 行 = 不在 / 他 user。 rename と同じく「変更が反映されなかった」ことを
    // silent success にせず失敗として返す (UI が inline error を出して気付ける)。
    if (updated.length === 0) {
      return {
        ok: false,
        error: '試験が見つかりませんでした。画面を再読み込みしてください。',
      }
    }

    return { ok: true }
  } catch (err) {
    logger.error({
      event: 'exams.daily_new_target.update.failed',
      examId,
      userId: user.id,
      err: serializeDbError(err),
    })
    // RLS-P3 Task 7: P0RLS (tenant context 未設定) なら台帳 + Discord へ loud alert。
    await reportRlsContextFailure(err, {
      route: 'update-daily-new-target',
      op: 'update',
    })
    return {
      ok: false,
      error: '新規/日の上限の変更に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
