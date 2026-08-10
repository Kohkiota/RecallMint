import { and, eq } from 'drizzle-orm'

import { uploadOperations } from '@/lib/db/schema'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { isLiveUploadOperationCondition } from '@/lib/exams/source-doc-status'

/**
 * その user が live な upload_operation(非終端 かつ valid lease)を 1 件でも持つか。
 *
 * `hasLiveUploadOperation`(lib/exams/source-doc-status.ts)を再利用しない: あちらは
 * UI guard の best-effort で、DB エラーを握って **false(= live でない)** を返す。
 * sweeper がそれを信じると「判定不能なので消す」に倒れ、不変条件 3 の fail-safe が
 * 裏返る。ここでは throw をそのまま呼出側へ返し、呼出側が skip に倒す。
 *
 * ただし fail-safe が覆うのは **throw** であって「無言で 0 行」ではない: RLS の
 * tenant context が意図と違う値で張られる等で読み取りが静かに空になると `false` =
 * 削除側へ倒れる。極性が「行が返ること」に依存している事実は backstop(cutoff 6h =
 * lease TTL の 24 倍・§3.3)に頼っており、判定そのものでは守っていない。
 *
 * RLS 下でも `user_id` 条件は query 側にも明示する(CLAUDE.md 絶対ルール)。
 */
export async function hasLiveUploadOperationForSweep(userId: string): Promise<boolean> {
  const rows = await withTenantTx(userId, (tx) =>
    tx
      .select({ id: uploadOperations.id })
      .from(uploadOperations)
      .where(and(eq(uploadOperations.userId, userId), isLiveUploadOperationCondition()))
      .limit(1),
  )
  return rows.length > 0
}
