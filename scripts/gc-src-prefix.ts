// R2 上の旧経路 source object (`users/{uid}/src/...`) を DB を一切参照せず R2
// listing だけを起点に列挙・削除する one-shot script(②-4a S-5a・S-5 の
// 「stg R2 users/*/src/ prefix 一掃」部分を切り出した先行 task。旧経路の file 削除 /
// migration 0032 / schema 変更は本 script のスコープ外 = 後続 S-5b の担当)。
//
// なぜ DB 起点でないか: 旧経路の source 台帳(表)と、それを起点にした行駆動の GC
// lane は S-5b で撤去済み。台帳が消えたあとは **R2 側の listing だけが残骸の唯一の
// 所在**になるため、この script は DB を一切見ない。
//
// 実行(`--conditions=react-server` は必須フラグ — lib/storage/r2.ts が
// `import 'server-only'` を持つため。gc-image-assets.ts / gc-abandoned-operations.ts
// と同じ理由。`DOTENV_CONFIG_PATH=.env.local` は本 script が読む `import 'dotenv/config'`
// (seed-perf-exam.ts と同型)に読込先を指定するため必須 — dotenv の既定読込先は `.env`
// で `.env.local` ではなく、無指定だと env 未注入のまま r2.ts の fail-fast(`R2_ACCOUNT_ID
// is not set`)に落ちる):
//   DOTENV_CONFIG_PATH=.env.local pnpm tsx --conditions=react-server scripts/gc-src-prefix.ts               # 既定 = dry-run(削除ゼロ・listing + 集計のみ)
//   DOTENV_CONFIG_PATH=.env.local pnpm tsx --conditions=react-server scripts/gc-src-prefix.ts --execute     # 本実行(削除する)
//   DOTENV_CONFIG_PATH=.env.local pnpm tsx --conditions=react-server scripts/gc-src-prefix.ts --user <uuid> # 対象を 1 user の src/ 配下に限定
//   DOTENV_CONFIG_PATH=.env.local pnpm tsx --conditions=react-server scripts/gc-src-prefix.ts --execute --user <uuid>
//
// 既定を dry-run にする(gc-image-assets.ts / gc-abandoned-operations.ts とは逆の
// 既定): 他 2 script は無指定でも mark-only / 何も terminate しない、のような弱い
// 非破壊 既定動作を持つが、本 script の唯一の動作は「削除」でそれに相当する非破壊
// 既定が無い。ゆえに既定を安全側(dry-run)に倒し、削除には明示 `--execute` を
// 要求する(brief 指定)。
//
// 実効境界(既知の制約・script では判別不能): 環境(stg/prod)の取り違えは検出でき
// ない。実効境界 = env 目視(実行前に `.env.local` の R2_* を確認)+ `--user` scope +
// dry-run 先行、の 3 点のみ。
//
// `integration_failures` への記録は行わない: 本 script は OT 手動実行の one-shot
// であり、台帳は「調査を要する異常」用。DB にも一切触らない(R2 のみを見る)。

import 'dotenv/config'

import { listObjects, deleteObject } from '@/lib/storage/r2'

// 削除対象の厳密 regex(listing の prefix 引数だけに頼らない二重の関門・brief §②)。
// userId は uuid(既存 key 形: source = `users/{uid}/src/...` / crop・添付 asset は
// `users/{uid}/{assetId}.webp` — 後者を誤って拾わないよう `src/` セグメントまで
// 固定する)。
// **この uuid は Clerk ID(`user_...`)ではなく `users` 表の内部 uuid**(Codex fix
// round 2・false positive 裁定): key を組む `user.id` は `users.$inferSelect`
// (`uuid('id').primaryKey()`)由来。同じ値が `withTenantTx(userId, …)` の tenant
// context(`app_current_user_id()` が uuid として比較する)にも渡っており、Clerk 形式
// なら uuid cast error になるため、この形以外の key は生まれえない。
export const SRC_KEY_PATTERN = /^users\/[0-9a-f-]{36}\/src\//

