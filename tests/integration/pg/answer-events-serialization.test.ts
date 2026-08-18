// FSRS 整合 Sprint A Task 6 (spec §9.1): answer_events ingest の behavioral 実証。
//
// 実 PG でしか出ない性質だけをここに置く: 行ロックによる直列化 / 順序ガードの実挙動 /
// clamp と CHECK の相互作用 / event_id の global 一意と RLS の組み合わせ / study_days の
// VALUES CTE 再集計 / 表の schema contract。純関数の fold 規則 (planFold / foldSession) と
// 制御フローは unit 側 (session-aggregate.test.ts / route.test.ts) の担当で、ここでは
// 重複させない。
//
// 並行 test の作法 (Codex plan 指摘 2):
//   green 経路に barrier を置かない。FOR UPDATE が効いている状態では 2 本目の SELECT が
//   1 本目の commit まで進めないため、「両者の SELECT 完了を同期してから解放する」形の
//   barrier は deadlock する。よって Promise.all で 2 flush を同時発行し、**交錯順に
//   関わらず**結果が正しいことだけを assert する。2 tx が実際に別 backend で走ることは
//   measureConcurrentBackends が別途 pin する (非空振りの根拠)。
//
// 刺激 = processAnswerEvents (内部で withTenantTx = app role + tenant context)。
// 観測 = owner 接続 (getFixtureOwnerDb / RLS bypass)。
import { randomUUID } from 'node:crypto'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import { closeDb } from '@/lib/db'
import { answerEvents, cards, studyDays, type User } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { processAnswerEvents } from '@/lib/reviews/ingest-review-events'
import { recomputeStudyDays } from '@/lib/reviews/session-repository'
import type { AnswerEventWire } from '@/lib/sync/shared/answer-event-schema'

import { asTenant } from './setup/as-tenant'
import { measureConcurrentBackends } from './setup/concurrent-tenant'
import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
  type TenantFixture,
  type TenantIds,
} from './setup/fixture'

// fixture が seed 済みの day (2026-07-18) を避けた test 用の時刻。receivedAt は全 event の
// answered_at より後に置き、clamp の describe 以外では clamp が発火しないようにする。
const RECEIVED_AT = new Date('2026-10-01T00:00:00.000Z')
const DAY_1 = '2026-08-20'
const DAY_MID = '2026-09-01'
const DAY_2 = '2026-09-20'
const T1 = new Date('2026-08-20T01:00:00.000Z')
const T2 = new Date('2026-08-20T02:00:00.000Z')
const T3 = new Date('2026-08-20T03:00:00.000Z')
const AT_DAY_2 = new Date('2026-09-20T01:00:00.000Z')
const SESSION_ID = '22222222-2222-4222-a222-222222222222'

let fixture: TenantFixture
let userA: User

beforeEach(async () => {
  await truncateAllUserTables()
  fixture = await seedTwoTenants()
  userA = { id: fixture.a.userId } as User
})

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEvent(
  cardId: string,
  answeredAt: Date,
  overrides: Partial<AnswerEventWire> = {},
): AnswerEventWire {
  return {
    event_id: randomUUID(),
    card_id: cardId,
    session_id: SESSION_ID,
    selected_answer_ids: ['a'],
    is_correct: true,
    rating: 3,
    answered_at: answeredAt.toISOString(),
    ...overrides,
  }
}

async function seedExtraCard(tenant: TenantIds): Promise<string> {
  const id = randomUUID()
  await getFixtureOwnerDb()
    .insert(cards)
    .values({
      id,
      userId: tenant.userId,
      examId: tenant.examId,
      sourceDocumentId: tenant.sourceDocumentId,
      title: 'Extra',
      baseOrder: 1024,
      questionText: 'Q?',
      options: [
        { id: 'a', uid: randomUUID(), text: 'opt a', is_correct: true },
        { id: 'b', uid: randomUUID(), text: 'opt b', is_correct: false },
      ],
      correctAnswerIds: ['a'],
      ...initialFsrsState(new Date('2026-08-01T00:00:00.000Z')),
    })
  return id
}

function readCard(cardId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(cards)
    .where(eq(cards.id, cardId))
    .then((rows) => rows[0]!)
}

function readEvent(eventId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(answerEvents)
    .where(eq(answerEvents.eventId, eventId))
    .then((rows) => rows[0] ?? null)
}

function readStudyDays(userId: string) {
  return getFixtureOwnerDb()
    .select()
    .from(studyDays)
    .where(eq(studyDays.userId, userId))
    .orderBy(studyDays.day)
}

