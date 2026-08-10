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
// 残っていない lane は起動しない。runner 自身の判断はここで独立に持つ(lane ごとに
// 定数を独立定義する既存規律のとおり、各 lane 内部の floor を import しない)。
//
// 12_000 の導出(final review I-3 fix・2026-08-10): 各 lane は起動直後に自身の
// tail reserve(現状 asset_gc・orphan_scan とも 10_000ms・`*_TAIL_RESERVE_MS`)を
// 先取りしてから、lane 側の min slice floor(現状とも 2_000ms・`*_MIN_SLICE_MS`)を
// 満たして初めて処理を始める。旧値(2_000)だと、tail reserve 控除後の残 slice が
// 2_000〜10_000ms の lane が起動でき、起動直後から内部の `slice()` が負になる —
// listing timeout の計算(`Math.floor(slice() / MAX_LIST_PAGES)`)が負値を
// `AbortSignal.timeout()` に渡して同期 RangeError を投げ、lane が listing 失敗と
// 同じ phase(`list`)を立てて実際の原因(starvation)を隠す(controller が実測で
// 確認済み)。floor = tail reserve(10_000)+ lane min slice(2_000)= 12_000 と
// することで、起動した lane には必ず tail reserve 控除後も正の slice(≥ lane min
// slice)が残ることを保証する。**runner は lane 側の定数を import しない規律**
// (lane ごとに定数を独立定義)ゆえ、この結合は doc 上のものにとどまる —
// いずれかの lane が tail reserve / min slice を変えたら、この floor も追随が要る。
const MIN_SLICE_MS = 12_000

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
