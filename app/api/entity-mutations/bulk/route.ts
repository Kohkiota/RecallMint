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
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { entityMutations, type User } from '@/lib/db/schema'
import {
  ENTITY_MUTATION_REGISTRY,
  lookupRegistryEntry,
} from '@/lib/sync/server/entity-mutation-registry'
import {
  groupMutationsByEntityKey,
  assertSequentialPath,
} from '@/lib/sync/server/group-mutations-by-entity-key'
import {
  parsedMutationSchema,
  type ParsedMutation,
} from '@/lib/sync/shared/parsed-mutation'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { reportRlsContextFailure } from '@/lib/db/report-rls-context-failure'
import { logger } from '@/lib/logger'
import {
  classifyBulkError,
  BULK_TRANSIENT_RETRY_SEC,
} from '@/lib/retry/classify-bulk-error'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Payload validation (zod) — envelope のみ。 entity_type 別 patch 検証は registry。
// 単一 mutation の envelope schema (`parsedMutationSchema`) と派生型 (`ParsedMutation`)
// は `lib/sync/shared/parsed-mutation.ts` に分離 (Y-2 T-B3 #1b、 group helper から
// 共有するため)。 本 file は payload 全体 (= mutations 配列上限) のみ定義する。
// ---------------------------------------------------------------------------

// mutation_id 重複検出に使う zod issue code (envelope-level の `invalid_payload` と
// `duplicate_mutation_id` を caller 側で識別するための custom 文字列)。 並列化後は
// 異 group に分離された同 mutation_id が両方 applied になりうる race (R7) を入口で
// 殺すため、 envelope zod で 400 reject する設計 (step 0 doc §4.4)。
const DUPLICATE_MUTATION_ID_CODE = 'duplicate_mutation_id'

const payloadSchema = z
  .object({
    // 1 回の flush で 1000 件超は実用上ないため上限を設けて DoS 寄りの巨大 payload を弾く。
    mutations: z.array(parsedMutationSchema).max(1000),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>()
    for (const m of data.mutations) {
      if (seen.has(m.mutation_id)) {
        ctx.addIssue({
          code: 'custom',
          message: DUPLICATE_MUTATION_ID_CODE,
          path: ['mutations'],
        })
        return
      }
      seen.add(m.mutation_id)
    }
  })

// ---------------------------------------------------------------------------
// processMutation — 単一 mutation を per-mutation tx で apply + (skipLog でなければ)
// log INSERT する。
// ---------------------------------------------------------------------------

