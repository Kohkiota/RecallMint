import { describe, it, expect, vi } from 'vitest'

// asset レーン整合 sprint spec §2.1(Task 7)。runLanes 単体の逐次実行・per-lane 防御
// catch・**絶対 deadline 配分**・`notStarted` を pin する。route.ts 経由の GET wiring /
// override 解釈は route.test.ts 側の関心(こちらは lane を丸ごと stub にして runner の
// 振る舞いだけを見る)。

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))

import { runLanes, type CronLane } from './run-lanes'

function stubLane(
  name: string,
  deadlineOffsetMs: number,
  impl: CronLane['run'],
): CronLane {
  return { name, deadlineOffsetMs, run: vi.fn(impl) }
}

describe('runLanes — 逐次実行と per-lane 防御 catch', () => {
  it('全 lane を順に実行し、各 lane に startMs 起点の固定 deadline を渡す', async () => {
    const startMs = 1_000_000
    const now = () => startMs // slice = offset まるまる残っている状態で固定
    const order: string[] = []
    const a = stubLane('a', 90_000, async () => {
      order.push('a')
      return { lane: 'a' }
    })
    const b = stubLane('b', 210_000, async () => {
      order.push('b')
      return { lane: 'b' }
    })
    const runs = await runLanes([a, b], startMs, now)
    expect(order).toEqual(['a', 'b'])
    expect(a.run).toHaveBeenCalledWith({ deadlineAt: new Date(startMs + 90_000) })
    expect(b.run).toHaveBeenCalledWith({ deadlineAt: new Date(startMs + 210_000) })
    expect(runs).toEqual([{ lane: 'a' }, { lane: 'b' }])
  })

  it('1 本の throw は当該 lane の error summary に畳まれ、後続 lane は実行される', async () => {
    const startMs = 1_000_000
    const now = () => startMs
    const boom = stubLane('boom', 90_000, async () => {
      throw new Error('kaboom')
    })
    const next = stubLane('next', 210_000, async () => ({ lane: 'next' }))
    const runs = await runLanes([boom, next], startMs, now)
    expect(next.run).toHaveBeenCalledTimes(1)
    expect(runs).toHaveLength(2)
    expect(runs[0].lane).toBe('boom')
    expect(runs[0].error).toContain('kaboom')
    expect(runs[1]).toEqual({ lane: 'next' })
  })

  it('throw した lane も cron.lane.threw + cron.lane.run を記録する', async () => {
    const startMs = 1_000_000
    const now = () => startMs
    const boom = stubLane('boom', 90_000, async () => {
      throw new Error('kaboom')
    })
    await runLanes([boom], startMs, now)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.threw', lane: 'boom' }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.run', lane: 'boom' }),
    )
  })
})

describe('runLanes — 絶対 deadline(spec §2.1・完了条件②)', () => {
  it('先行 lane が長引いても後続の deadline 値は startMs 起点のまま動かない', async () => {
    const startMs = 1_000_000
    // 先行 lane 実行中に「時間が経過した」ことを模す可変 clock。相対計算
    // (`clock() + 残余`)で deadline を作っていれば後続 lane の deadlineAt が
    // ずれて検出できる — 固定 `now` の下で before/after を突き合わせる相対 test
    // だと通ってしまうため、意図的に clock を進める stub を使う。
    let clock = startMs
    const now = () => clock
    const a = stubLane('a', 90_000, async () => {
      clock += 80_000 // a が長引く(a 自身の残余は減るが b の絶対上限には影響しない)
      return { lane: 'a' }
    })
    const b = stubLane('b', 210_000, async (ctx) => {
      // b 到達時点で clock は startMs+80_000 まで進んでいる。deadlineAt が相対計算
      // なら `now() + something` になり startMs+210_000 からずれるはず。
      expect(ctx.deadlineAt).toEqual(new Date(startMs + 210_000))
      return { lane: 'b' }
    })
    await runLanes([a, b], startMs, now)
    expect(b.run).toHaveBeenCalledWith({ deadlineAt: new Date(startMs + 210_000) })
  })

  it('早く終わった lane の余りは後続の着手を早めるだけで絶対上限は動かさない', async () => {
    // a が一瞬で終わっても b の deadline は startMs+210_000 のまま(前倒しで
    // 押し上がらない)ことを確認する。
    const startMs = 1_000_000
    const now = () => startMs // a は瞬時に完了した体で clock は動かさない
    const a = stubLane('a', 90_000, async () => ({ lane: 'a' }))
    const b = stubLane('b', 210_000, async (ctx) => {
      expect(ctx.deadlineAt.getTime()).toBe(startMs + 210_000)
      return { lane: 'b' }
    })
    await runLanes([a, b], startMs, now)
  })
})

describe('runLanes — notStarted(spec §2.1・完了条件③)', () => {
  it('残 slice が MIN_SLICE(2_000ms)未満なら lane を起動せず notStarted を積む', async () => {
    const startMs = 1_000_000
    // deadline = startMs + 210_000。now をそれより 1_000ms 手前に置くと残 slice(1_000ms)
    // が MIN_SLICE(2_000ms)未満になる。
    const now = () => startMs + 210_000 - 1_000
    const b = stubLane('b', 210_000, async () => ({ lane: 'b' }))
    const runs = await runLanes([b], startMs, now)
    expect(b.run).not.toHaveBeenCalled()
    expect(runs).toEqual([{ lane: 'b', notStarted: true }])
  })

  it('残 slice がちょうど MIN_SLICE なら起動する(境界は起動側)', async () => {
    const startMs = 1_000_000
    const now = () => startMs + 210_000 - 2_000 // 残 slice = 2_000 = MIN_SLICE ちょうど
    const b = stubLane('b', 210_000, async () => ({ lane: 'b' }))
    const runs = await runLanes([b], startMs, now)
    expect(b.run).toHaveBeenCalledTimes(1)
    expect(runs).toEqual([{ lane: 'b' }])
  })

  it('notStarted の lane は cron.lane.run に notStarted:true で記録される', async () => {
    const startMs = 1_000_000
    const now = () => startMs + 210_000 - 1_000
    const b = stubLane('b', 210_000, async () => ({ lane: 'b' }))
    await runLanes([b], startMs, now)
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.run', lane: 'b', notStarted: true }),
    )
  })

  it('後続 lane が notStarted でも先行 lane の実行結果は保持される', async () => {
    const startMs = 1_000_000
    // clock() は lane ごとに 1 回呼ばれる(deadline check)。1 回目(a の check)は
    // 早い時刻、2 回目(b の check)は b の deadline 直前(残 slice < MIN_SLICE)を返す
    // ことで、「a は実行され、b だけ notStarted になる」経過を模す。
    let calls = 0
    const now = () => {
      calls++
      return calls === 1 ? startMs : startMs + 210_000 - 1_000
    }
    const a = stubLane('a', 90_000, async () => ({ lane: 'a' }))
    const b = stubLane('b', 210_000, async () => ({ lane: 'b' }))
    const runs = await runLanes([a, b], startMs, now)
    expect(a.run).toHaveBeenCalledTimes(1)
    expect(b.run).not.toHaveBeenCalled()
    expect(runs).toEqual([{ lane: 'a' }, { lane: 'b', notStarted: true }])
  })
})
