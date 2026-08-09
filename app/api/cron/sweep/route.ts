import { requireWebhookSecret } from '@/lib/env/webhook-secret-gate'
import { logger } from '@/lib/logger'
import { runSrcSweepLane, SWEEP_BUDGET_MS, SWEEP_CUTOFF_MS } from '@/lib/storage/src-sweep'
import { runLanes, type CronLane } from './run-lanes'

// ②-4b §3 spec §3.1: 日次 Vercel Cron(vercel.json `0 18 * * *` = 03:00 JST)と手動 GET の
// 共通入口。runner が持つのは入口・auth・deadline 配布・実行 readback だけで、削除判定は
// lane 側にある。**HTTP 200 は「runner が走破した」ことだけを意味する** — 運用上の成否は
// 各 lane summary の error / phase を読む(手動 GET の readback も同じ読み方)。
// 成功 run は台帳に書かない(integration_failures は失敗記録専用・INSERT-only grant)。

export const runtime = 'nodejs'
// literal 必須(route segment config は静的解析されるため import 定数を書けない)。
// lane 予算 SWEEP_BUDGET_MS(270s)+ 台帳 tail に対する platform 側の上限。
export const maxDuration = 300

// 手動 GET override の下限(spec §3.2: presign 600s + client PUT 60s + 余裕)。
const CUTOFF_OVERRIDE_MIN_MINUTES = 15

const LANES: CronLane[] = [{ name: 'src_sweep', run: runSrcSweepLane }]

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

    const rawCutoffMinutes = new URL(req.url).searchParams.get('cutoffMinutes')
    let cutoffMs = SWEEP_CUTOFF_MS
    let cutoffOverrideMinutes: number | undefined
    if (rawCutoffMinutes !== null) {
      // A1: prod の保持 policy を secret 保持者が 6h → 15min に縮められる操作を機械的に
      // 塞ぐ(「手動 GET 限定」を運用の約束でなく構造で守る)。
      if (process.env.VERCEL_ENV === 'production') {
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

    // deadline は**固定オフセット**で作る。request の残余予算から導出すると、開始時点で
    // slice がゼロ以下になる経路が到達可能になり、lane が listing 失敗と同じ phase 'list' を
    // 立てて silent に誤ったラベルを残す。
    const deadlineAt = new Date(Date.now() + SWEEP_BUDGET_MS)

    const runs = await runLanes(LANES, {
      deadlineAt,
      cutoffMs,
      ...(cutoffOverrideMinutes !== undefined ? { cutoffOverrideMinutes } : {}),
    })
    return Response.json({ runs }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // 500 = runner 自体の失敗(production の CRON_SECRET 欠落 = gate throw 等)。lane の
    // 失敗はここに来ない(per-lane catch で summary に畳まれる)。
    logger.error({ event: 'cron.run.failed', err })
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}