async function readStudyDay(userId: string, day: string) {
  const rows = await readStudyDays(userId)
  return rows.find((r) => r.day === day) ?? null
}

async function countApplied(eventIds: string[]): Promise<number> {
  const rows = await getFixtureOwnerDb()
    .select({ eventId: answerEvents.eventId })
    .from(answerEvents)
    .where(and(inArray(answerEvents.eventId, eventIds), eq(answerEvents.applied, true)))
  return rows.length
}

// postgres-js の PostgresError は drizzle が DrizzleQueryError で包み .cause に載せるため
// chain を walk する (grant-narrowing.test.ts の同型 helper と同じ理由)。
function pgErrorField(err: unknown, field: string): string | undefined {
  const value = (err as Record<string, unknown> | undefined)?.[field]
  if (typeof value === 'string') return value
  const cause = (err as { cause?: unknown } | undefined)?.cause
  return cause !== undefined && cause !== err ? pgErrorField(cause, field) : undefined
}

async function expectCheckViolation(
  op: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let caught: unknown
  try {
    await op()
  } catch (e) {
    caught = e
  }
  expect(caught, 'expected the statement to reject').toBeDefined()
  expect(pgErrorField(caught, 'code')).toBe('23514')
  expect(pgErrorField(caught, 'constraint_name')).toBe(constraintName)
}

// ---------------------------------------------------------------------------
// 0. harness — 2 接続の同時実行が成立していること
// ---------------------------------------------------------------------------

describe('harness: 同一 user 2 接続の同時実行', () => {
  // これが偽なら以降の並行 pin は「直列実行でも同じ結果」を見ているだけになる。
  it('同時に開いた 2 tenant tx は別の PG backend で走る', async () => {
    const pids = await measureConcurrentBackends(fixture.a.userId)
    expect(pids).toHaveLength(2)
    expect(pids[0]).not.toBe(pids[1])
  })
})

// ---------------------------------------------------------------------------
// 1. 直列化 (spec §9.1-1)
// ---------------------------------------------------------------------------

