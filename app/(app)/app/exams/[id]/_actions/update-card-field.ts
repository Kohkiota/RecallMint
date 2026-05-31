'use server'

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import type { ActionResult } from '@/lib/actions/result'
import { logger } from '@/lib/logger'
import {
  buildSetClause,
  applyCardFieldUpdate,
  type UpdateCardFieldName,
} from '@/lib/cards/apply-card-mutation'

// 試験詳細画面 (/app/exams/[id]) inline 編集用の field 単位 server action。
// 既存 updateCard (cards/[id] 5 列同時保存) は変更せず、 本 action では
// editable 1 field のみ owner-scoped で UPDATE する (options 指定時のみ
// correct_answer_ids も同時更新 — 2 列 set)。
// 各 field の validation は lib/validation/card.ts と同等ルールを field 単位に
// 再構成、 optionSchema は同 file から再利用 (DRY)。
//
// ドメイン core (buildSetClause / applyCardFieldUpdate) は
// lib/cards/apply-card-mutation.ts に抽出済 (Task 1.1)。
// この wrapper は認証 / ActionResult 変換 / logger のみを担う。

// UpdateCardFieldName は apply-card-mutation.ts から再 export (外部シグネチャ維持)。
export type { UpdateCardFieldName } from '@/lib/cards/apply-card-mutation'

export async function updateCardField(
  cardId: string,
  field: UpdateCardFieldName,
  value: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const built = buildSetClause(field, value)
  if (!built.ok) return built

  const db = getDb()
  try {
    const result = await applyCardFieldUpdate(db, cardId, user.id, built.data)

    if (!result.found) return { ok: false, error: 'カードが見つかりません' }

    // S-cache-2a: revalidatePath('/app/exams/[id]') は撤去。 Next.js 15 は client
    // component から呼ばれた server action の完了後、 呼出元 route segment の
    // server component を自動再実行して新 RSC tree を返す (inline-text-field /
    // inline-option-row の `serverOptions` prop 更新が依存する機構)。 同 path への
    // revalidatePath はこの自動再実行と重複し redundant。
    // (cache-fix roadmap ④-3: 旧 /app/cards/[id] page への cross-page revalidate
    // も同 page 廃止に伴い撤去済)
    return { ok: true }
  } catch (err) {
    logger.error({
      event: 'cards.update_field.failed',
      cardId,
      field,
      userId: user.id,
      err,
    })
    return {
      ok: false,
      error: '保存に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
