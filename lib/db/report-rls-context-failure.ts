// P0RLS loud alert helper (RLS-P3 Task 7)。
//
// write-path の既存 catch site (entity-mutations/bulk・delete-exam・review-events/bulk)
// から呼び、catch した error が P0RLS (tenant context 未設定で app_current_user_id が
// RAISE = withTenantTx 未経由の bug) の時だけ integration_failures 台帳 + Discord へ
// 記録を残す。現状の「Vercel Logs 頼み」を「発生 = 記録が残る」へ格上げする。
//
// recordIntegrationFailure と分離した独立 module にするのは、unit test で
// recordIntegrationFailure を clean に mock して「正しい catalog key + PII 非搭載
// context で呼ばれる」ことを pin するため (同一 module 内 self-call は ESM live
// binding で spy が刺さらない)。

import { isP0RLS } from '@/lib/db/p0rls'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { logger } from '@/lib/logger'

// route / op は列挙定数 allowlist。自由文字列を禁止することで、alert context に
// userId / UUID / query 値等の PII が混入する経路を型で塞ぐ (context は route/op の
// enum 値のみ)。新しい write-path を配線する際はここに literal を追加する。
export type RlsAlertRoute =
  | 'entity-mutations/bulk'
  | 'delete-exam'
  | 'rename-exam'
  | 'review-events/bulk'
export type RlsAlertOp = 'mutation' | 'delete' | 'ingest' | 'update'

/**
 * catch した error が P0RLS なら integration_failures 台帳 + Discord へ記録する。
 *
 * - **非 P0RLS は即 return**: 通常の失敗経路 (大多数) は cheap short-circuit で何もしない
 *   (await するが同期的に return するため latency ゼロ)。
 * - **P0RLS は await して記録**: fire-and-forget は serverless で discard されるため
 *   await する。呼び出し元は既に失敗 (5xx / 200-failed / ActionResult error) を返す
 *   途中ゆえ、この記録 latency は許容される。
 * - **context は PII-free**: route / op の enum 値のみ (userId を渡さない・spec §153)。
 * - **inner try/catch で握る**: 本 helper は既存 catch の内側から呼ばれる。記録経路の
 *   throw (recordIntegrationFailure 内の notifyOps production misconfig fail-fast 等) が
 *   原例外を mask したり control flow を変えてはならないため、握って log するだけに留める。
 *   → 既存の HTTP status / 例外伝播 / log は不変 (alert は additive)。
 *
 * alert storm (regression 時に per-catch で多発) は「= 実障害の loud signal」として
 * 受容する (rate-limit は本 wave 対象外・記録のみ)。
 */
export async function reportRlsContextFailure(
  err: unknown,
  ctx: { route: RlsAlertRoute; op: RlsAlertOp },
): Promise<void> {
  // isP0RLS は err の .cause chain を walk する。通常の drizzle/postgres-js error は
  // acyclic + plain data ゆえ throw しないが、万一(循環 chain の stack overflow /
  // property getter の throw 等)でも本 helper が原例外を mask しないよう、判定自体も
  // 握って「P0RLS でない」扱いにする(never-throws 契約を practical でなく total にする)。
  let p0rls: boolean
  try {
    p0rls = isP0RLS(err)
  } catch {
    return
  }
  if (!p0rls) return

  try {
    await recordIntegrationFailure({
      key: 'rls_context_missing',
      subject: 'P0RLS: tenant context missing on write path',
      // PII 非搭載: enum 値のみ (userId / UUID / query 値を載せない)。
      context: { route: ctx.route, op: ctx.op },
    })
  } catch (reportErr) {
    // 記録経路の失敗は原例外を mask しない (握って log のみ・再 throw しない)。
    logger.error({
      event: 'rls.context_missing.report_failed',
      route: ctx.route,
      op: ctx.op,
      err: reportErr instanceof Error ? reportErr.message : String(reportErr),
    })
  }
}
