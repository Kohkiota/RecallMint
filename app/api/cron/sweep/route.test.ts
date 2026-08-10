import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// asset レーン整合 sprint spec §2.1/§5.1(Task 7): cron runner route(入口・auth・
// override 解釈・lane 選別・readback)。lane 逐次実行・絶対 deadline 配分・notStarted
// 自体の pin は run-lanes.test.ts(runLanes 単体)の関心。削除判定そのものは各 lane 側
// (lib/storage/*.test.ts)で pin 済みなので、ここでは 3 lane を丸ごと mock して
// 「runner が何を渡し、何を返し、いつ拒否するか」だけを見る。
const {
  mockRunSrcSweepLane,
  mockRunAssetGcLane,
  mockRunOrphanScanLane,
  mockLogger,
  FAKE_CUTOFF_MS,
  FAKE_DEFAULT_GRACE_DAYS,
} = vi.hoisted(() => ({
  mockRunSrcSweepLane: vi.fn(),
  mockRunAssetGcLane: vi.fn(),
  mockRunOrphanScanLane: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // 実値と同じ数値を置くと、route が定数を import せず直書きしていても通ってしまう。
  // 意図的に別値にして「exported 定数を配っている」ことを pin する。
  FAKE_CUTOFF_MS: 4_321_000,
  FAKE_DEFAULT_GRACE_DAYS: 17,
}))

vi.mock('@/lib/storage/src-sweep', () => ({
  runSrcSweepLane: mockRunSrcSweepLane,
  SWEEP_CUTOFF_MS: FAKE_CUTOFF_MS,
}))
vi.mock('@/lib/storage/asset-gc-lane', () => ({
  runAssetGcLane: mockRunAssetGcLane,
}))
vi.mock('@/lib/storage/asset-gc', () => ({
  DEFAULT_GRACE_DAYS: FAKE_DEFAULT_GRACE_DAYS,
}))
vi.mock('@/lib/storage/orphan-scan', () => ({
  runOrphanScanLane: mockRunOrphanScanLane,
}))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))

import { GET } from '@/app/api/cron/sweep/route'

