// POST /api/card-mutations/bulk — Task 1.2/1.3 (local-first 書込化)。
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
// op 対応状況 (Task 1.3 で全 op 実装完了):
// - update_field: buildSetClause(field, value) + applyCardFieldUpdate
// - delete: applyCardDelete (log INSERT なし、上記理由)
// - create: applyCardCreateWithId (client 生成 cardId を PK に INSERT ON CONFLICT DO NOTHING)
//
// 部分失敗ポリシ:
// - 各 mutation は独立した tx で処理し、 failed[] に積んで 200 返却。
//   review-events/bulk と異なり 1 tx 全体は wrap しない
//   (mutation 間に依存がなく、 per-mutation tx が設計上自然)。
// - orphan card (他 user / 不在) → その mutation を failed[]、 他は継続。
// - 予期せぬ throw → serializeDbError で log、 その mutation を failed[]。
//
// per-op patch 検証:
// - envelope 構造不正 (mutation_id 非 UUID 等) → 400 全体 reject (従来通り)。
// - op 別 patch 不正 (create で必須フィールド欠如等) → per-mutation failed[]。
//   理由: 1 件の patch 不正で batch 全体を落とさない (review-events と同じ部分失敗思想)。
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
  applyCardCreateWithId,
  type UpdateCardFieldName,
} from '@/lib/cards/apply-card-mutation'
import { optionSchema } from '@/lib/validation/card'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Payload validation (zod)
// ---------------------------------------------------------------------------

// zod v4 記法: z.uuid() / z.iso.datetime() / z.enum([...]) を使う
// (review-events/bulk route 踏襲)。
//
// per-op patch 検証 (Task 1.3):
// - envelope 構造不正 → 400 (payloadSchema 全体 reject)
// - op 別 patch 不正 → per-mutation failed[] (batch 全体を落とさない部分失敗思想)
// - discriminatedUnion で op 別型安全を担保しつつ、
//   patch 不正は per-mutation 分岐 (processMutation 内 safeParse) で吸収する。

// update_field の patch: { field: UpdateCardFieldName, value: unknown }
const updateFieldPatchSchema = z.object({
  field: z.enum([
    'title',
    'sort_key',
    'question_text',
    'explanation_text',
    'memo',
    'options',
  ]),
  value: z.unknown(),
})

// TODO(follow-up): per-field schema を lib/validation/card-fields.ts 等に抽出し buildSetClause と共有 (現状は制約リテラルが二重定義で drift リスク)
// create の patch: client が optimistic に組んだ card 内容
// correct_answer_ids は含めない (server が options.is_correct から再生成)
const createPatchSchema = z.object({
  exam_id: z.uuid(),
  title: z
    .string()
    .trim()
    .min(1, 'タイトルは必須です')
    .max(200, 'タイトルは 200 文字以内で入力してください'),
  sort_key: z.string().max(100, 'ソートキーは 100 文字以内で入力してください').nullable(),
  question_text: z
    .string()
    .max(10000, '問題文は 10000 文字以内で入力してください')
    .refine((s) => s.trim().length > 0, { message: '問題文は必須です' }),
  options: z
    .array(optionSchema)
    .min(1, '選択肢は最低 1 個必要です')
    .max(50, '選択肢は最大 50 個までです')
    .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, {
      message: '選択肢の id が重複しています',
    }),
  explanation_text: z
    .string()
    .max(10000, '解説は 10000 文字以内で入力してください')
    .nullable(),
  memo: z.string().max(10000, 'メモは 10000 文字以内で入力してください').nullable(),
})

// delete の patch: 不要 (空 object 許容)
const deletePatchSchema = z.record(z.string(), z.unknown())

// envelope schema: patch は loose (object であること) だけ envelope レベルで検証。
// op 別の詳細 patch 検証は processMutation 内で per-mutation safeParse する。
// これにより 1 件の patch 不正で batch 全体を 400 reject しない。
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
// emptyToNull: nullable text 列の '' → null 正規化 helper。
// buildSetClause (UPDATE path) と同じ正規化を create path にも適用し、
// sort_key / explanation_text / memo の create/update 書込挙動を一致させる。
// ---------------------------------------------------------------------------
const emptyToNull = (v: string | null | undefined): string | null =>
  v === '' ? null : (v ?? null)

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
    // patch 検証: delete は patch 不要のため deletePatchSchema (loose object) で通す。
    // ------------------------------------------------------------------
    if (mutation.op === 'delete') {
      const patchParsed = deletePatchSchema.safeParse(mutation.patch)
      if (!patchParsed.success) {
        // patch が object でない場合 (envelope レベルで弾かれるはずだが防御)
        return 'failed'
      }
      await applyCardDelete(tx, mutation.card_id, user.id)
      return 'applied'
    }

    // ------------------------------------------------------------------
    // create op: per-op patch 検証 → 冪等チェック → applyCardCreateWithId → log INSERT
    // ------------------------------------------------------------------
    if (mutation.op === 'create') {
      // per-op patch 検証 (不正 patch は per-mutation failed — batch 全体を落とさない)
      const patchParsed = createPatchSchema.safeParse(mutation.patch)
      if (!patchParsed.success) {
        return 'failed'
      }
      const p = patchParsed.data

      // 冪等チェック: 同 mutation_id が既存なら skip
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
        return 'skipped'
      }

      // options: camelCase (zod) → snake_case (CardOption)
      const cardOptions = p.options.map((o) => ({
        id: o.id,
        text: o.text,
        is_correct: o.isCorrect,
        ...(o.explanation ? { explanation: o.explanation } : {}),
      }))

      const createResult = await applyCardCreateWithId(tx, user.id, {
        cardId: mutation.card_id,
        examId: p.exam_id,
        title: p.title,
        // buildSetClause (UPDATE path) と同じ正規化: '' → null。
        // client が '' を送ると create と update で挙動が乖離するため揃える。
        sortKey: emptyToNull(p.sort_key),
        questionText: p.question_text,
        options: cardOptions,
        explanationText: emptyToNull(p.explanation_text),
        memo: emptyToNull(p.memo),
      })

      if (createResult.examNotFound) {
        // exam 不在 / owner mismatch → failed
        return 'failed'
      }

      // card は exists (実 insert or ON CONFLICT skip 両方で card 行が存在)
      // → log INSERT に進む (FK 制約を満たす)。
      // create op の log も update_field と同じく onConflictDoNothing で書く
      // (別 mutation_id で同 card を作り直した場合の race backstop)。
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
    }

    // ------------------------------------------------------------------
    // update_field: per-op patch 検証 → 冪等チェック → apply → log INSERT
    // ------------------------------------------------------------------

    // per-op patch 検証 (不正 patch は per-mutation failed — batch 全体を落とさない)
    const patchParsed = updateFieldPatchSchema.safeParse(mutation.patch)
    if (!patchParsed.success) {
      return 'failed'
    }

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

    // buildSetClause は必ず通す (correct_answer_ids 再生成 / validation のため)。
    const { field, value } = patchParsed.data
    const clauseResult = buildSetClause(field as UpdateCardFieldName, value)
    if (!clauseResult.ok) {
      // buildSetClause の validation 失敗 (値の内容不正)
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
