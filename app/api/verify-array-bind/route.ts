// THROWAWAY (Y-2 T-B2 Step 0): postgres-js + Supabase Transaction pooler
// (prepare:false) で date 配列 bind が通る形を実機で叩いて確認するための一時
// 経路。 Step 0 結果を session log に貼付後、 別 commit で削除する (= 本実装
// 着手前の前段検証専用、 stg/preview のみ稼働 production は 404)。
//
// gate: VERCEL_ENV === 'production' で 404、 stg / preview / dev は通過。
// auth: getCurrentUser で 401 防御 (test user account token 必須)。
//
// 候補 X (claude.ai 推奨形): sql.join + ${d}::date 個別展開 + IN
//   → 各 ${d} は string (YYYY-MM-DD)、 postgres-js が serialize 可能、
//     ::date を SQL 側で明示。 配列を 1 param で渡す経路を踏まないので
//     T-B2 で観測された Buffer.byteLength(Array) TypeError を回避できる
//     仮説。
//
// 候補 Y (claude.ai 予測 ✗): 式 inArray (= inArray(sql`...`, days))
//   → drizzle bindIfParam が「式 (SQL 式) に対する inArray」 では
//     isDriverValueEncoder が false ゆえ型エンコーダを付けず value を生で
//     postgres-js に渡す = T-B2 と同じ機序で TypeError と予測、 念のため
//     実機挙動確認。
//
// reviews が空でも SELECT 自体は valid で 0 件返るため seed 不要 (=
// serialize 通過の確認は反映行数に依存しない)。

import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { reviews } from '@/lib/db/schema'

export const runtime = 'nodejs'

type Candidate =
  | { ok: true; rowCount: number; rows: unknown[] }
  | { ok: false; error: string; cause: string | null; code: string | null }

function captureError(e: unknown): Candidate {
  const err = e as { message?: string; cause?: unknown; code?: string }
  return {
    ok: false,
    error: String(err.message ?? e),
    cause: err.cause ? String(err.cause) : null,
    code: err.code ?? null,
  }
}

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV === 'production') {
    return new Response('Not found', { status: 404 })
  }
  const user = await getCurrentUser()
  if (!user) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // 2 要素 date 配列の fixture。 SELECT は server-side で reviews を集計、
  // test user の reviews が 0 でも 0 件返るだけで serialize 段の通過判定可。
  const days = ['2026-06-13', '2026-06-12']
  const db = getDb()

  // 候補 X: sql.join + 個別 param 展開 + IN
  let candidateX: Candidate
  try {
    const dayParams = sql.join(
      days.map((d) => sql`${d}::date`),
      sql`, `,
    )
    const rows = await db.execute(sql`
      SELECT (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text AS day,
             COUNT(DISTINCT card_id)::int AS distinct_count
      FROM reviews
      WHERE user_id = ${user.id}::uuid
        AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date IN (${dayParams})
      GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date
    `)
    const arr = rows as unknown as Array<unknown>
    candidateX = { ok: true, rowCount: arr.length, rows: arr.slice(0, 3) }
  } catch (e: unknown) {
    candidateX = captureError(e)
  }

  // 候補 Y: 式 inArray
  let candidateY: Candidate
  try {
    const rows = await db
      .select({
        day: sql<string>`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text`,
        distinct_count: sql<number>`COUNT(DISTINCT card_id)::int`,
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.userId, user.id),
          inArray(sql`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date`, days),
        ),
      )
      .groupBy(sql`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date`)
    candidateY = { ok: true, rowCount: rows.length, rows: rows.slice(0, 3) }
  } catch (e: unknown) {
    candidateY = captureError(e)
  }

  return Response.json({
    purpose: 'Y-2 T-B2 Step 0 — postgres-js array bind 実機検証 (throwaway)',
    days,
    env: process.env.VERCEL_ENV ?? 'unknown',
    candidateX_sqlJoinIn: candidateX,
    candidateY_exprInArray: candidateY,
  })
}