const SECRET = 'cron-secret-1'
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV
const VALID_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function srcSummary(extra: Record<string, unknown> = {}) {
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

function assetGcSummary(extra: Record<string, unknown> = {}) {
  return {
    lane: 'asset_gc',
    usersListed: 0,
    usersProcessed: 0,
    usersSkipped: 0,
    scanned: 0,
    referenced: 0,
    marked: 0,
    cleared: 0,
    promoted: 0,
    r2DeleteOk: 0,
    r2Delete404: 0,
    r2DeleteFailed: 0,
    rowDeleteOk: 0,
    rowDeleteFailed: 0,
    deletedLaneProcessed: 0,
    selfHealed: 0,
    unknownStatus: 0,
    phase: null,
    recordErrors: 0,
    ...extra,
  }
}

function orphanSummary(extra: Record<string, unknown> = {}) {
  return {
    lane: 'asset_orphan_scan',
    listed: 0,
    candidates: 0,
    rowSkipped: 0,
    rowless: 0,
    deleted: 0,
    failed: 0,
    skippedLiveUsers: 0,
    patternMismatch: 0,
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

function srcArgs(): Record<string, unknown> {
  return mockRunSrcSweepLane.mock.calls[0][0] as Record<string, unknown>
}
function assetGcArgs(): Record<string, unknown> {
  return mockRunAssetGcLane.mock.calls[0][0] as Record<string, unknown>
}
function orphanArgs(): Record<string, unknown> {
  return mockRunOrphanScanLane.mock.calls[0][0] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.VERCEL_ENV
  process.env.CRON_SECRET = SECRET
  mockRunSrcSweepLane.mockResolvedValue(srcSummary())
  mockRunAssetGcLane.mockResolvedValue(assetGcSummary())
  mockRunOrphanScanLane.mockResolvedValue(orphanSummary())
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

describe('GET /api/cron/sweep — cutoffMinutes override(src_sweep 専用・既存挙動)', () => {
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
    expect(srcArgs().cutoffMs).toBe(FAKE_CUTOFF_MS)
    expect(srcArgs()).not.toHaveProperty('cutoffOverrideMinutes')
  })

  it('非 production の 15 は 900_000ms + cutoffOverrideMinutes を lane へ渡す', async () => {
    mockRunSrcSweepLane.mockResolvedValue(srcSummary({ cutoffOverrideMinutes: 15 }))
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?cutoffMinutes=15' }))
    expect(res.status).toBe(200)
    expect(srcArgs().cutoffMs).toBe(900_000)
    expect(srcArgs().cutoffOverrideMinutes).toBe(15)
    // readback: 既定 run と override run を summary で区別できること(spec §3.2 条件 ①)。
    const body = (await res.json()) as { runs: { cutoffOverrideMinutes?: number }[] }
    expect(body.runs[0].cutoffOverrideMinutes).toBe(15)
  })
})

describe('GET /api/cron/sweep — graceDays override(asset_gc 専用・spec §5.1・完了条件④⑤⑥)', () => {
  it('クエリ無しは既定 DEFAULT_GRACE_DAYS を asset_gc に渡し override key は無い', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(assetGcArgs().graceDays).toBe(FAKE_DEFAULT_GRACE_DAYS)
    expect(assetGcArgs()).not.toHaveProperty('graceDaysOverride')
  })

  it('graceDays=0(非 prod)が asset_gc に渡り summary に graceDaysOverride が出現する', async () => {
    mockRunAssetGcLane.mockResolvedValue(assetGcSummary({ graceDaysOverride: 0 }))
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?graceDays=0' }))
    expect(res.status).toBe(200)
    expect(assetGcArgs().graceDays).toBe(0)
    expect(assetGcArgs().graceDaysOverride).toBe(0)
    const body = (await res.json()) as { runs: { graceDaysOverride?: number }[] }
    expect(body.runs[1].graceDaysOverride).toBe(0)
  })

  it('非整数・負値(abc / 3.5 / -1 / 空)は 400 で lane を呼ばない', async () => {
    for (const raw of ['abc', '3.5', '-1', '']) {
      vi.clearAllMocks()
      const res = await GET(request({ auth: `Bearer ${SECRET}`, query: `?graceDays=${raw}` }))
      expect(res.status, `graceDays=${raw}`).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error, `graceDays=${raw}`).toBe('invalid_grace_days')
      expect(mockRunAssetGcLane).not.toHaveBeenCalled()
      expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    }
  })

  it('regex は通るが Number() で Infinity / unsafe integer になる桁数は 400 で lane を呼ばない(fix round 2・Codex P2)', async () => {
    // '9'.repeat(400) → Number() が Infinity(regex '/^\d+$/' 自体は通過する)。
    // '9'.repeat(20)(20 桁 = 99999999999999999999)→ Number.isSafeInteger が false
    // になる unsafe integer(Number.isInteger は true のまま = isInteger だけでは
    // 検出できない)。どちらも「400 で拒否すべきところが 200 + lane error(promote
    // の SQL bind 失敗を lane が never-throw 契約で summary.error に畳んだもの)」に
    // 誤って倒れないことを pin する。
    for (const raw of ['9'.repeat(400), '9'.repeat(20)]) {
      vi.clearAllMocks()
      const res = await GET(request({ auth: `Bearer ${SECRET}`, query: `?graceDays=${raw}` }))
      expect(res.status, `graceDays=${raw}`).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error, `graceDays=${raw}`).toBe('invalid_grace_days')
      expect(mockRunAssetGcLane).not.toHaveBeenCalled()
      expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    }
  })

  it('GRACE_DAYS_MAX(36500 = 100 年)は受理・その 1 つ外(36501)は 400(fix round 3・Codex P2 2 周目)', async () => {
    mockRunAssetGcLane.mockResolvedValue(assetGcSummary({ graceDaysOverride: 36_500 }))
    const okRes = await GET(request({ auth: `Bearer ${SECRET}`, query: '?graceDays=36500' }))
    expect(okRes.status).toBe(200)
    expect(assetGcArgs().graceDays).toBe(36_500)
    expect(assetGcArgs().graceDaysOverride).toBe(36_500)

    vi.clearAllMocks()
    const ngRes = await GET(request({ auth: `Bearer ${SECRET}`, query: '?graceDays=36501' }))
    expect(ngRes.status).toBe(400)
    const body = (await ngRes.json()) as { error: string }
    expect(body.error).toBe('invalid_grace_days')
    expect(mockRunAssetGcLane).not.toHaveBeenCalled()
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
  })

  it('production では指定そのものを 400 で拒否(clamp しない)', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?graceDays=0' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('grace_days_override_forbidden')
    expect(mockRunAssetGcLane).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/sweep — user override(asset_gc 専用・spec §5.1・完了条件⑤⑥)', () => {
  it('uuid v4(非 prod)が asset_gc に userScope として渡る', async () => {
    mockRunAssetGcLane.mockResolvedValue(assetGcSummary({ userScope: VALID_USER }))
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: `?user=${VALID_USER}` }))
    expect(res.status).toBe(200)
    expect(assetGcArgs().userScope).toBe(VALID_USER)
    const body = (await res.json()) as { runs: { userScope?: string }[] }
    expect(body.runs[1].userScope).toBe(VALID_USER)
  })

  it('クエリ無しは userScope key 無しで asset_gc を呼ぶ', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(assetGcArgs()).not.toHaveProperty('userScope')
  })

  it('uuid v4 でない値は 400 で lane を呼ばない', async () => {
    for (const raw of ['not-a-uuid', '12345', '']) {
      vi.clearAllMocks()
      const res = await GET(request({ auth: `Bearer ${SECRET}`, query: `?user=${raw}` }))
      expect(res.status, `user=${raw}`).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error, `user=${raw}`).toBe('invalid_user')
      expect(mockRunAssetGcLane).not.toHaveBeenCalled()
    }
  })

  it('production では指定そのものを 400 で拒否', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await GET(
      request({ auth: `Bearer ${SECRET}`, query: `?user=${VALID_USER}` }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('user_override_forbidden')
    expect(mockRunAssetGcLane).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/sweep — lane selector(spec §5.1 amend B-10・完了条件⑥⑦)', () => {
  it('lane=asset_gc 指定時は asset_gc のみ実行し他 2 lane は走らない', async () => {
    const res = await GET(
      request({ auth: `Bearer ${SECRET}`, query: '?lane=asset_gc' }),
    )
    expect(res.status).toBe(200)
    expect(mockRunAssetGcLane).toHaveBeenCalledTimes(1)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    expect(mockRunOrphanScanLane).not.toHaveBeenCalled()
    const body = (await res.json()) as { runs: { lane: string }[] }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].lane).toBe('asset_gc')
  })

  it('カンマ区切りで複数 lane を指定できる', async () => {
    const res = await GET(
      request({ auth: `Bearer ${SECRET}`, query: '?lane=asset_gc,asset_orphan_scan' }),
    )
    expect(res.status).toBe(200)
    expect(mockRunAssetGcLane).toHaveBeenCalledTimes(1)
    expect(mockRunOrphanScanLane).toHaveBeenCalledTimes(1)
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    const body = (await res.json()) as { runs: { lane: string }[] }
    expect(body.runs.map((r) => r.lane)).toEqual(['asset_gc', 'asset_orphan_scan'])
  })

  it('未知 lane 名は 400 で lane を呼ばない', async () => {
    const res = await GET(
      request({ auth: `Bearer ${SECRET}`, query: '?lane=not_a_real_lane' }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_lane')
    expect(mockRunSrcSweepLane).not.toHaveBeenCalled()
    expect(mockRunAssetGcLane).not.toHaveBeenCalled()
    expect(mockRunOrphanScanLane).not.toHaveBeenCalled()
  })

  it('production では指定そのものを 400 で拒否', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await GET(request({ auth: `Bearer ${SECRET}`, query: '?lane=asset_gc' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('lane_override_forbidden')
    expect(mockRunAssetGcLane).not.toHaveBeenCalled()
  })

  it('クエリ無し(cron 発火)は常に全 3 lane を実行する', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(mockRunSrcSweepLane).toHaveBeenCalledTimes(1)
    expect(mockRunAssetGcLane).toHaveBeenCalledTimes(1)
    expect(mockRunOrphanScanLane).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/cron/sweep — 実行と readback(3 lane・完了条件①⑧)', () => {
  it('クエリ無しは 3 lane を順に実行し summary をそのまま返す', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: unknown[] }
    expect(body).toEqual({ runs: [srcSummary(), assetGcSummary(), orphanSummary()] })
  })

  it('lane 順は src_sweep → asset_gc → asset_orphan_scan(呼出順)', async () => {
    const order: string[] = []
    mockRunSrcSweepLane.mockImplementation(async () => {
      order.push('src_sweep')
      return srcSummary()
    })
    mockRunAssetGcLane.mockImplementation(async () => {
      order.push('asset_gc')
      return assetGcSummary()
    })
    mockRunOrphanScanLane.mockImplementation(async () => {
      order.push('asset_orphan_scan')
      return orphanSummary()
    })
    await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(order).toEqual(['src_sweep', 'asset_gc', 'asset_orphan_scan'])
  })

  it('各 lane の deadlineAt は run 開始時刻 + 固定オフセット(src 90s / asset_gc 210s / orphan 260s)', async () => {
    const before = Date.now()
    await GET(request({ auth: `Bearer ${SECRET}` }))
    const after = Date.now()

    const srcDeadline = srcArgs().deadlineAt as Date
    expect(srcDeadline.getTime()).toBeGreaterThanOrEqual(before + 90_000)
    expect(srcDeadline.getTime()).toBeLessThanOrEqual(after + 90_000)

    const gcDeadline = assetGcArgs().deadlineAt as Date
    expect(gcDeadline.getTime()).toBeGreaterThanOrEqual(before + 210_000)
    expect(gcDeadline.getTime()).toBeLessThanOrEqual(after + 210_000)

    const orphanDeadline = orphanArgs().deadlineAt as Date
    expect(orphanDeadline.getTime()).toBeGreaterThanOrEqual(before + 260_000)
    expect(orphanDeadline.getTime()).toBeLessThanOrEqual(after + 260_000)
  })

  it('応答は Cache-Control: no-store', async () => {
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('毎 run cron.lane.run を info で残す(3 lane 分)', async () => {
    await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.run', lane: 'src_sweep', deleted: 1 }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.run', lane: 'asset_gc' }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.lane.run', lane: 'asset_orphan_scan' }),
    )
  })

  it('1 本の throw は当該 lane の error summary に畳まれ、後続 lane は実行される(既存 stub seam)', async () => {
    mockRunSrcSweepLane.mockRejectedValue(new Error('lane exploded'))
    const res = await GET(request({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: { lane: string; error?: string }[] }
    expect(body.runs[0].lane).toBe('src_sweep')
    expect(body.runs[0].error).toContain('lane exploded')
    // 後続 2 lane は影響を受けない。
    expect(mockRunAssetGcLane).toHaveBeenCalledTimes(1)
    expect(mockRunOrphanScanLane).toHaveBeenCalledTimes(1)
    expect(body.runs[1].lane).toBe('asset_gc')
    expect(body.runs[2].lane).toBe('asset_orphan_scan')
  })
})

// ---------------------------------------------------------------------------
// lane deadline offset と maxDuration の関係式 pin
// ---------------------------------------------------------------------------
// route.ts を import せず readFileSync + regex で読む理由: route segment config は
// 静的解析される literal で、値そのものを読むのが素直(既存 precedent =
// app/(app)/app/upload/_actions/submit-upload.test.ts の maxDuration pin・旧
// lib/storage/src-sweep.test.ts の maxDuration drift pin と同型)。
//
// **旧 `SWEEP_BUDGET_MS` pin(lib/storage/src-sweep.test.ts)の後継**: lane 予算が
// 単一定数から 3 lane 分割後の per-lane offset(spec §2.1)に変わったことに伴い、
// 守るべき値が「lane 単体の想定予算」から「全 lane の deadline offset の最大値」に
// 移った(旧 pin は `SWEEP_BUDGET_MS` を誰も参照しなくなり空振りだったため削除・
// 2026-08-10)。**守っているもの**は変わらない: 予算(offset の最大値)が maxDuration
// (ms 換算)以上になると、tail reserve(各 lane 内部が別途先取りする分)で書くはずの
// incomplete 行より先に platform が invocation を打ち切る。打ち切りを観測できる
// 唯一の signal がその行なので、失われると「掃けていない」ことが誰にも見えなくなる。
describe('lane deadline offset と maxDuration の関係式(旧 SWEEP_BUDGET_MS pin の後継)', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, './route.ts'), 'utf8')
  const maxDurationMatched = source.match(/^export const maxDuration = (\d+)$/m)
  // `_DEADLINE_OFFSET_MS = <literal>` の const 宣言だけを拾う(`deadlineOffsetMs:
  // SRC_SWEEP_DEADLINE_OFFSET_MS,` のような参照側は `=` の直後が識別子で終端しない
  // ため誤マッチしない)。
  const offsetMatches = [...source.matchAll(/_DEADLINE_OFFSET_MS = ([\d_]+)$/gm)]

  it('lane deadline offset の const 宣言が 1 つ以上見つかる', () => {
    // マッチ 0 件は「offset の命名規約が変わり、この pin が何も見ていない」ことを
    // 意味する(消えた行と同格の失敗として扱う — 空集合の Math.max は -Infinity に
    // なり下の test が意図せず通ってしまうため、ここで先に検出する)。
    expect(offsetMatches.length).toBeGreaterThan(0)
  })

  it('全 lane の deadline offset の最大値が maxDuration(ms 換算)より小さい', () => {
    expect(maxDurationMatched).not.toBeNull()
    const maxDurationMs = Number(maxDurationMatched![1]) * 1000
    const offsetsMs = offsetMatches.map((m) => Number(m[1].replace(/_/g, '')))
    const maxOffsetMs = Math.max(...offsetsMs)
    expect(maxOffsetMs).toBeLessThan(maxDurationMs)
  })
})
