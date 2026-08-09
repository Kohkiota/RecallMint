import { logger } from '@/lib/logger'

// cron runner の lane 逐次実行部(②-4b §3 spec §3.1)。route.ts でなくここに置くのは、
// stub lane を渡して「1 本の throw が後続 lane と応答を巻き込まない」を test で pin する
// seam が要る一方(実 LANES は src_sweep 1 本なので route 経由では作れない)、その seam を
// endpoint module の公開面に生やしたくないため。**Next が追加 export を禁じるからではない**:
// Turbopack の route validator は構造的 `extends`(.next/types/validator.ts)で追加 export を
// 許し、現に route.ts の runtime / maxDuration が通っている。厳密な field 検査は webpack 経路
// (next-types-plugin)にのみ残るため、`--webpack` に切り替えた場合はこの分離が必須になる。
// 判定ロジックは lane 側のままで、ここが持つのは実行順と防御 catch だけ。

export type LaneContext = {
  deadlineAt: Date
  cutoffMs: number
  cutoffOverrideMinutes?: number
}

// lane 共通の最小形。追加 field(件数・phase 等)は lane 側の型が持ち、readback には
// そのまま JSON 化して載る — runner は中身を解釈しない。
export type LaneSummary = { lane: string; error?: string }

export type CronLane = {
  name: string
  run: (ctx: LaneContext) => Promise<LaneSummary>
}

export async function runLanes(
  lanes: CronLane[],
  ctx: LaneContext,
): Promise<LaneSummary[]> {
  const runs: LaneSummary[] = []
  for (const lane of lanes) {
    let summary: LaneSummary
    try {
      summary = await lane.run(ctx)
    } catch (err) {
      // lane は throw しない契約(src-sweep.ts)。それでも握るのは、契約違反の 1 本で
      // 後続 lane と readback ごと失うのを避けるため(500 は runner 自体の失敗用)。
      logger.error({ event: 'cron.lane.threw', lane: lane.name, err })
      summary = { lane: lane.name, error: String(err) }
    }
    // lane 名は summary が必ず持つ(throw 時は上の catch が lane.name で埋める)ので
    // 二重に載せない。
    logger.info({ event: 'cron.lane.run', ...summary })
    runs.push(summary)
  }
  return runs
}
