import { z } from 'zod'

import { requireWebhookSecret } from '@/lib/env/webhook-secret-gate'
import { logger } from '@/lib/logger'
import { DEFAULT_GRACE_DAYS } from '@/lib/storage/asset-gc'
import { runAssetGcLane } from '@/lib/storage/asset-gc-lane'
import { runOrphanScanLane } from '@/lib/storage/orphan-scan'
import { runSrcSweepLane, SWEEP_CUTOFF_MS } from '@/lib/storage/src-sweep'
import { runLanes, type CronLane } from './run-lanes'

// asset レーン整合 sprint spec §2.1/§5.1(旧②-4b §3 spec §3.1 を 3 lane に拡張): 日次
// Vercel Cron(vercel.json `0 18 * * *` = 03:00 JST)と手動 GET の共通入口。runner が
// 持つのは入口・auth・override 解釈・deadline 配布・実行 readback だけで、削除判定は
// 各 lane 側にある。**HTTP 200 は「runner が走破した」ことだけを意味する** — 運用上の
// 成否は各 lane summary の error / phase / notStarted を読む(手動 GET の readback も
// 同じ読み方)。成功 run は台帳に書かない(integration_failures は失敗記録専用・
// INSERT-only grant)。

export const runtime = 'nodejs'
// literal 必須(route segment config は静的解析されるため import 定数を書けない)。
// 3 lane 分の per-lane 予算(§2.1: src 90s / asset_gc 210s / orphan 260s)+ tail 40s の
// 余裕に対する platform 側の上限。
export const maxDuration = 300

// 手動 GET override の下限(spec §3.2: presign 600s + client PUT 60s + 余裕)。
const CUTOFF_OVERRIDE_MIN_MINUTES = 15

// lane 予算(spec §2.1)。run 開始時刻を原点とする固定絶対 deadline を lane ごとに
// 配る値の正本はここ(runner が配る側)。各 lane 内部の budget 定数(lane 側 file が
// 独自に持つ tail reserve / min slice 等)とは意味が別(あちらは lane 単体の内部予算・
// こちらは 3 lane 分割後の cron 全体予算)のため import 共有しない。最大値(orphan の
// 260_000)と `maxDuration` の関係式は route.test.ts の pin で保証する(offset を
// maxDuration 以上に増やすと red になる)。
const SRC_SWEEP_DEADLINE_OFFSET_MS = 90_000
const ASSET_GC_DEADLINE_OFFSET_MS = 210_000
const ORPHAN_SCAN_DEADLINE_OFFSET_MS = 260_000

// 手動 GET `?lane=` の allowlist(spec §5.1 amend B-10: smoke で他 lane の実削除まで
// 巻き込まないため)。
const LANE_NAMES = ['src_sweep', 'asset_gc', 'asset_orphan_scan'] as const
type LaneName = (typeof LANE_NAMES)[number]
function isLaneName(v: string): v is LaneName {
  return (LANE_NAMES as readonly string[]).includes(v)
}

// `?user=` の判定域(既存慣習と同一 = z.uuid({ version: 'v4' })・local 定義踏襲。
// 共有 util 化は対象 3 箇所目でも rule of three の範囲外)。
const uuidV4Schema = z.uuid({ version: 'v4' })

// `?graceDays=` の判定(clamp しない・非整数/負値のみ弾く)。空文字は Number('') が 0
// になり得るため、正規表現で「数字のみ」を要求して弾く(cutoffMinutes は下限比較で
// 事故的に弾けているが graceDays は 0 が正当値のため同じ迂回が効かない)。
// regex だけでは足りない(fix round 2・Codex P2): 桁数の多い数字列は regex を通っても
// `Number()` で `Infinity` や unsafe integer になりうる。その値がそのまま lane まで
// 届くと、400 `invalid_grace_days` で拒否すべきところが 200 + lane error(promote の
// SQL bind 失敗を never-throw 契約が summary.error に畳んだもの)という誤った応答に
// なる — `Number.isSafeInteger()` で最終確認する(`isSafeInteger(0)` は true なので
// 0 が正当値であることは維持される)。
function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

// `graceDays` の上限(fix round 3・Codex P2 2 周目): 100 年(365 * 100)。
// **意味的な上限であって DB 由来ではない**: `graceDays` は「参照ゼロの asset を回収
// するまでの猶予日数」であり、既定 30 日・override の主用途は stg smoke の 0(即時
// promote)。100 年を超える猶予日数に正当な用途は無い。
// DB(`now() - (N * interval '1 day')` の bind)の許容値から閾値を逆算しない —
// controller が devcontainer の実 PostgreSQL 17 で実測したところ、`N=1e8` で
// `timestamp out of range`(`now()` から遡れる下限が 4713 BC のため)、Codex が根拠に
// 挙げた interval 範囲より **timestamp 範囲の方が先に破綻する**。DB の限界を追う設計は
// DB バージョン・関数・式が変わるたびに追随が要り脆い。36500 は実測で正常動作を確認済み
// (1926 年まで遡る。実測値は task-7-report.md fix round 3 参照)。**clamp しない** —
// 上限へ丸めると要求と実効値が silent にずれる(下限の `cutoffMinutes` と同じ理由)。
const GRACE_DAYS_MAX = 36_500