// RLS-P3: caller が per-mutation の withTenantTx(user.id, ...) で独立 tx (+ 冒頭
// setTenantContext) を張り、この関数はその tx を受け取る。per-mutation の commit/
// rollback 境界は caller の withTenantTx 1 呼び出し = 1 tx に一致し (group 並列も
// 温存)、tx handle は tx 終了後に保持されない (apply 層 = TenantTx 受領)。
async function processMutation(
  tx: TenantTx,
  user: User,
  mutation: ParsedMutation,
): Promise<'applied' | 'skipped' | 'failed'> {
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
    // mutation_id 重複は envelope zod の他 issue と切り分けて caller に伝える
    // (client 側で原因切り分け可能にするため、 専用 error code を返す)。
    const isDuplicate = parsed.error.issues.some(
      (issue) => issue.message === DUPLICATE_MUTATION_ID_CODE,
    )
    if (isDuplicate) {
      return Response.json(
        { error: 'duplicate_mutation_id' },
        { status: 400 },
      )
    }
    return Response.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  const { mutations } = parsed.data

  // -- per-mutation 処理 (envelope-level catch で transient/permanent を分岐) --
  // per-mutation 内部の throw は loop 内 catch が 200+failed[] で吸収するため、 ここの
  // 外側 try/catch が拾うのは「per-mutation に閉じない envelope-level 致命 error」
  // (loop 前の groupMutationsByEntityKey / 並列 orchestration 等の予期せぬ runtime error)。
  // RLS-P3 以降: getDb init 失敗は auth (getCurrentUser) で先に surface し (500)、 per-mutation
  // 中の connection 断は loop 内 catch が failed[] へ吸収する (client は pending 残置で再送) ため、
  // いずれも envelope には到達しない。
  // classifyBulkError で transient なら 503 + Retry-After、 permanent-4xx は 400 系
  // (caller は zod 既存経路で 400 を返しているため到達想定なし)、 unknown DB は
  // 503 default (silent lost write 回避、 spec §1.1 目的 3)。
  let applied = 0
  const failed: string[] = []
  try {
    // Y-2 T-B3 #1b: 順序保証付き選択並列化 (案 X)。
    // - `${entity_type}:${entity_id}` で group 化
    // - cascade-like 1 件でも検出 → 全体 serial fallback (= 現状経路を丸ごと再利用)
    // - cascade なし → group 間 `Promise.allSettled` で並列、 group 内は逐次
    // - 結果は mutation_id → result の Map に投入 → 入力順 iterate で集計を再構築
    //   (= response failed[] 順 + applied count は wire format 不変、 入力順)
    const { groups, serialFallback } = groupMutationsByEntityKey(
      mutations,
      ENTITY_MUTATION_REGISTRY,
    )

    if (serialFallback) {
      // cascade-like 検出: 現行 for-of 経路をそのまま使う (prod 実績ある経路丸ごと再利用)。
      for (const mutation of mutations) {
        try {
          // RLS-P3: per-mutation の独立 tx (+ 冒頭 setTenantContext) を withTenantTx で張る。
          const result = await withTenantTx(user.id, (tx) =>
            processMutation(tx, user, mutation),
          )
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
          // RLS-P3 Task 7: P0RLS なら台帳 + Discord へ loud alert (非 P0RLS は short-circuit・
          // 記録経路の throw は内部で握る = 200+failed[] 契約不変)。
          await reportRlsContextFailure(err, {
            route: 'entity-mutations/bulk',
            op: 'mutation',
          })
          failed.push(mutation.mutation_id)
        }
      }
    } else {
      // 非 cascade のみ: group 間並列。 各 group の per-mutation 結果は Map に投入し、
      // 後段で 入力順 iterate により response mutation_id 順を入力順に正規化する。
      const resultByMutationId = new Map<
        string,
        'applied' | 'skipped' | 'failed'
      >()
      // `Promise.allSettled` は「group 内 try/catch を抜ける runtime error が
      // 他 group を止めない」 ための safety net。 通常 path では各 group 内の
      // try/catch が per-mutation throw を吸い込むため rejected には到達しない。
      await Promise.allSettled(
        Array.from(groups.values()).map(async (group) => {
          // 外側 try: assertSequentialPath / logger / serializeDbError が万一 throw
          // した時の fail-silent (= Map に結果が入らず入力順 iterate で skipped と
          // 同視 = silent lost write) を構造的に塞ぐ。 step 0 §5 R8 不変性を mock
          // 検出可に格上げするための防御線で、 通常 path では発火しない。
          try {
            // 順序破壊 self-guard: 通常 path で group 内 for-of (serial mode) は no-op。
            // 将来の `Promise.all` 誤改造 (= 同一 key を並列で流す) を build/test 時に
            // throw で gate する dev-time invariant (helper test case 3 と一体)。
            assertSequentialPath(group, 'serial')
            for (const mutation of group) {
              try {
                // RLS-P3: per-mutation の独立 tx (+ 冒頭 setTenantContext) を withTenantTx で張る。
                const result = await withTenantTx(user.id, (tx) =>
                  processMutation(tx, user, mutation),
                )
                resultByMutationId.set(mutation.mutation_id, result)
              } catch (err) {
                logger.warn({
                  event: 'entity_mutations.bulk.mutation_failed',
                  mutationId: mutation.mutation_id,
                  entityType: mutation.entity_type,
                  entityId: mutation.entity_id,
                  userId: user.id,
                  err: serializeDbError(err, { cardIds: [mutation.entity_id] }),
                })
                // RLS-P3 Task 7: P0RLS なら台帳 + Discord へ loud alert (非 P0RLS は
                // short-circuit・記録経路の throw は内部で握る = 200+failed[] 契約不変)。
                await reportRlsContextFailure(err, {
                  route: 'entity-mutations/bulk',
                  op: 'mutation',
                })
                resultByMutationId.set(mutation.mutation_id, 'failed')
              }
            }
          } catch (err) {
            // group-level fatal: assertSequentialPath / logger / serializer の万一の
            // throw のみ到達。 当該 group 内全 mutation を failed に積み replay 余地を
            // 残す (= 入力順 iterate で failed[] に必ず出る、 silent skip を回避)。
            logger.warn({
              event: 'entity_mutations.bulk.group_failed',
              groupSize: group.length,
              userId: user.id,
              err: serializeDbError(err),
            })
            for (const m of group) {
              resultByMutationId.set(m.mutation_id, 'failed')
            }
          }
        }),
      )
      // 入力順で集計を再構築 (= response の failed[] / applied count を入力順に正規化)。
      // 'skipped' は applied / failed どちらにも入れない (冪等 skip、 既存挙動)。
      for (const mutation of mutations) {
        const result = resultByMutationId.get(mutation.mutation_id)
        if (result === 'applied') {
          applied++
        } else if (result === 'failed') {
          failed.push(mutation.mutation_id)
        }
      }
    }
  } catch (err) {
    // envelope-level 致命 error: classifyBulkError で 503 / 400 を分岐。
    logger.error({
      event: 'entity_mutations.bulk.envelope_failed',
      userId: user.id,
      err: serializeDbError(err),
    })
    // RLS-P3 Task 7: envelope へ P0RLS が漏れた場合の defense-in-depth alert
    // (非 P0RLS は short-circuit・記録経路の throw は内部で握る = 503/400 分岐不変)。
    await reportRlsContextFailure(err, {
      route: 'entity-mutations/bulk',
      op: 'mutation',
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