describe('直列化: 同一 card への 2 接続同時 flush', () => {
  it('両 commit 後に reps=2 (card 行ロックが無ければ lost update で 1)', async () => {
    // 2 event を同時刻にする: 順序ガードは `>=` なので、どちらが先に直列化されても
    // 両方適用される = 交錯順に依存しない assert が書ける。
    const e1 = makeEvent(fixture.a.cardId, T1)
    const e2 = makeEvent(fixture.a.cardId, T1)

    const [r1, r2] = await Promise.all([
      processAnswerEvents(userA, [e1], RECEIVED_AT),
      processAnswerEvents(userA, [e2], RECEIVED_AT),
    ])

    expect(r1.failed).toEqual([])
    expect(r2.failed).toEqual([])

    const card = await readCard(fixture.a.cardId)
    // 判別力を持つのは reps / current_streak。applied 2 行は lost update 下でも成立する
    // (各 tx は自分の event を適用するため) ので、これ単独では直列化の証明にならない。
    expect(card.reps).toBe(2)
    expect(card.currentStreak).toBe(2)
    expect(await countApplied([e1.event_id, e2.event_id])).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 2. 順序ガード 5 形 (spec §9.1-2 / §2.4)
// ---------------------------------------------------------------------------

describe('順序ガード', () => {
  it('(a) 適用済み card へ厳密に古い event → applied=false ∧ cards 全列不変', async () => {
    await processAnswerEvents(userA, [makeEvent(fixture.a.cardId, T2)], RECEIVED_AT)
    const before = await readCard(fixture.a.cardId)

    const stale = makeEvent(fixture.a.cardId, T1)
    const res = await processAnswerEvents(userA, [stale], RECEIVED_AT)

    // 順序ガードは reject ではなく applied=false への降格 (200 で client は synced 化)。
    expect(res.failed).toEqual([])
    expect((await readEvent(stale.event_id))!.applied).toBe(false)
    // updated_at 含む全列一致 = cards UPDATE 自体が発行されていない。
    expect(await readCard(fixture.a.cardId)).toEqual(before)
  })

  it('(b) 同一 request 内の新旧混在は per-card sort で全適用', async () => {
    const newer = makeEvent(fixture.a.cardId, T2)
    const older = makeEvent(fixture.a.cardId, T1)

    // payload 順は新 → 旧。sort が無ければ older が順序ガードで落ちる。
    const res = await processAnswerEvents(userA, [newer, older], RECEIVED_AT)

    expect(res.failed).toEqual([])
    expect(await countApplied([newer.event_id, older.event_id])).toBe(2)
    const card = await readCard(fixture.a.cardId)
    expect(card.reps).toBe(2)
    expect(card.lastReview).toEqual(T2)
  })

  it('(c) 中間時刻 event の遅着 → applied=false', async () => {
    await processAnswerEvents(
      userA,
      [makeEvent(fixture.a.cardId, T1), makeEvent(fixture.a.cardId, T3)],
      RECEIVED_AT,
    )
    const mid = makeEvent(fixture.a.cardId, T2)
    await processAnswerEvents(userA, [mid], RECEIVED_AT)

    expect((await readEvent(mid.event_id))!.applied).toBe(false)
    const card = await readCard(fixture.a.cardId)
    expect(card.reps).toBe(2)
    expect(card.lastReview).toEqual(T3)
  })

  it('(d) 同時刻 event は適用される (境界は >=)', async () => {
    await processAnswerEvents(userA, [makeEvent(fixture.a.cardId, T2)], RECEIVED_AT)
    const tie = makeEvent(fixture.a.cardId, T2)
    await processAnswerEvents(userA, [tie], RECEIVED_AT)

    expect((await readEvent(tie.event_id))!.applied).toBe(true)
    const card = await readCard(fixture.a.cardId)
    expect(card.reps).toBe(2)
    expect(card.lastReview).toEqual(T2)
  })

  it('(e) lastReview=null の card は常に適用', async () => {
    expect((await readCard(fixture.a.cardId)).lastReview).toBeNull()

    const first = makeEvent(fixture.a.cardId, T1)
    const res = await processAnswerEvents(userA, [first], RECEIVED_AT)

    expect(res.failed).toEqual([])
    expect((await readEvent(first.event_id))!.applied).toBe(true)
    const card = await readCard(fixture.a.cardId)
    expect(card.reps).toBe(1)
    expect(card.lastReview).toEqual(T1)
  })
})

// ---------------------------------------------------------------------------
// 3. clamp (spec §9.1-3 / §2.3)
// ---------------------------------------------------------------------------

describe('clamp: 未来 answered_at', () => {
  it('保存値は receivedAt に丸められ、due が未来クロックに汚染されない', async () => {
    const receivedAt = new Date('2026-08-20T01:00:00.000Z')
    const future = new Date(receivedAt.getTime() + 3_600_000)

    const ev = makeEvent(fixture.a.cardId, future)
    const res = await processAnswerEvents(userA, [ev], receivedAt)
    expect(res.failed).toEqual([])

    const row = (await readEvent(ev.event_id))!
    expect(row.answeredAt).toEqual(receivedAt)
    expect(row.createdAt).toEqual(receivedAt)
    expect(row.answeredAt.getTime()).toBeLessThanOrEqual(row.createdAt.getTime())

    const card = await readCard(fixture.a.cardId)
    expect(card.lastReview).toEqual(receivedAt)
    // 未 clamp なら due は future 起点 (Good 1 回で future+10 分) になる。
    expect(card.due.getTime()).toBeLessThan(future.getTime())
  })
})

// ---------------------------------------------------------------------------
// 4. dangling event (spec §9.1-4 / §3)
// ---------------------------------------------------------------------------

describe('dangling: card 不在 event', () => {
  it('insert される (applied=false) ∧ failed に載らない', async () => {
    const ghostCardId = randomUUID()
    const ev = makeEvent(ghostCardId, T1)

    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)

    expect(res.failed).toEqual([])
    const row = (await readEvent(ev.event_id))!
    expect(row.cardId).toBe(ghostCardId)
    expect(row.applied).toBe(false)
    // applied が 1 件も出ないので study_days の再集計対象 day も生まれない。
    expect(await readStudyDay(fixture.a.userId, DAY_1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. event_id 衝突 3 形 (spec §9.1-5 / §2.2 手順 4)
// ---------------------------------------------------------------------------

describe('event_id 衝突', () => {
  it('(a) 他 user の既存 event_id → failed[] ∧ 相手の行は不変', async () => {
    const [bEvent] = await getFixtureOwnerDb()
      .select()
      .from(answerEvents)
      .where(eq(answerEvents.userId, fixture.b.userId))
    const before = bEvent!

    // A が B の event_id を送る。event_id は PK = 全 tenant 横断 UNIQUE なので
    // ON CONFLICT DO NOTHING で非新規になるが、own-scope SELECT では見えない
    // (RLS を迂回して owner を覗きに行かない) → 所有権検証で failed。
    const collide = makeEvent(fixture.a.cardId, T1, { event_id: before.eventId })
    const res = await processAnswerEvents(userA, [collide], RECEIVED_AT)

    expect(res.failed).toEqual([before.eventId])
    expect(await readEvent(before.eventId)).toEqual(before)
    expect((await readCard(fixture.a.cardId)).reps).toBe(0)
  })

  it('(b) 自 user・内容不一致の再送 → failed[] ∧ 既存行不変 (先勝ち immutable)', async () => {
    const ev = makeEvent(fixture.a.cardId, T1)
    await processAnswerEvents(userA, [ev], RECEIVED_AT)
    const before = (await readEvent(ev.event_id))!

    const res = await processAnswerEvents(
      userA,
      [{ ...ev, rating: 1 as const }],
      RECEIVED_AT,
    )

    expect(res.failed).toEqual([ev.event_id])
    expect(await readEvent(ev.event_id)).toEqual(before)
    expect((await readCard(fixture.a.cardId)).reps).toBe(1)
  })

  it('(c) 正当な再送 (内容一致) → failed に載らず二重適用もしない', async () => {
    const ev = makeEvent(fixture.a.cardId, T1)
    await processAnswerEvents(userA, [ev], RECEIVED_AT)
    const before = (await readEvent(ev.event_id))!

    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)

    expect(res.failed).toEqual([])
    expect(await readEvent(ev.event_id)).toEqual(before)
    expect((await readCard(fixture.a.cardId)).reps).toBe(1)
  })

  it('(c) 初回に clamp された event の再送も一致判定される', async () => {
    const receivedAt1 = new Date('2026-08-20T01:00:00.000Z')
    const future = new Date(receivedAt1.getTime() + 3_600_000)
    const ev = makeEvent(fixture.a.cardId, future)

    await processAnswerEvents(userA, [ev], receivedAt1)
    const before = (await readEvent(ev.event_id))!
    expect(before.answeredAt).toEqual(receivedAt1)

    // 再送は raw answered_at が同一のまま、受信時刻だけが後ろにずれる。比較式が
    // min(raw, 既存行 created_at) でなく raw 直比較だと、ここで偽陽性 mismatch になる。
    const receivedAt2 = new Date(receivedAt1.getTime() + 7_200_000)
    const res = await processAnswerEvents(userA, [ev], receivedAt2)

    expect(res.failed).toEqual([])
    expect(await readEvent(ev.event_id)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// 5.5. origin 列 (Dash-1 Home v1 spec §11)
// ---------------------------------------------------------------------------

describe('origin: 未知値の正規化・先着固定・collision 対象外 (Dash-1 Home v1 spec §11)', () => {
  it('(a) 未知の origin は null に正規化され、batch は失敗しない (可用性 pin — 未知の分析ラベル 1 つが同期を止めない)', async () => {
    const ev = makeEvent(fixture.a.cardId, T1, { origin: 'totally_unrecognized_label' })
    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)

    expect(res.failed).toEqual([])
    const row = (await readEvent(ev.event_id))!
    expect(row.origin).toBeNull()
  })

  it('(b) 既知の origin はそのまま保存される', async () => {
    const ev = makeEvent(fixture.a.cardId, T1, { origin: 'home_today' })
    const res = await processAnswerEvents(userA, [ev], RECEIVED_AT)

    expect(res.failed).toEqual([])
    const row = (await readEvent(ev.event_id))!
    expect(row.origin).toBe('home_today')
  })

  it('(c) 再送は既存行の origin を更新も補完もしない (先着固定・冪等の単純さを優先)', async () => {
    const ev = makeEvent(fixture.a.cardId, T1, { origin: 'home_today' })
    await processAnswerEvents(userA, [ev], RECEIVED_AT)
    const before = (await readEvent(ev.event_id))!
    expect(before.origin).toBe('home_today')

    // 内容一致 (origin だけ異なる) の再送 → matchesExisting は origin を比較しないので
    // 正当な再送として扱われ、既存行 (origin 含む) は不変のまま。
    await processAnswerEvents(userA, [{ ...ev, origin: 'custom' }], RECEIVED_AT)
    expect(await readEvent(ev.event_id)).toEqual(before)

    // origin 欠落 (旧 client 相当) の再送でも null 補完されない。
    const { origin: _omit, ...evWithoutOrigin } = ev
    await processAnswerEvents(userA, [evWithoutOrigin], RECEIVED_AT)
    expect(await readEvent(ev.event_id)).toEqual(before)

    // null → present (§11.4「null 行への後付け補完もしない」の方向。初回 origin 無しで
    // 記録した既存行に、再送で origin が付いても書き込まれてはいけない — 最も
    // 回帰しやすい向き: `UPDATE … SET origin = $1 WHERE origin IS NULL` のような
    // 「null だけ埋める」 実装は (c) の非 null ケースを壊さず通過してしまう)。
    const evNullFirst = makeEvent(fixture.a.cardId, T2) // origin 省略 → undefined → null 正規化
    await processAnswerEvents(userA, [evNullFirst], RECEIVED_AT)
    const beforeNull = (await readEvent(evNullFirst.event_id))!
    expect(beforeNull.origin).toBeNull()

    await processAnswerEvents(userA, [{ ...evNullFirst, origin: 'home_today' }], RECEIVED_AT)
    expect(await readEvent(evNullFirst.event_id)).toEqual(beforeNull)
  })

  it('(d) origin 違いのみの再送は collision にならない (CollisionCandidate は origin を比較対象に含めない)', async () => {
    const ev = makeEvent(fixture.a.cardId, T1, { origin: 'home_today' })
    await processAnswerEvents(userA, [ev], RECEIVED_AT)

    const res = await processAnswerEvents(userA, [{ ...ev, origin: 'smart' }], RECEIVED_AT)

    expect(res.failed).toEqual([])
  })

  // log 契約 (spec §11.3): review_events.bulk.origin_normalized は「batch につき 1 行」
  // — createOriginNormalizer 単体の unit test (lib/reviews/ingest-review-events.test.ts)
  // は集約ロジック (buildLog が返す payload の中身) しか見ておらず、実際に
  // processAnswerEvents が logger.warn を呼ぶ回数 (呼出 site の性質) はここでしか
  // 検証できない。real PG + real logger 経由でこの回数を直接 pin する。
  it('(log 契約) 複数の未知 origin を含む batch でも logger.warn は正確に 1 回だけ発火する', async () => {
    const warnSpy = vi.spyOn(logger, 'warn')
    const card2 = await seedExtraCard(fixture.a)
    const ev1 = makeEvent(fixture.a.cardId, T1, { origin: 'bogus_a' })
    const ev2 = makeEvent(card2, T2, { origin: 'bogus_b' })

    const res = await processAnswerEvents(userA, [ev1, ev2], RECEIVED_AT)
    expect(res.failed).toEqual([])

    const originLogCalls = warnSpy.mock.calls.filter(
      ([payload]) =>
        (payload as { event?: string }).event === 'review_events.bulk.origin_normalized',
    )
    expect(originLogCalls).toHaveLength(1)
    expect(originLogCalls[0]![0]).toMatchObject({
      event: 'review_events.bulk.origin_normalized',
      userId: fixture.a.userId,
      count: 2,
    })
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6. schema contract readback (spec §9.1-6)
// ---------------------------------------------------------------------------

describe('schema contract: answer_events を実 PG から readback', () => {
  // 目的は「表の DROP/CREATE で PK / CHECK / index / policy / grant が失われた」事故の
  // 恒久検出。policy の**述語**そのものの drift は rls-drift.test.ts が全表分を持つため
  // ここでは重複させず、この表に policy が存在し実効であることまでを見る。
  it('制約は PK(event_id) + FK(user_id CASCADE) + CHECK 3 本で、定義文まで一致する', async () => {
    // contype を p/f/c に絞る: PG18 は NOT NULL を pg_constraint(contype='n') にも
    // 記録するため、絞らないと PG bump だけで偽 red になる (devcontainer は PG17.10)。
    const rows = await getFixtureOwnerDb().execute<{
      conname: string
      contype: string
      def: string
    }>(sql`
      SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'answer_events'::regclass AND contype IN ('p', 'f', 'c')
      ORDER BY conname
    `)

    // 名前だけでなく定義文まで pin する — 名前を保ったまま述語が緩む書き換え
    // (例 rating の下限が消える) を名前集合では検出できないため。
    expect(rows.map((r) => [r.conname, r.def])).toEqual([
      ['answer_events_answered_at_le_created_at', 'CHECK ((answered_at <= created_at))'],
      [
        'answer_events_elapsed_ms_nonneg',
        'CHECK (((elapsed_ms IS NULL) OR (elapsed_ms >= 0)))',
      ],
      ['answer_events_pkey', 'PRIMARY KEY (event_id)'],
      ['answer_events_rating_range', 'CHECK (((rating >= 1) AND (rating <= 4)))'],
      [
        'answer_events_user_id_users_id_fk',
        'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      ],
    ])
    // dangling event を正規状態にするため card_id に FK を張らない (spec §1.1)。
    expect(rows.filter((r) => r.contype === 'f')).toHaveLength(1)
  })

  it('index は pkey + (user_id, answered_at) + (user_id, card_id, answered_at, event_id) の 3 本のみ (Dash-1 Home v1 §10・migration 0040)', async () => {
    const rows = await getFixtureOwnerDb().execute<{
      indexname: string
      indexdef: string
    }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'answer_events' ORDER BY indexname
    `)
    expect(rows.map((r) => r.indexname)).toEqual([
      'answer_events_pkey',
      'answer_events_user_card_answered_idx',
      'answer_events_user_idx',
    ])
    expect(rows[1]!.indexdef).toBe(
      'CREATE INDEX answer_events_user_card_answered_idx ON public.answer_events USING btree (user_id, card_id, answered_at, event_id)',
    )
    expect(rows[2]!.indexdef).toBe(
      'CREATE INDEX answer_events_user_idx ON public.answer_events USING btree (user_id, answered_at)',
    )
  })

  it('RLS が有効で recallmint_app 向け tenant policy が存在する', async () => {
    const [rel] = await getFixtureOwnerDb().execute<{ relrowsecurity: boolean }>(
      sql`SELECT relrowsecurity FROM pg_class WHERE oid = 'answer_events'::regclass`,
    )
    expect(rel!.relrowsecurity).toBe(true)

    const policies = await getFixtureOwnerDb().execute<{
      policyname: string
      cmd: string
      roles: string[]
    }>(sql`
      SELECT policyname, cmd, roles FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'answer_events'
    `)
    expect(policies).toHaveLength(1)
    expect(policies[0]!.policyname).toBe('answer_events_tenant')
    expect(policies[0]!.cmd).toBe('ALL')
    expect(policies[0]!.roles).toEqual(['recallmint_app'])
  })

  it('policy は実効: A の tenant context から B の event が見えない', async () => {
    const visible = await asTenant(fixture.a.userId, (tx) =>
      tx.select({ userId: answerEvents.userId }).from(answerEvents),
    )
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.every((r) => r.userId === fixture.a.userId)).toBe(true)
  })

  it('app role の grant は SELECT/INSERT/UPDATE/DELETE の 4 コマンド', async () => {
    const rows = await getFixtureOwnerDb().execute<{ privilege_type: string }>(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'answer_events'
        AND grantee = 'recallmint_app'
      ORDER BY privilege_type
    `)
    expect(rows.map((r) => r.privilege_type)).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ])
  })

  // CHECK は「存在する」だけでなく実際に reject することまで見る
  // (T3 引き継ぎ: 存在 pin のみだと制約が NOT VALID / 無効化されても気付けない)。
  it('CHECK は実際に reject する (rating 範囲 / elapsed_ms 非負 / answered_at <= created_at)', async () => {
    const base = {
      userId: fixture.a.userId,
      cardId: fixture.a.cardId,
      sessionId: null,
      selectedAnswerIds: [],
      isCorrect: true,
      applied: false,
      answeredAt: T1,
      createdAt: RECEIVED_AT,
    }
    const insert = (overrides: Record<string, unknown>) => () =>
      getFixtureOwnerDb()
        .insert(answerEvents)
        .values({ eventId: randomUUID(), rating: 3, ...base, ...overrides })

    // 上限だけ試すと下限が消える書き換え (CHECK (rating <= 4)) を素通しするため両側見る。
    await expectCheckViolation(insert({ rating: 0 }), 'answer_events_rating_range')
    await expectCheckViolation(insert({ rating: 5 }), 'answer_events_rating_range')
    await expectCheckViolation(
      insert({ elapsedMs: -1 }),
      'answer_events_elapsed_ms_nonneg',
    )
    await expectCheckViolation(
      insert({ answeredAt: new Date(RECEIVED_AT.getTime() + 1) }),
      'answer_events_answered_at_le_created_at',
    )
  })

  it('cards の state CHECK も実際に reject する (0..3 外)', async () => {
    await expectCheckViolation(
      () =>
        getFixtureOwnerDb()
          .update(cards)
          .set({ state: 4 as unknown as 0 })
          .where(eq(cards.id, fixture.a.cardId)),
      'cards_state_range',
    )
  })
})

// ---------------------------------------------------------------------------
// 7. study_days 再集計 (spec §9.1-7 / §5)
// ---------------------------------------------------------------------------

describe('study_days: VALUES CTE 再集計', () => {
  it('複数 day 跨ぎ flush で全対象 day が絶対値 UPSERT される', async () => {
    // 既存行に嘘の値を入れておく: 加算意味論なら 99+1、skip なら 99 のまま残る。
    await getFixtureOwnerDb()
      .insert(studyDays)
      .values({
        userId: fixture.a.userId,
        day: DAY_1,
        reviewCount: 99,
        correctCount: 99,
        distinctCardCount: 99,
      })

    // correct_count の定義 (is_correct 由来 / rating>=2 由来) が発散する event を混ぜる。
    // 両定義で同値になる event しか無いと、CTE の FILTER が rating>=2 に戻っても緑のまま。
    // 発散の向きを day ごとに逆にして、片側だけ効く書き換えも拾う。
    const card2 = await seedExtraCard(fixture.a)
    const res = await processAnswerEvents(
      userA,
      [
        makeEvent(fixture.a.cardId, T1),
        // is_correct=false ∧ rating=4: is_correct 定義なら非正解、rating 定義なら正解。
        makeEvent(card2, T2, { is_correct: false, rating: 4 }),
        // is_correct=true ∧ rating=1: 逆向き。default 0 とも異なるので「一切書かれない」も落ちる。
        makeEvent(fixture.a.cardId, AT_DAY_2, { is_correct: true, rating: 1 }),
      ],
      RECEIVED_AT,
    )
    expect(res.failed).toEqual([])

    expect(await readStudyDay(fixture.a.userId, DAY_1)).toMatchObject({
      reviewCount: 2,
      // rating>=2 定義なら 2 になる。
      correctCount: 1,
      distinctCardCount: 2,
    })
    expect(await readStudyDay(fixture.a.userId, DAY_2)).toMatchObject({
      reviewCount: 1,
      // rating>=2 定義なら 0 (= 行生成時の default とも一致してしまう値) になる。
      correctCount: 1,
      distinctCardCount: 1,
    })
  })

  it('遠く離れた 2 day の flush で中間 day の行は生成も変更もされない', async () => {
    // min〜max の連続 range で再集計していれば、この中間行が 0 に潰れる。
    await getFixtureOwnerDb()
      .insert(studyDays)
      .values({
        userId: fixture.a.userId,
        day: DAY_MID,
        reviewCount: 7,
        correctCount: 5,
        distinctCardCount: 3,
      })

    await processAnswerEvents(
      userA,
      [makeEvent(fixture.a.cardId, T1), makeEvent(fixture.a.cardId, AT_DAY_2)],
      RECEIVED_AT,
    )

    expect(await readStudyDay(fixture.a.userId, DAY_MID)).toMatchObject({
      reviewCount: 7,
      correctCount: 5,
      distinctCardCount: 3,
    })
    // 生成されるのは対象 2 day のみ (fixture seed の 2026-07-18 と中間行を含めて 4 行)。
    expect((await readStudyDays(fixture.a.userId)).map((r) => r.day)).toEqual([
      '2026-07-18',
      DAY_1,
      DAY_MID,
      DAY_2,
    ])
  })
})

// ---------------------------------------------------------------------------
// 8. cross-card 同一 day 競合 (spec §5 の day 行ロック)
// ---------------------------------------------------------------------------

describe('cross-card 同一 day 競合: 2 接続同時 flush', () => {
  it('異なる card・同一 day で review_count=2 ∧ distinct_card_count=2', async () => {
    const card2 = await seedExtraCard(fixture.a)
    // day 行を**先に**作っておく。行が無い状態だと 2 本目の
    // INSERT ... ON CONFLICT DO NOTHING が 1 本目の未 commit tuple を待って偶然直列化し、
    // FOR UPDATE の寄与を分離できない (= day 行ロックを外しても緑になる)。
    await getFixtureOwnerDb()
      .insert(studyDays)
      .values({ userId: fixture.a.userId, day: DAY_1 })

    const [r1, r2] = await Promise.all([
      processAnswerEvents(userA, [makeEvent(fixture.a.cardId, T1)], RECEIVED_AT),
      processAnswerEvents(userA, [makeEvent(card2, T2)], RECEIVED_AT),
    ])
    expect(r1.failed).toEqual([])
    expect(r2.failed).toEqual([])

    // card 行ロックは同一 card しか直列化しない。day 行ロックが無ければ双方が相手の
    // 未 commit event を含まない集計を後勝ちで上書きし review_count=1 になる。
    expect(await readStudyDay(fixture.a.userId, DAY_1)).toMatchObject({
      reviewCount: 2,
      correctCount: 2,
      distinctCardCount: 2,
    })
  })

  it('day 行が未生成でも review_count=2 ∧ distinct_card_count=2 (その day の初回復習)', async () => {
    // 本番の主経路 (その day の初回復習が並走する) を覆う。
    // ⚠️ 現状これを守っているのは day 行の FOR UPDATE ではなく、再集計手順 1 の
    // `INSERT ... ON CONFLICT DO NOTHING` が相手の未 commit tuple を待つ挙動
    // (unique index の speculative insertion 待ち) — 手順 1 を消す / 最終文の
    // ON CONFLICT DO UPDATE に畳む / INSERT を集計の後ろへ動かす refactor で
    // この保護は静かに消える。その退行をここで捕まえる。
    const card2 = await seedExtraCard(fixture.a)
    expect(await readStudyDay(fixture.a.userId, DAY_1)).toBeNull()

    const [r1, r2] = await Promise.all([
      processAnswerEvents(userA, [makeEvent(fixture.a.cardId, T1)], RECEIVED_AT),
      processAnswerEvents(userA, [makeEvent(card2, T2)], RECEIVED_AT),
    ])
    expect(r1.failed).toEqual([])
    expect(r2.failed).toEqual([])

    expect(await readStudyDay(fixture.a.userId, DAY_1)).toMatchObject({
      reviewCount: 2,
      correctCount: 2,
      distinctCardCount: 2,
    })
  })
})

// ---------------------------------------------------------------------------
// 9. recomputeStudyDays の行数 postcondition
// ---------------------------------------------------------------------------

describe('recomputeStudyDays: day 入力の正規化', () => {
  // ロック網羅性 postcondition (行数不一致 → throw) の pin は unit 側
  // (session-repository.test.ts) が正 — 実 PG では手順 1 の行確保が必ず成功するため
  // 欠損を自然に作れない。ここでは「重複 day を throw に昇格させない」ことだけを見る
  // (throw にすると client が 503 で再送し続ける形になるため、意図的に吸収している)。
  it('重複 day 入力は distinct 化されて吸収され、集計は 1 回分になる', async () => {
    const ev = makeEvent(fixture.a.cardId, T1)
    await processAnswerEvents(userA, [ev], RECEIVED_AT)

    await expect(
      asTenant(fixture.a.userId, (tx) =>
        recomputeStudyDays(tx, fixture.a.userId, [DAY_1, DAY_1]),
      ),
    ).resolves.toBeUndefined()

    expect(await readStudyDay(fixture.a.userId, DAY_1)).toMatchObject({
      reviewCount: 1,
      correctCount: 1,
      distinctCardCount: 1,
    })
  })
})

// ---------------------------------------------------------------------------
// 10. 1000 event flush の所要計測 (記録目的・閾値 gate にしない)
// ---------------------------------------------------------------------------

describe('性能: 1000 event flush', () => {
  it('所要を計測してログ出力する (assert は正当性のみ)', async () => {
    const cardIds = [fixture.a.cardId]
    for (let i = 0; i < 9; i++) cardIds.push(await seedExtraCard(fixture.a))

    const days = [DAY_1, '2026-08-21', '2026-08-22']
    const events = Array.from({ length: 1000 }, (_, i) =>
      makeEvent(
        cardIds[i % cardIds.length]!,
        new Date(Date.parse(`${days[i % days.length]}T01:00:00.000Z`) + i * 1000),
      ),
    )

    const startedAt = performance.now()
    const res = await processAnswerEvents(userA, events, RECEIVED_AT)
    const elapsedMs = performance.now() - startedAt

    expect(res.failed).toEqual([])
    // per-card sort により全 event が昇順で fold されるため全件 applied になる。
    expect(await countApplied(events.map((e) => e.event_id))).toBe(1000)
    const rows = await readStudyDays(fixture.a.userId)
    const total = rows
      .filter((r) => days.includes(r.day))
      .reduce((sum, r) => sum + r.reviewCount, 0)
    expect(total).toBe(1000)

    console.log(
      `[perf] 1000 event flush: ${elapsedMs.toFixed(0)}ms (cards=${cardIds.length}, days=${days.length})`,
    )
  })
})
