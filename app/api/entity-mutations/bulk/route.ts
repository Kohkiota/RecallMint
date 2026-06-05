// POST /api/entity-mutations/bulk — S-sync-1 で旧 /api/card-mutations/bulk を汎用化。
//
// client (Dexie outbox) が貯めた entity mutations を bulk flush する receiver。
// mutation-driven push の唯一の receiver で、 entity_type は registry
// (lib/sync/server/entity-mutation-registry.ts) で定義される文字列 (現状 'card' のみ、
// 後続 sprint で tag_category / tag_option 等を足す)。
//
// 冪等化:
// - `mutation_id` は entity_mutations UNIQUE、 同 mutation_id への再送は skip
//   (applied カウントせず、 failed にも入れない = 安全に再送可)。
// - per-mutation の処理順:
//   1. envelope zod (mutation_id 等の構造) で envelope レベル不正は 400 全体 reject
//   2. (entity_type, op) で registry 検索 — 不在なら per-mutation failed
//   3. registry の patch zod で patch 検証 — 不正なら per-mutation failed
//   4. 冪等チェック: mutation_id 既存なら skipped
//   5. registry.apply(tx, userId, entityId, patch) を呼ぶ
//   6. registry.skipLog でなければ entity_mutations に log INSERT
//      (mutation_id UNIQUE + onConflictDoNothing で並走 race を吸収)
//
// log INSERT skip 慣習 (delete op):
// - delete は registry の skipLog=true 設定により log を残さない。 監査 log として
//   記録不要、 再送 dedupe は tombstone + applyCardDelete の自然冪等で担保する
//   (旧 card-mutations 経路の挙動を維持)。
//
// 部分失敗ポリシ (旧 card 経路から踏襲):
// - 各 mutation は独立した tx で処理し、 失敗は failed[] に積んで 200 で返す。
//   bulk 全体を 400 で reject しない (envelope 不正のみ 400)。
//
// 認可: middleware は /app(.*) のみ protect。 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す。

import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import { entityMutations, type User } from '@/lib/db/schema'
import { lookupRegistryEntry } from '@/lib/sync/server/entity-mutation-registry'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Payload validation (zod) — envelope のみ。 entity_type 別 patch 検証は registry。
// ---------------------------------------------------------------------------

const mutationSchema = z.object({
  mutation_id: z.uuid(),
  entity_type: z.string().min(1),
  entity_id: z.uuid(),
  op: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
  edited_at: z.iso.datetime(),
})

const payloadSchema = z.object({
  // 1 回の flush で 1000 件超は実用上ないため上限を設けて DoS 寄りの巨大 payload を弾く。
  mutations: z.array(mutationSchema).max(1000),
})

type ParsedMutation = z.infer<typeof mutationSchema>

// ---------------------------------------------------------------------------
// processMutation — 単一 mutation を per-mutation tx で apply + (skipLog でなければ)
// log INSERT する。
// ---------------------------------------------------------------------------

async function processMutation(
  db: ReturnType<typeof getDb>,
  user: User,
  mutation: ParsedMutation,
): Promise<'applied' | 'skipped' | 'failed'> {
  return db.transaction(async (tx) => {
    // ---- 1. registry 検索 ----
    const entry = lookupRegistryEntry(mutation.entity_type, mutation.op)
    if (!entry) {
      // 未知の (entity_type, op) は per-mutation failed
      return 'failed'
    }

    // ---- 2. registry の per-op patch zod で検証 ----
    const patchParsed = entry.patch.safeParse(mutation.patch)
    if (!patchParsed.success) {
      return 'failed'
    }

    // ---- 3. 冪等チェック: 同 mutation_id (+ user_id) が既存なら skipped ----
    // skipLog の op (delete) は log 行を持たないため、 mutation_id 既存判定もできず
    // skip 判定不能。 ただし apply 関数自体が冪等 (card_id 不在 → silent no-op、
    // tombstone onConflictDoNothing) なので、 再送時に重複適用にはならない。
    if (!entry.skipLog) {
      const existing = await tx
        .select({ mutationId: entityMutations.mutationId })
        .from(entityMutations)
        .where(
          and(
            eq(entityMutations.mutationId, mutation.mutation_id),
            eq(entityMutations.userId, user.id),
          ),
        )
        .limit(1)
      if (existing.length > 0) {
        // 既適用 → skip (applied にカウントしない、 failed でもない)
        return 'skipped'
      }
    }

    // ---- 4. apply ----
    const applyResult = await entry.apply(
      tx,
      user.id,
      mutation.entity_id,
      patchParsed.data,
    )
    if (applyResult !== 'applied') {
      return applyResult
    }

    // ---- 5. log INSERT (skipLog の op はスキップ) ----
    if (!entry.skipLog) {
      await tx
        .insert(entityMutations)
        .values({
          mutationId: mutation.mutation_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          userId: user.id,
          op: mutation.op,
          patch: mutation.patch,
          editedAt: new Date(mutation.edited_at),
          appliedAt: sql`now()`,
        })
        .onConflictDoNothing({ target: entityMutations.mutationId })
    }

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
        event: 'entity_mutations.bulk.mutation_failed',
        mutationId: mutation.mutation_id,
        entityType: mutation.entity_type,
        entityId: mutation.entity_id,
        userId: user.id,
        err: serializeDbError(err, { cardIds: [mutation.entity_id] }),
      })
      failed.push(mutation.mutation_id)
    }
  }

  return Response.json({ ok: true, applied, failed }, { status: 200 })
}