export async function GET(req: Request) {
  try {
    const secret = requireWebhookSecret('CRON_SECRET', 'Vercel cron')
    // auth は query 検証より先に評価する(未認証 caller に validation の差を返さない)。
    // 空文字は preview / local の fallback。認証成立にすると誰でも叩けるので無条件 401
    // (不変条件 7)。CRON_SECRET 未設定 = 401 = 掃かれない、という fail-closed が stg の
    // sentinel 保護も兼ねる(§8)。
    if (secret === '' || req.headers.get('authorization') !== `Bearer ${secret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const isProduction = process.env.VERCEL_ENV === 'production'
    const url = new URL(req.url)

    const rawCutoffMinutes = url.searchParams.get('cutoffMinutes')
    let cutoffMs = SWEEP_CUTOFF_MS
    let cutoffOverrideMinutes: number | undefined
    if (rawCutoffMinutes !== null) {
      // A1: prod の保持 policy を secret 保持者が 6h → 15min に縮められる操作を機械的に
      // 塞ぐ(「手動 GET 限定」を運用の約束でなく構造で守る)。
      if (isProduction) {
        return Response.json({ error: 'cutoff_override_forbidden' }, { status: 400 })
      }
      const minutes = Number(rawCutoffMinutes)
      // clamp しない — 下限へ丸めると要求と実効 cutoff が silent にずれる(spec §3.2)。
      if (!Number.isInteger(minutes) || minutes < CUTOFF_OVERRIDE_MIN_MINUTES) {
        return Response.json({ error: 'invalid_cutoff_minutes' }, { status: 400 })
      }
      cutoffMs = minutes * 60_000
      cutoffOverrideMinutes = minutes
    }

    // `?graceDays=` / `?user=` は asset_gc lane にのみ効く(spec §5.1)。
    const rawGraceDays = url.searchParams.get('graceDays')
    let graceDays = DEFAULT_GRACE_DAYS
    let graceDaysOverride: number | undefined
    if (rawGraceDays !== null) {
      if (isProduction) {
        return Response.json({ error: 'grace_days_override_forbidden' }, { status: 400 })
      }
      const parsed = parseNonNegativeInt(rawGraceDays)
      if (parsed === null || parsed > GRACE_DAYS_MAX) {
        return Response.json({ error: 'invalid_grace_days' }, { status: 400 })
      }
      graceDays = parsed
      graceDaysOverride = parsed
    }

    const rawUser = url.searchParams.get('user')
    let userScope: string | undefined
    if (rawUser !== null) {
      if (isProduction) {
        return Response.json({ error: 'user_override_forbidden' }, { status: 400 })
      }
      if (!uuidV4Schema.safeParse(rawUser).success) {
        return Response.json({ error: 'invalid_user' }, { status: 400 })
      }
      userScope = rawUser
    }

    // `?lane=` は他 override と独立(3 lane どれにも効く選別) — B-10: これが無いと
    // 「asset_gc だけ stg smoke したい」操作が src_sweep と全域 asset_orphan_scan の
    // 実削除まで起動してしまう。
    const rawLane = url.searchParams.get('lane')
    let laneFilter: Set<string> | undefined
    if (rawLane !== null) {
      if (isProduction) {
        return Response.json({ error: 'lane_override_forbidden' }, { status: 400 })
      }
      const names = rawLane.split(',').map((s) => s.trim())
      if (names.some((n) => !isLaneName(n))) {
        return Response.json({ error: 'invalid_lane' }, { status: 400 })
      }
      laneFilter = new Set(names)
    }

    // lane 固有 config は route が closure で bind する(LaneContext は
    // `{ deadlineAt }` のみ・runSrcSweepLane / runAssetGcLane / runOrphanScanLane の
    // 引数 signature は不変)。順序 = src_sweep → asset_gc → asset_orphan_scan
    // (spec §2 v58 根拠: src は cheap かつ ephemeral な削除、asset は長命参照データで
    // user 単位の DB I/O を要する判定のため軽い lane を先に倒す)。
    const ALL_LANES: CronLane[] = [
      {
        name: 'src_sweep',
        deadlineOffsetMs: SRC_SWEEP_DEADLINE_OFFSET_MS,
        run: (ctx) =>
          runSrcSweepLane({
            deadlineAt: ctx.deadlineAt,
            cutoffMs,
            ...(cutoffOverrideMinutes !== undefined ? { cutoffOverrideMinutes } : {}),
          }),
      },
      {
        name: 'asset_gc',
        deadlineOffsetMs: ASSET_GC_DEADLINE_OFFSET_MS,
        run: (ctx) =>
          runAssetGcLane({
            deadlineAt: ctx.deadlineAt,
            graceDays,
            ...(graceDaysOverride !== undefined ? { graceDaysOverride } : {}),
            ...(userScope !== undefined ? { userScope } : {}),
          }),
      },
      {
        name: 'asset_orphan_scan',
        deadlineOffsetMs: ORPHAN_SCAN_DEADLINE_OFFSET_MS,
        run: (ctx) => runOrphanScanLane({ deadlineAt: ctx.deadlineAt }),
      },
    ]
    // cron(無 param)は常に全 lane。`?lane=` 指定時のみ絞る — 順序は ALL_LANES の
    // canonical 順を保つ(指定順ではない)。
    const lanes = laneFilter
      ? ALL_LANES.filter((lane) => laneFilter.has(lane.name))
      : ALL_LANES

    const runs = await runLanes(lanes, Date.now())
    return Response.json({ runs }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // 500 = runner 自体の失敗(production の CRON_SECRET 欠落 = gate throw 等)。lane の
    // 失敗はここに来ない(per-lane catch で summary に畳まれる)。
    logger.error({ event: 'cron.run.failed', err })
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}
