// 画像 GC v2 reconciler(Task G5)— CLI wrapper。DI core(runReconciler)と
// production deps 束縛(buildReconcilerDeps)は lib/storage/asset-gc.ts に移設済み
// (Task 2: core 移設 + deps の executor/bounded 注入化)。本 file は CLI 固有
// (引数 parse・owner 接続の bind・R2 module の dynamic import 分岐・process 終了
// コード)だけを持つ薄い wrapper。
//
// core の不変条件(PREREQUISITE / decouple 順序 / 状態機械 SSoT / dry-run write
// ゼロ)は lib/storage/asset-gc.ts の冒頭コメントが正本。
//
// 実行(`--conditions=react-server` は必須フラグ — 下記注記参照):
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts                        # mark のみ(orphaned_at set/clear)
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep                # mark + promote + collect(本回収)
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --dry-run      # 一切 write せず予告集計のみ
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --user <id>    # 対象 user 限定(stg 検証)
//   pnpm tsx --conditions=react-server scripts/gc-image-assets.ts --sweep --grace-days N # grace 上書き(既定 30)
//   (--user は値必須。値なし / 別 flag が続くと fail-fast で exit 1 — 全 user 誤爆防止)
//
// `--conditions=react-server` は必須(seed-perf-exam.ts / backfill-card-asset-refs.ts
// と同様)。本 script は getAdminDb()(@/lib/db)・recordIntegrationFailure(→ @/lib/db)を
// 経由して DB に接続し、@/lib/storage/r2 も含めいずれも `import 'server-only'` を
// 持つため、tsx をそのまま実行すると runtime guard で throw する。このフラグで
// server-only package が empty.js(no-op)に解決され script が正常起動する
// (vitest.config.ts の server-only alias stub と同原理)。
//
// 前提(spec §4.11-5): backfill(scripts/backfill-card-asset-refs.ts)完了後の環境
// でのみ走らせる。詳細は lib/storage/asset-gc.ts の PREREQUISITE コメント参照。
//
// prod 誤爆ガード: production 環境で --grace-days が既定(30)未満は reject(exit 1)。
// in-flight / offline-pending mutation の全収を防ぐ(parseGraceDays 参照)。
//
// production 実行は OT が手動(env を対象環境用に切替えた上で本 script を実行)。

import { getAdminDb } from '@/lib/db'
import {
  runReconciler,
  buildReconcilerDeps,
  DEFAULT_GRACE_DAYS,
  type ReconcilerDeps,
} from '@/lib/storage/asset-gc'

// ---------------------------------------------------------------------------
// CLI arg parsing(pure・testable)
// ---------------------------------------------------------------------------
/**
 * `--user` は必ず非 flag の値を伴う(footgun 防止・backfill script parseUserFlag と
 * 同契約)。値欠落 / 別 flag が続く場合は fail-fast で throw(main が exit 1 に変換)。
 * `--user` 無し = 全 user 対象(意図的、許容)。
 */
export function parseUserFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--user')
  if (idx === -1) return undefined
  const next = argv[idx + 1]
  if (!next || next.startsWith('-')) {
    throw new Error('--user requires a userId value (e.g. --user <userId>)')
  }
  return next
}

/**
 * `--grace-days N` を解釈する(既定 DEFAULT_GRACE_DAYS)。値欠落 / 非数値 / 負数は
 * fail-fast で throw。**prod ガード**: production 環境(VERCEL_ENV or NODE_ENV が
 * 'production')で既定未満の grace を指定したら reject する(in-flight /
 * offline-pending mutation の全収を防ぐ)。
 */
export function parseGraceDays(
  argv: string[],
  env: { VERCEL_ENV?: string; NODE_ENV?: string },
): number {
  const idx = argv.indexOf('--grace-days')
  if (idx === -1) return DEFAULT_GRACE_DAYS
  const raw = argv[idx + 1]
  if (!raw || raw.startsWith('-')) {
    throw new Error('--grace-days requires a non-negative integer value')
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--grace-days must be a non-negative integer (got: ${raw})`)
  }
  const isProd =
    env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production'
  if (isProd && n < DEFAULT_GRACE_DAYS) {
    throw new Error(
      `production guard: --grace-days ${n} < ${DEFAULT_GRACE_DAYS} rejected ` +
        `(prevents sweeping in-flight/offline-pending mutations)`,
    )
  }
  return n
}

// CLI entry: production deps(owner 接続)を束縛して runReconciler を呼ぶ。test
// import 経路では走らないよう process.argv[1] guard(backfill script 踏襲)。
async function main(): Promise<void> {
  const argv = process.argv
  const sweep = argv.includes('--sweep')
  const dryRun = argv.includes('--dry-run')
  const userId = parseUserFlag(argv)
  const graceDays = parseGraceDays(argv, {
    VERCEL_ENV: process.env.VERCEL_ENV,
    NODE_ENV: process.env.NODE_ENV,
  })

  // R2 実削除は sweep-collect の本実行(sweep && !dryRun)でのみ起きる。この経路の
  // ときだけ @/lib/storage/r2 を dynamic import する(module-eval の R2 env fail-fast
  // を実削除しない run に持ち込まない)。それ以外は「呼ばれたら throw する」stub を
  // 注入する — mark-only / dry-run では core が deleteObject を一切呼ばない設計ゆえ、
  // この stub は決して発火しない(万一の配線ミスは loud に露見する)。
  const willDeleteFromR2 = sweep && !dryRun
  const deleteObject: ReconcilerDeps['deleteObject'] = willDeleteFromR2
    ? (await import('@/lib/storage/r2')).deleteObject
    : async () => {
        throw new Error(
          'deleteObject invoked on a non-collect run (mark-only/dry-run) — ' +
            'r2 module intentionally not loaded; this indicates a wiring bug',
        )
      }

  // owner 経路: exec は接続を直接渡すだけ(tx を張らない・CLI は RLS 対象外の owner
  // role で動く)。app 経路(cron lane・Task 5)は withTenantTx(userId, fn) を使う
  // (lib/storage/asset-gc.ts の ReconcilerExec 参照)。collectLimit は渡さない
  // (省略 = 無制限・現行挙動を維持)。
  const deps = buildReconcilerDeps({
    exec: (fn) => fn(getAdminDb()),
    userId,
    deleteObject,
    log: (msg) => console.log(`[gc-image-assets] ${msg}`),
  })

  await runReconciler({ sweep, dryRun, graceDays, userId }, deps)
}

// process.argv[1] が本 file のとき = CLI 起動。test import 時は走らない。
if (process.argv[1]?.endsWith('gc-image-assets.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[gc-image-assets] fatal:', err)
      process.exit(1)
    })
}
