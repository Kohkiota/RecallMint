// POST /api/card-mutations/bulk — Task 1.2 (local-first 書込化)。
//
// client (edit flow) が Dexie に貯めた card mutations を bulk flush する receiver。
// /api/review-events/bulk と対称な envelope + 認証 + 冪等 gate + op dispatch 構造。
//
// 冪等化:
// - `mutation_id` は card_mutations UNIQUE、 同 mutation_id への再送は skip
//   (applied カウントせず、 failed にも入れない = 安全に再送可)。
// - per-mutation の処理順 (op 別):
//   - update_field / create: apply 先 → log INSERT 後
//     (create op では card が apply 後に存在するため log INSERT 時に FK を満たせる)。
//   - delete: log INSERT を書かない。
//     理由: card_mutations.card_id は cards.id への FK (ON DELETE CASCADE)。
//     applyCardDelete が card を物理削除すると cascade で log 行も消えるため
//     log は構造上永続できない。delete の冪等性は applyCardDelete の自然冪等
//     (card 不在 → silent no-op) + tombstone onConflictDoNothing で担保する
//     (spec: 「deleteCard は既に冪等」)。
//
// op 対応状況:
// - update_field: buildSetClause(field, value) + applyCardFieldUpdate — 本 task で実装
// - delete: applyCardDelete — 本 task で実装 (log INSERT なし、上記理由)
// - create: TODO(Task1.3) — 本 task では未対応 → failed[] に倒す
//
// 部分失敗ポリシ:
// - 各 mutation は独立した tx で処理し、 failed[] に積んで 200 返却。
//   review-events/bulk と異なり 1 tx 全体は wrap しない
//   (mutation 間に依存がなく、 per-mutation tx が設計上自然)。
// - orphan card (他 user / 不在) → その mutation を failed[]、 他は継続。
// - 予期せぬ throw → serializeDbError で log、 その mutation を failed[]。
//
// 認可: middleware は /app(.*) のみ protect。 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す。

import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import { cardMutations, type User } from '@/lib/db/schema'
import {
  buildSetClause,
  applyCardFieldUpdate,
  applyCardDelete,
  type UpdateCardFieldName,
} from '@/lib/cards/apply-card-mutation'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Payload validation (zod)
// ---------------------------------------------------------------------------

// zod v4 記法: z.uuid() / z.iso.datetime() / z.enum([...]) を使う
// (review-events/bulk route 踏襲)。
// patch は op 別の詳細検証を Task 1.3 に委ね、 本 task では「object であること」だけ検証。
const mutationSchema = z.object({
  mutation_id: z.uuid(),
  card_id: z.uuid(),
  op: z.enum(['update_field', 'create', 'delete']),
  patch: z.record(z.string(), z.unknown()),
  edited_at: z.iso.datetime(),
})

const payloadSchema = z.object({
  // 1 回の flush で 1000 件超は実用上ないため上限を設けて DoS 寄りの巨大 payload を弾く。
  mutations: z.array(mutationSchema).max(1000),
})

type ParsedMutation = z.infer<typeof mutationSchema>

// ---------------------------------------------------------------------------
// processMutation — 単一 mutation を tx 内で apply + (op に応じて) log INSERT する
// ---------------------------------------------------------------------------
//
// 処理順 (op 別):
// - update_field / create: apply → log INSERT (FK 満たすため apply 先)。
// - delete: applyCardDelete のみ、log INSERT なし。
//   card_mutations.card_id FK は ON DELETE CASCADE。card 削除後に INSERT すると FK 違反、
//   仮に INSERT 先でも cascade で log 行が消える → delete log は構造上永続不可。
//   冪等性は applyCardDelete の自然冪等 (card 不在 = silent no-op) で担保。
// per-mutation tx にするのは mutation 間に依存がなく独立処理が自然なため。

