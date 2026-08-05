// ②-4a T14a fix round 2(Codex residual・spec §11): manual operator-run sweep
// lane for ABANDONED `upload_operations`.
//
// なぜ必要か: 新経路には resume が無く、lease を持たない非終端 op を進める主体が
// 存在しない。 lease 失効後の回収経路は ① reconcileStaleProcessing(対応する
// source_document が stale processing のときだけ発火)② 次 submit の supersede
// (ユーザーが再度 upload したときだけ発火)③ exam 削除の cascade の 3 つで、
// いずれも「誰かが何かをする」ことが前提。 一度も戻ってこないユーザーの放置 op は
// 非終端のまま残り、`prepared_payload`(カード本文 = PII を含みうる)が保持され
// 続ける — それを無条件に掃くのがこの script の存在意義。
//
// **②-4a S-4(2026-08-05)で対象範囲が広がった**: 共有述語
// `isLiveUploadOperationCondition` から 7 日 window(created_at 基準)が外れ、
// live = 「非終端 かつ valid lease」だけになった。 ゆえに本 sweep の候補は
// 「非終端 かつ valid lease を持たない」全行 = **年齢を問わない**。
//
// 本 script は `scripts/gc-image-assets.ts` の model(DI core + production
// deps 束縛 + `--dry-run` 既定安全 + `--user` scope + loud PII-free logging)を
// 踏襲する。 破壊操作だが「非終端→terminal_failed + payload NULL」のみで
// R2/行 DELETE は一切行わない(画像 GC v2 とは独立した、より軽い sweep)。
//
// 実行(`--conditions=react-server` は必須フラグ — gc-image-assets.ts と同じ
// 理由: @/lib/db 経由の getAdminDb() が import 'server-only' を持つ):
//   pnpm tsx --conditions=react-server scripts/gc-abandoned-operations.ts --dry-run           # 予告のみ・write ゼロ
//   pnpm tsx --conditions=react-server scripts/gc-abandoned-operations.ts                      # 本実行(terminal_failed + payload NULL)
//   pnpm tsx --conditions=react-server scripts/gc-abandoned-operations.ts --user <id>          # 対象 user 限定(stg 検証)
//   pnpm tsx --conditions=react-server scripts/gc-abandoned-operations.ts --user <id> --dry-run
//
// NO cron / auto-scheduling(spec 指示どおり手動運用。gc-image-assets.ts と同型)。
//
// fencing: candidate 選定と実際の UPDATE の両方が同じ述語
// (`isLiveUploadOperationCondition` の否定 + 非終端 status)を WHERE に持つ
// (select→update の間の TOCTOU を再チェックで閉じる — select 時点の判定を
// 信用しない。 reconcileStaleProcessing と同じ fencing 規律)。 0 行更新
// (= その間に新しい submit が走って live 化した)は静かに skip し、
// terminated count に数えない。
//
// PII-free logging: ログには operationId のみを出す(prepared_payload の中身
// = カード本文は一切出力しない)。

import { and, eq, inArray, not } from 'drizzle-orm'
import { getAdminDb } from '@/lib/db'
import { uploadOperations } from '@/lib/db/schema'
import {
  NON_TERMINAL_UPLOAD_OPERATION_STATUSES,
  isLiveUploadOperationCondition,
} from '@/lib/exams/source-doc-status'

// fix round 3(Codex + canonical Critical): `db` is typed via `Pick<..., 'select'
// | 'update'>` — drizzle's `select`/`update`/`insert`/`execute` are NOT
// dependent on the `TSchema` generic parameter (same rationale already
// documented at `tests/integration/pg/setup/fixture.ts`'s `seedTenant`), so
// both `getAdminDb()` (production, schema-typed) and the iso test harness's
// `getFixtureOwnerDb()` (schema-less owner connection to the real test DB)
// satisfy this type structurally. This lets the real-PG iso test exercise the
// ACTUAL query this script runs in production — including the exact
// `isLiveUploadOperationCondition()` SQL predicate — rather than a re-typed
// duplicate (`getAdminDb()` itself can't be used in the iso suite: it
// requires `DATABASE_URL_ADMIN`, which the iso harness doesn't set — only
// `DATABASE_URL_APP`, via `hardSetTestDatabaseUrl()`).
type SweepDb = Pick<ReturnType<typeof getAdminDb>, 'select' | 'update'>

export type AbandonedOpCandidate = {
  id: string
  userId: string
  status: string
  createdAt: Date
}

export type AbandonedOpsSweepOptions = {
  dryRun: boolean
  userId?: string
}

