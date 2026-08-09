import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ②-4b §3 Task5: cron runner route(入口・auth・override 解釈・lane 逐次実行・readback)。
// 削除判定そのものは lane 側(lib/storage/src-sweep.test.ts)で pin 済みなので、ここでは
// lane を丸ごと mock して「runner が何を渡し、何を返し、いつ拒否するか」だけを見る。
const { mockRunSrcSweepLane, mockLogger, FAKE_CUTOFF_MS, FAKE_BUDGET_MS } = vi.hoisted(
  () => ({
    mockRunSrcSweepLane: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // 実値(6h / 270s)と同じ数値を置くと、route が定数を import せず直書きしていても
    // 通ってしまう。意図的に別値にして「exported 定数を配っている」ことを pin する。
    FAKE_CUTOFF_MS: 4_321_000,
    FAKE_BUDGET_MS: 99_000,
  }),
)

vi.mock('@/lib/storage/src-sweep', () => ({
  runSrcSweepLane: mockRunSrcSweepLane,
  SWEEP_CUTOFF_MS: FAKE_CUTOFF_MS,
  SWEEP_BUDGET_MS: FAKE_BUDGET_MS,
}))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))

import { GET } from '@/app/api/cron/sweep/route'
import { runLanes, type CronLane } from '@/app/api/cron/sweep/run-lanes'

const SECRET = 'cron-secret-1'
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV

function baseSummary(extra: Record<string, unknown> = {}) {
  return {
    lane: 'src_sweep',
    listed: 3,
    candidates: 1,
    deleted: 1,
    failed: 0,
    skippedLiveUsers: 0,
    patternMismatch: 0,
    overdueCount: 0,
    truncated: false,
    phase: null,
    recordErrors: 0,
    ...extra,
  }
}

function request(opts: { auth?: string; query?: string } = {}) {
  return new Request(`https://example.test/api/cron/sweep${opts.query ?? ''}`, {
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
  })
}

// 空 secret ガード(不変条件 7)だけは実 Request で pin できない: HTTP header 値は OWS が
// trim されるため(undici: `Bearer ` → `Bearer`)、gate の '' fallback に一致する
// Authorization を実 Request で表現できず、ガードを外しても 401 のままになる(= 検出力
// ゼロ・変異で実測)。ガードが守るのは transport の trim ではなく「'' を認証成立に
// しない」ことなので、header 値を素通しする最小の fake request で直接叩く。
function rawAuthRequest(auth: string): Request {
  return {
    url: 'https://example.test/api/cron/sweep',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'authorization' ? auth : null),
    },
  } as unknown as Request
}

function laneArgs(): Record<string, unknown> {
  return mockRunSrcSweepLane.mock.calls[0][0] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.VERCEL_ENV
  process.env.CRON_SECRET = SECRET
  mockRunSrcSweepLane.mockResolvedValue(baseSummary())
})

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV
})

