'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import type { ActionResult } from '@/lib/actions/result'
import { logger } from '@/lib/logger'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import {
  applyCardCreate,
  EXAM_NOT_FOUND,
} from '@/lib/cards/apply-card-mutation'

// 試験詳細画面 (/app/exams/[id]) 末尾「+ カードを追加」用の card 手動作成 action。
// placeholder 値 (edit zod を満たす最小 card、 lib/cards/empty-card.ts) を owner-scoped
// で cards に INSERT し、 同一 transaction で exams.card_count += 1 する。
//
// spec §3.6: card_count は派生キャッシュ。 insert と increment を同一 tx に閉じることが
// 件数整合 (card_count === COUNT(cards)) の唯一の保証。 process.ts の bulk insert と
// 同じ tx + sql increment パターンに合わせる。
// updatedAt は card 増減で動かさない (試験一覧の updatedAt DESC 順を乱さない、
// process.ts B1 と同方針)。
//
// 出題除外 filter は付けない (spec §3.2: 空 card も query 可能、 意図的設計)。
//
// ドメイン core (applyCardCreate) は lib/cards/apply-card-mutation.ts に抽出済 (Task 1.1)。
// この wrapper は認証 / transaction 境界 / ActionResult 変換 / logger / revalidatePath を担う。

export async function createCard(
  examId: string,
): Promise<ActionResult<{ cardId: string }>> {
  try {
    return await _createCard(examId)
  } finally {
    revalidatePath('/app/exams')
  }
}

async function _createCard(
  examId: string,
): Promise<ActionResult<{ cardId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()
  try {
    const result = await db.transaction(async (tx) => {
      return applyCardCreate(tx, examId, user.id)
    })

    if (result === EXAM_NOT_FOUND) {
      return { ok: false, error: '試験が見つかりません' }
    }
    return { ok: true, data: { cardId: result } }
  } catch (err) {
    logger.error({
      event: 'cards.create.failed',
      examId,
      userId: user.id,
      err: serializeDbError(err, {}),
    })
    return {
      ok: false,
      error: 'カードの追加に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
