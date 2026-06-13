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
import {
  parsedMutationSchema,
  type ParsedMutation,
} from '@/lib/sync/shared/parsed-mutation'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { logger } from '@/lib/logger'
import {
  classifyBulkError,
  BULK_TRANSIENT_RETRY_SEC,
} from '@/lib/transient/classify-bulk-error'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Payload validation (zod) — envelope のみ。 entity_type 別 patch 検証は registry。
// 単一 mutation の envelope schema (`parsedMutationSchema`) と派生型 (`ParsedMutation`)
// は `lib/sync/shared/parsed-mutation.ts` に分離 (Y-2 T-B3 #1b、 group helper から
// 共有するため)。 本 file は payload 全体 (= mutations 配列上限) のみ定義する。
// ---------------------------------------------------------------------------

const payloadSchema = z.object({
  // 1 回の flush で 1000 件超は実用上ないため上限を設けて DoS 寄りの巨大 payload を弾く。
  mutations: z.array(parsedMutationSchema).max(1000),
})

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

  // -- per-mutation 処理 (envelope-level catch で transient/permanent を分岐) --
  // per-mutation 内部の throw は loop 内 catch が 200+failed[] で吸収するため、 ここの
  // 外側 try/catch が拾うのは「per-mutation に閉じない envelope-level 致命 error」
  // (getDb 失敗 / connection 全断 / 予期せぬ runtime error 等)。
  // classifyBulkError で transient なら 503 + Retry-After、 permanent-4xx は 400 系
  // (caller は zod 既存経路で 400 を返しているため到達想定なし)、 unknown DB は
  // 503 default (silent lost write 回避、 spec §1.1 目的 3)。
  let applied = 0
  const failed: string[] = []
  try {
    const db = getDb()

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
  } catch (err) {
    // envelope-level 致命 error: classifyBulkError で 503 / 400 を分岐。
    logger.error({
      event: 'entity_mutations.bulk.envelope_failed',
      userId: user.id,
      err: serializeDbError(err),
    })
    const cls = classifyBulkError(err)
    if (cls === 'permanent-4xx') {
      return Response.json({ error: 'invalid_payload' }, { status: 400 })
    }
    // transient + permanent-other は両方 503 (unknown DB default = transient、
    // spec §1.1 目的 3)。 client retry controller (lib/retry/transient-error.ts) が
    // /\b503\b/ で transient 判定 → backoff retry。
    return Response.json(
      { error: 'transient_unavailable' },
      {
        status: 503,
        headers: { 'Retry-After': String(BULK_TRANSIENT_RETRY_SEC) },
      },
    )
  }

  return Response.json({ ok: true, applied, failed }, { status: 200 })
}