export type AbandonedOpsSweepDeps = {
  // 候補取得: 非終端 かつ isLiveUploadOperationCondition を満たさない
  // (= S-4 以降は「有効 lease を持たない」= 年齢を問わない)行。
  fetchCandidates: () => Promise<AbandonedOpCandidate[]>
  // fenced terminal 化。 candidate 選定と同じ述語を WHERE に再適用する CAS —
  // select〜update の間に状態が変わった行(reconciler / supersede が先に
  // terminal 化した等)は 0 行更新(false)で skip する(次の run が再評価する)。
  terminate: (id: string, userId: string) => Promise<boolean>
  log: (msg: string) => void
}

export type AbandonedOpsSweepSummary = {
  scanned: number
  terminated: number
  // dry-run では「これから terminal_failed になる予定」の id、本実行では
  // 「実際に terminal_failed にした」id(terminate が 0 行更新だった分は含まない)。
  ids: string[]
}

export async function runAbandonedOperationsSweep(
  opts: AbandonedOpsSweepOptions,
  deps: AbandonedOpsSweepDeps,
): Promise<AbandonedOpsSweepSummary> {
  const candidates = await deps.fetchCandidates()

  if (opts.dryRun) {
    const ids = candidates.map((c) => c.id)
    deps.log(
      `[dry-run] would terminate ${candidates.length} abandoned operation(s)` +
        (ids.length > 0 ? `: ${ids.join(', ')}` : ''),
    )
    return { scanned: candidates.length, terminated: 0, ids }
  }

  const terminatedIds: string[] = []
  for (const c of candidates) {
    const ok = await deps.terminate(c.id, c.userId)
    if (ok) terminatedIds.push(c.id)
  }
  deps.log(
    `terminated ${terminatedIds.length}/${candidates.length} abandoned operation(s)` +
      (terminatedIds.length > 0 ? `: ${terminatedIds.join(', ')}` : ''),
  )
  return { scanned: candidates.length, terminated: terminatedIds.length, ids: terminatedIds }
}

// ---------------------------------------------------------------------------
// CLI arg parsing(pure・testable)。 `--user` の契約は gc-image-assets.ts /
// backfill-card-asset-refs.ts の parseUserFlag と同一(意図的な重複 — 3 script
// 目だが CLI arg parsing は 5 行の純関数で共有モジュール化の価値が薄いため、
// 既存 script 群と同じ判断で複製する)。
// ---------------------------------------------------------------------------
export function parseUserFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--user')
  if (idx === -1) return undefined
  const next = argv[idx + 1]
  if (!next || next.startsWith('-')) {
    throw new Error('--user requires a userId value (e.g. --user <userId>)')
  }
  return next
}

// ---------------------------------------------------------------------------
// production deps 束縛(export = real-PG iso test が同じクエリを直接叩ける
// ようにするため・fix round 3)。 `db` を注入可能にする以外は挙動不変。
// ---------------------------------------------------------------------------
export function buildProductionDeps(db: SweepDb, userId: string | undefined): AbandonedOpsSweepDeps {
  return {
    fetchCandidates: async () => {
      const rows = await db
        .select({
          id: uploadOperations.id,
          userId: uploadOperations.userId,
          status: uploadOperations.status,
          createdAt: uploadOperations.createdAt,
        })
        .from(uploadOperations)
        .where(
          and(
            inArray(uploadOperations.status, [
              ...NON_TERMINAL_UPLOAD_OPERATION_STATUSES,
            ]),
            not(isLiveUploadOperationCondition()),
            userId ? eq(uploadOperations.userId, userId) : undefined,
          ),
        )
      return rows
    },
    terminate: async (id, uid) => {
      const rows = await db
        .update(uploadOperations)
        .set({
          status: 'terminal_failed',
          preparedPayload: null,
          lastErrorCode: 'abandoned_retention_exceeded',
          resultSummary: { reason: 'abandoned_retention_exceeded' },
        })
        .where(
          and(
            eq(uploadOperations.id, id),
            eq(uploadOperations.userId, uid),
            // fenced CAS: candidate 選定と同じ述語を再適用(select〜update の
            // 間に状態が変わった行を上書きしない)。
            inArray(uploadOperations.status, [
              ...NON_TERMINAL_UPLOAD_OPERATION_STATUSES,
            ]),
            not(isLiveUploadOperationCondition()),
          ),
        )
        .returning({ id: uploadOperations.id })
      return rows.length > 0
    },
    log: (msg) => console.log(`[gc-abandoned-operations] ${msg}`),
  }
}

async function main(): Promise<void> {
  const argv = process.argv
  const dryRun = argv.includes('--dry-run')
  const userId = parseUserFlag(argv)

  const db = getAdminDb()

  await runAbandonedOperationsSweep({ dryRun, userId }, buildProductionDeps(db, userId))
}

// process.argv[1] が本 file のとき = CLI 起動。test import 時は走らない
// (gc-image-assets.ts / backfill-card-asset-refs.ts と同じ guard)。
if (process.argv[1]?.endsWith('gc-abandoned-operations.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[gc-abandoned-operations] fatal:', err)
      process.exit(1)
    })
}