export type GcSrcPrefixSummary = {
  listed: number
  matched: number
  skipped: number
  deleted: number
  failed: number
}

export type GcSrcPrefixOptions = {
  execute: boolean
  userId?: string
}

// listing prefix: --user 指定時はその user の src/ 配下に絞った exact prefix
// (listing 量を減らせる)。無指定時は R2 の ListObjectsV2 が wildcard prefix を
// 持たないため `users/` 全体を listing し、per-key の SRC_KEY_PATTERN 照合だけで
// 絞り込む(全 user 一括 run は matched/skipped が同じ listing 中に混在する)。
export function listingPrefix(userId: string | undefined): string {
  return userId ? `users/${userId}/src/` : 'users/'
}

export async function runGcSrcPrefix(opts: GcSrcPrefixOptions): Promise<GcSrcPrefixSummary> {
  const summary: GcSrcPrefixSummary = { listed: 0, matched: 0, skipped: 0, deleted: 0, failed: 0 }
  const prefix = listingPrefix(opts.userId)

  const keys = await listObjects(prefix)
  summary.listed = keys.length

  const matchedKeys: string[] = []
  for (const key of keys) {
    if (SRC_KEY_PATTERN.test(key)) {
      matchedKeys.push(key)
      summary.matched++
      // brief §③出力: 対象 key を 1 行 1 件で標準出力に全件出す(controller が
      // session doc へリダイレクトして保存する)。
      console.log(key)
    } else {
      summary.skipped++
    }
  }

  if (!opts.execute) {
    console.log(
      `[dry-run] listed=${summary.listed} matched=${summary.matched} skipped=${summary.skipped} ` +
        `(would delete ${matchedKeys.length} object(s); rerun with --execute to delete)`,
    )
    return summary
  }

  // 1 件失敗で run 全体を止めない(失敗件数を集計して続行・最後に非 0 exit)。
  for (const key of matchedKeys) {
    const res = await deleteObject(key)
    if (res.ok) {
      summary.deleted++
    } else {
      summary.failed++
      console.error(`delete failed: key=${key} status=${res.status ?? 'null'}`)
    }
  }

  // 削除後 readback: もう一度 listing し、SRC_KEY_PATTERN 一致の残 0 件を確認する。
  const readback = await listObjects(prefix)
  const remaining = readback.filter((k) => SRC_KEY_PATTERN.test(k))

  console.log(
    `done. listed=${summary.listed} matched=${summary.matched} skipped=${summary.skipped} ` +
      `deleted=${summary.deleted} failed=${summary.failed} remainingAfterReadback=${remaining.length}`,
  )

  if (remaining.length > 0) {
    console.error(`readback FAILED — remaining key(s): ${remaining.join(', ')}`)
    throw new Error(
      `gc-src-prefix: readback found ${remaining.length} remaining key(s) after --execute delete`,
    )
  }
  if (summary.failed > 0) {
    throw new Error(`gc-src-prefix: ${summary.failed} delete(s) failed (see log above)`)
  }

  return summary
}

// ---------------------------------------------------------------------------
// CLI arg parsing(pure・testable)。`--user` の契約は gc-image-assets.ts /
// gc-abandoned-operations.ts の parseUserFlag と同一(意図的な重複 — 既存 script
// 群と同じ判断: CLI arg parsing は 5 行の純関数で共有モジュール化の価値が薄い)。
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

async function main(): Promise<void> {
  const argv = process.argv
  const execute = argv.includes('--execute')
  const userId = parseUserFlag(argv)
  await runGcSrcPrefix({ execute, userId })
}

// process.argv[1] が本 file のとき = CLI 起動。test import 時は走らない
// (gc-image-assets.ts / gc-abandoned-operations.ts と同じ guard)。
if (process.argv[1]?.endsWith('gc-src-prefix.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[gc-src-prefix] fatal:', err)
      process.exit(1)
    })
}