describe('GET /api/cron/sweep — auth', () => {
  it('CRON_SECRET 未設定(local tier)は Authorization 無しで 401(lane 不呼出)', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('local tier: 空 secret に一致する `Bearer ` でも 401(不変条件 7)', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(rawAuthRequest('Bearer '))
    expect(res.status).toBe(401)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('preview tier: gate の warn + `` fallback でも `Bearer ` は 401', async () => {
    delete process.env.CRON_SECRET
    process.env.VERCEL_ENV = 'preview'
    const res = await GET(rawAuthRequest('Bearer '))
    expect(res.status).toBe(401)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('Bearer token 不一致は 401', async () => {
    const res = await GET(request({ auth: 'Bearer wrong' }))
    expect(res.status).toBe(401)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('scheme 無し(secret 生値)は 401 — 完全一致でのみ通す', async () => {
    const res = await GET(request({ auth: SECRET }))
    expect(res.status).toBe(401)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('auth は query 検証より先 — 誤 Bearer + 不正 query は 400 でなく 401', async () => {
    const res = await GET(request({ auth: 'Bearer wrong', query: '?cutoffMinutes=14' }))
    expect(res.status).toBe(401)
  })

  it('auth は production override 拒否より先 — 誤 Bearer + override は 401', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await GET(request({ auth: 'Bearer wrong', query: '?cutoffMinutes=15' }))
    expect(res.status).toBe(401)
  })

  it('production + CRON_SECRET 欠落は gate throw → 外周 catch で 500', async () => {
    delete process.env.CRON_SECRET
    process.env.VERCEL_ENV = 'production'
    const res = await GET(request({ auth: 'Bearer whatever' }))
    expect(res.status).toBe(500)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    expect(mockLogger.error).toHaveBeenCalled()
  })
})

describe('GET /api/cron/sweep — cutoffMinutes override', () => {
  it('下限未満(14)は 400 で lane を呼ばない(clamp しない)', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?cutoffMinutes=14' }))
    expect(res.status).toBe(400)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('非整数(abc / 20.5 / 空)は 400 で lane を呼ばない', async () => {
    for (const raw of ['abc', '20.5', '']) {
      vi.clearAllMocks()
      const res = await GET(
        request({ auth: `Bearer ${SECRET}`, query: `?cutoffMinutes=${raw}` }),
      )
      expect(res.status, `cutoffMinutes=${raw}`).toBe(400)
      expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    }
  })

  it('production では override 指定そのものを 400 で拒否(A1)', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?cutoffMinutes=15' }))
    expect(res.status).toBe(400)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('production + クエリ無しは既定 cutoff で lane を実行する', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(laneArgs().cutoffMs).toBe(FAKE_CUTOFF_MS)
    expect(laneArgs()).not.toHaveProperty('cutoffOverrideMinutes')
  })

  it('非 production の 15 は 900_000ms + cutoffOverrideMinutes を lane へ渡す', async () => {
    mockRunSrcSweepLane.mockResolvedValue(baseSummary({ cutoffOverrideMinutes: 15 }))
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?cutoffMinutes=15' }))
    expect(res.status).toBe(200)
    expect(laneArgs().cutoffMs).toBe(900_000)
    expect(laneArgs().cutoffOverrideMinutes).toBe(15)
    // readback: 既定 run と override run を summary で区別できること(spec §3.2 条件 ①)。
    const body = (await res.json()) as { runs: { cutoffOverrideMinutes?: number }[] }
    expect(body.runs[0].cutoffOverrideMinutes).toBe(15)
  })
})

describe('GET /api/cron/sweep — 実行と readback', () => {
  it('クエリ無しは既定 cutoff・override key 無しで lane を実行し summary をそのまま返す', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(mockRunSrcSweepLane).toHaveBeenCalledTimes(1)
    expect(laneArgs().cutoffMs).toBe(FAKE_CUTOFF_MS)
    expect(laneArgs()).not.toHaveProperty('cutoffOverrideMinutes')
    const body = (await res.json()) as { runs: unknown[] }
    expect(body).toEqual({ runs: [baseSummary()] })
  })

  it('deadlineAt は現在時刻 + SWEEP_BUDGET_MS の固定オフセット', async () => {
    const before = Date.now()
    await GET(request({ auth: `Bearer ${SECRET}` }))
    const after = Date.now()
    const deadlineAt = laneArgs().deadlineAt as Date
    expect(deadlineAt).toBeInstanceOf(Date)
    expect(deadlineAt.getTime()).toBeGreaterThanOrEqual(before + FAKE_BUDGET_MS)
    expect(deadlineAt.getTime()).toBeLessThanOrEqual(after + FAKE_BUDGET_MS)
  })

  it('応答は Cache-Control: no-store', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('毎 run cron.lane.run を info で残す', async () => {
    await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.run', lane: 'src_sweep', deleted: 1 }),
    )
  })

  it('lane が契約に反して throw しても 200 + error summary(500 は runner 自体の失敗用)', async () => {
    mockRunSrcSweepLane.mockRejectedValue(new Error('lane exploded'))
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: { lane: string; error?: string }[] }
    expect(body.runs[0].lane).toBe('src_sweep')
    expect(body.runs[0].error).toContain('lane exploded')
  })
})

describe('runLanes — lane 逐次実行と per-lane 防御 catch', () => {
  const ctx = { deadlineAt: new Date(1_000), cutoffMs: FAKE_CUTOFF_MS }

  function stubLane(name: string, impl: CronLane['run']): CronLane {
    return { name, run: vi.fn(impl) }
  }

  it('全 lane に同一 ctx を渡して順に実行する', async () => {
    const order: string[] = []
    const a = stubLane('a', async () => {
      order.push('a')
      return { lane: 'a' }
    })
    const b = stubLane('b', async () => {
      order.push('b')
      return { lane: 'b' }
    })
    const runs = await runLanes([a, b], ctx)
    expect(order).toEqual(['a', 'b'])
    expect(a.run).toHaveBeenCalledWith(ctx)
    expect(b.run).toHaveBeenCalledWith(ctx)
    expect(runs).toEqual([{ lane: 'a' }, { lane: 'b' }])
  })

  it('1 本の throw は当該 lane の error summary に畳まれ、後続 lane は実行される', async () => {
    const boom = stubLane('boom', async () => {
      throw new Error('kaboom')
    })
    const next = stubLane('next', async () => ({ lane: 'next' }))
    const runs = await runLanes([boom, next], ctx)
    expect(next.run).toHaveBeenCalledTimes(1)
    expect(runs).toHaveLength(2)
    expect(runs[0].lane).toBe('boom')
    expect(runs[0].error).toContain('kaboom')
    expect(runs[1]).toEqual({ lane: 'next' })
  })
})