async function processMutation(
  db: ReturnType<typeof getDb>,
  user: User,
  mutation: ParsedMutation,
): Promise<'applied' | 'skipped' | 'failed'> {
  return db.transaction(async (tx) => {
    // ------------------------------------------------------------------
    // delete op: 冪等チェックと log INSERT をスキップし applyCardDelete のみ実行。
    // applyCardDelete は card 不在でも silent success (idempotent)。
    // ------------------------------------------------------------------
    if (mutation.op === 'delete') {
      await applyCardDelete(tx, mutation.card_id, user.id)
      return 'applied'
    }

    // create: TODO(Task1.3) — 本 task では未対応。 failed に倒す。
    if (mutation.op === 'create') {
      return 'failed'
    }

    // ------------------------------------------------------------------
    // update_field: 冪等チェック → apply → log INSERT
    // ------------------------------------------------------------------

    // 冪等チェック: 同 mutation_id (+ user_id) が既存なら skip
    const existing = await tx
      .select({ mutationId: cardMutations.mutationId })
      .from(cardMutations)
      .where(
        and(
          eq(cardMutations.mutationId, mutation.mutation_id),
          eq(cardMutations.userId, user.id),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      // 既適用 → skip (applied にカウントしない、 failed でもない)
      return 'skipped'
    }

    // patch から field / value を取り出す (Task 1.3 で per-op zod 化予定)。
    // buildSetClause は必ず通す (correct_answer_ids 再生成 / validation のため)。
    // field は unknown のまま受けて string に narrow してから UpdateCardFieldName に cast。
    const fieldRaw: unknown = mutation.patch['field']
    const value = mutation.patch['value']

    if (typeof fieldRaw !== 'string') {
      // patch.field が未指定 / 非 string → 検証失敗
      return 'failed'
    }

    const clauseResult = buildSetClause(fieldRaw as UpdateCardFieldName, value)
    if (!clauseResult.ok) {
      // buildSetClause の validation 失敗
      return 'failed'
    }

    const result = await applyCardFieldUpdate(tx, mutation.card_id, user.id, clauseResult.data)
    if (!result.found) {
      // orphan / owner mismatch → 0 row
      return 'failed'
    }

    // ------------------------------------------------------------------
    // log INSERT: apply 後なので FK 制約を満たす
    // .onConflictDoNothing({ target: mutationId }) は並走 race の backstop
    // ------------------------------------------------------------------
    await tx
      .insert(cardMutations)
      .values({
        mutationId: mutation.mutation_id,
        cardId: mutation.card_id,
        userId: user.id,
        patch: mutation.patch,
        editedAt: new Date(mutation.edited_at),
        appliedAt: sql`now()`,
      })
      .onConflictDoNothing({ target: cardMutations.mutationId })

    return 'applied'
  })
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // -- 認証 --
  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401 })
    }
    throw err
  }
  if (!user) {
    // Clerk session はあるが users 行未 sync (sign-up race)。 401 と区別して
    // client に「user 行が来るまで待って再送」 を促す。
    return Response.json({ error: 'user_not_synced' }, { status: 401 })
  }

  // -- payload parse + validation --
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = payloadSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  const { mutations } = parsed.data

  const db = getDb()

  // -- per-mutation 処理 --
  let applied = 0
  const failed: string[] = []

  for (const mutation of mutations) {
    try {
      const result = await processMutation(db, user, mutation)
      if (result === 'applied') {
        applied++
      } else if (result === 'failed') {
        failed.push(mutation.mutation_id)
      }
      // 'skipped' は applied にも failed にも入れない (冪等 skip)
    } catch (err) {
      // 予期せぬ throw (DB 接続障害等) → log して failed に積む (200 契約維持)
      logger.warn({
        event: 'card_mutations.bulk.mutation_failed',
        mutationId: mutation.mutation_id,
        cardId: mutation.card_id,
        userId: user.id,
        err: serializeDbError(err, { cardIds: [mutation.card_id] }),
      })
      failed.push(mutation.mutation_id)
    }
  }

  return Response.json({ ok: true, applied, failed }, { status: 200 })
}
