import { logger } from '@/lib/logger'

// cron runner の lane 逐次実行部(②-4b §3 spec §3.1 / asset レーン整合 sprint spec §2.1)。
// route.ts でなくここに置くのは、stub lane を渡して「1 本の throw が後続 lane と応答を
// 巻き込まない」「絶対 deadline が startMs 起点で動かない」を test で pin する seam が
// 要る一方、その seam を endpoint module の公開面に生やしたくないため。**Next が追加
// export を禁じるからではない**: Turbopack の route validator は構造的 `extends`
// (.next/types/validator.ts)で追加 export を許し、現に route.ts の runtime /
// maxDuration が通っている。厳密な field 検査は webpack 経路(next-types-plugin)にのみ
// 残るため、`--webpack` に切り替えた場合はこの分離が必須になる。判定ロジックは lane
// 側のままで、ここが持つのは実行順・絶対 deadline 配分・防御 catch だけ。

// lane 共通の最小形。cutoff / grace 等 lane 固有 config はここに無い(route が closure
// で bind する・spec §2.1)。
export type LaneContext = {
  deadlineAt: Date
}

// 追加 field(件数・phase 等)は lane 側の型が持ち、readback にはそのまま JSON 化して
// 載る — runner は中身を解釈しない。`notStarted` は起動前に予算切れと判定した lane。
export type LaneSummary = { lane: string; error?: string; notStarted?: true }

export type CronLane = {
  name: string
  // run 開始時刻(runLanes の `startMs` 引数)からの固定オフセット(spec §2.1)。
  deadlineOffsetMs: number
  run: (ctx: LaneContext) => Promise<LaneSummary>
}

// lane 起動可否の floor(spec §2.1 の `MIN_SLICE`)。開始時点でこれ未満の slice しか
// 残っていない lane は起動しない。各 lane 内部の floor(`SWEEP_MIN_SLICE_MS` 等)と
// 同じ値だが、runner 自身の判断はここで独立に持つ(lane ごとに定数を独立定義する
// 既存規律のとおり、import 共有しない)。
const MIN_SLICE_MS = 2_000

/**
 * lane を順に実行し summary を集める。
 *
 * **絶対 deadline(spec §2.1)**: 各 lane の deadline は `startMs + lane.deadlineOffsetMs`
 * — 常に run 開始時刻(`startMs`)を原点に再計算し、`clock() + 残余` のような相対計算は
 * しない。そのため先行 lane がどれだけ長引いても後続 lane の絶対上限は前倒しでは
 * 動かない(早く終わった分は後続の着手が早まり実働時間が伸びるだけ)— 「予算は守るべき
 * 境界と同じ原点から測る」の lane 版。
 */
export async function runLanes(
  lanes: CronLane[],
  startMs: number,
  now?: () => number,
): Promise<LaneSummary[]> {
  const clock = now ?? Date.now
  const runs: LaneSummary[] = []
  for (const lane of lanes) {
    const deadlineAt = new Date(startMs + lane.deadlineOffsetMs)

    if (deadlineAt.getTime() - clock() < MIN_SLICE_MS) {
      // 開始時点でゼロ以下同然の slice を lane に渡すと、lane 側が listing 失敗と
      // 同じ phase を立てて silent に誤ったラベルを残す。「実行されなかった」と
      // 「実行して 0 件だった」を readback で区別するため、ここで止める(spec §2.1)。
      const summary: LaneSummary = { lane: lane.name, notStarted: true }
      logger.info({ event: 'cron.lane.run', ...summary })
      runs.push(summary)
      continue
    }

    let summary: LaneSummary
    try {
      summary = await lane.run({ deadlineAt })
    } catch (err) {
      // lane は throw しない契約(src-sweep.ts 等)。それでも握るのは、契約違反の 1 本で
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
