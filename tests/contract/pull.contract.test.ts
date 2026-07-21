/**
 * tests/contract/pull.contract.test.ts
 *
 * Wire-contract snapshot for GET /api/pull.
 *
 * Frozen faces (spec §3.2 pull row + audit §A):
 *   - Happy path: all 6 stream keys + cursor names + cursor asymmetries
 *     (tombstone cursor = singular key / card_tags cursor = maxCreatedAt)
 *   - tombstones covering all 4 entity_types (exam, card, tag_category, tag_option)
 *   - Cache-Control: no-store header (explicit assertion on every case)
 *   - 401 unauthenticated
 *   - 500 internal error
 *   - 未同期 200-empty-body (Clerk session valid but users row not yet synced)
 *
 * NOT frozen (§A-excluded):
 *   - user_settings (not in pull's 6 streams)
 *   - card_tags "解除補完" (client-side apply behavior, not server response)
 *   - timing/ops payloads
 *
 * All data is fully deterministic: fixture factories use fixed timestamps/IDs
 * so running `pnpm test:contract` twice produces identical .snap content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'

// ── Mocks (must be declared before importing the route handler) ──────────────
vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/db/cards-pull', () => ({
  getCardsDelta: vi.fn(),
}))
vi.mock('@/lib/db/exams-pull', () => ({
  getExamsDelta: vi.fn(),
}))
vi.mock('@/lib/db/tombstones-pull', () => ({
  getTombstonesDelta: vi.fn(),
}))
vi.mock('@/lib/db/tag-categories-pull', () => ({
  getCategoriesDelta: vi.fn(),
}))
vi.mock('@/lib/db/tag-options-pull', () => ({
  getOptionsDelta: vi.fn(),
}))
vi.mock('@/lib/db/card-tags-pull', () => ({
  getCardTagsDelta: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
// RLS-P2: route は withTenantTx(userId, ...) で 6 delta を 1 tx に包む。contract
// test では DB に触れないよう getDb を stub し、withTenantTx は fn(fakeTx) を直呼び
// する (context 設定は挙動不変・wire snapshot も不変)。
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: vi.fn(),
}))

// ── Route under test ──────────────────────────────────────────────────────────
import { GET } from '../../app/api/pull/route'
import { withTenantTx } from '@/lib/db/tenant-tx'

// ── Mocked dependency handles ─────────────────────────────────────────────────
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { getCategoriesDelta } from '@/lib/db/tag-categories-pull'
import { getOptionsDelta } from '@/lib/db/tag-options-pull'
import { getCardTagsDelta } from '@/lib/db/card-tags-pull'

// ── Fixtures ──────────────────────────────────────────────────────────────────
import {
  FAKE_USER,
  makeReq,
  fakeCard,
  fakeExam,
  fakeTombstone,
  fakeCardTag,
  fakeCardsDelta,
  fakeExamsDelta,
  fakeTombstonesDelta,
  fakeCategoriesDelta,
  fakeOptionsDelta,
  fakeCardTagsDelta,
  EMPTY_PULL_BODY,
} from '../fixtures/pull'
import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'

// ─── Fake tag entities (not in fixtures/pull.ts, but minimal inline ──────────

function fakeCategory(
  overrides?: Partial<ClientTagCategory>,
): ClientTagCategory {
  return {
    id: 'cat-1',
    user_id: FAKE_USER.id,
    name: 'Category 1',
    select_type: 'single',
    color: null,
    sort_key: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    ...overrides,
  }
}

function fakeOption(overrides?: Partial<ClientTagOption>): ClientTagOption {
  return {
    id: 'opt-1',
    user_id: FAKE_USER.id,
    category_id: 'cat-1',
    name: 'Option 1',
    color: null,
    sort_key: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    ...overrides,
  }
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // withTenantTx は fakeTx を callback に渡して直呼び (afterEach の restoreAllMocks で
  // impl が消えるため毎 test 再設定する)。
  vi.mocked(withTenantTx).mockImplementation((_userId, fn) =>
    fn(undefined as unknown as never),
  )
  // Default: card_tags stream empty (matches existing unit test pattern)
  vi.mocked(getCardTagsDelta).mockResolvedValue(fakeCardTagsDelta())
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Helper: wire all 6 delta mocks in one call ───────────────────────────────

function mockAllDeltas({
  cards = fakeCardsDelta(),
  exams = fakeExamsDelta(),
  tombstones = fakeTombstonesDelta(),
  categories = fakeCategoriesDelta(),
  options = fakeOptionsDelta(),
  cardTags = fakeCardTagsDelta(),
} = {}) {
  vi.mocked(getCardsDelta).mockResolvedValue(cards)
  vi.mocked(getExamsDelta).mockResolvedValue(exams)
  vi.mocked(getTombstonesDelta).mockResolvedValue(tombstones)
  vi.mocked(getCategoriesDelta).mockResolvedValue(categories)
  vi.mocked(getOptionsDelta).mockResolvedValue(options)
  vi.mocked(getCardTagsDelta).mockResolvedValue(cardTags)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/pull — wire contract', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Happy path: all 6 streams populated, tombstones cover 4 entity_types,
  // cursor asymmetry (tombstone singular key / card_tags maxCreatedAt) visible.
  // ───────────────────────────────────────────────────────────────────────────
  it('happy path: 6 stream keys + cursor asymmetry + Cache-Control: no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    // tombstones: all 4 entity_types (§A #5 — DDD-move risk, must be frozen)
    const tombstoneRows = [
      fakeTombstone({ entity_type: 'exam', entity_id: 'exam-deleted-1', deleted_at: '2026-05-10T01:00:00.000Z' }),
      fakeTombstone({ entity_type: 'card', entity_id: 'card-deleted-1', deleted_at: '2026-05-10T02:00:00.000Z' }),
      fakeTombstone({ entity_type: 'tag_category', entity_id: 'cat-deleted-1', deleted_at: '2026-05-10T03:00:00.000Z' }),
      fakeTombstone({ entity_type: 'tag_option', entity_id: 'opt-deleted-1', deleted_at: '2026-05-10T04:00:00.000Z' }),
    ]

    mockAllDeltas({
      cards: fakeCardsDelta(
        [fakeCard({ id: 'card-1', updated_at: '2026-06-01T00:00:00.000Z' })],
        '2026-06-01T00:00:00.000Z',
      ),
      exams: fakeExamsDelta(
        [fakeExam({ id: 'exam-1', updated_at: '2026-06-02T00:00:00.000Z' })],
        '2026-06-02T00:00:00.000Z',
      ),
      tombstones: fakeTombstonesDelta(tombstoneRows, '2026-05-10T04:00:00.000Z'),
      categories: fakeCategoriesDelta(
        [fakeCategory({ id: 'cat-1', updated_at: '2026-06-03T00:00:00.000Z' })],
        '2026-06-03T00:00:00.000Z',
      ),
      options: fakeOptionsDelta(
        [fakeOption({ id: 'opt-1', updated_at: '2026-06-04T00:00:00.000Z' })],
        '2026-06-04T00:00:00.000Z',
      ),
      cardTags: fakeCardTagsDelta(
        [fakeCardTag({ card_id: 'card-1', option_id: 'opt-1', created_at: '2026-06-05T00:00:00.000Z' })],
        '2026-06-05T00:00:00.000Z',
      ),
    })

    const res = await GET(makeReq())

    // Explicit Cache-Control assertion (not snapshot — we want a hard fail if removed)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.status).toBe(200)

    // Snapshot the wire body — captures:
    //   • 6 stream keys (cards/exams/tombstones/tag_categories/tag_options/card_tags)
    //   • cursor keys: cards/exams/tombstone(singular)/tag_categories/tag_options/card_tags
    //   • cursor asymmetry: tombstone=maxDeletedAt, card_tags=maxCreatedAt, others=maxUpdatedAt
    //   • tombstones with all 4 entity_types
    //   §A #6: data key "tombstones" (plural) vs cursor key "tombstone" (singular)
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 未同期: Clerk session valid but users row not yet synced → 200 + empty body
  // §A #12: all 6 arrays empty, all 6 cursors null (including singular tombstone key)
  // ───────────────────────────────────────────────────────────────────────────
  it('未同期 (user=null): 200 + empty body + Cache-Control: no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await GET(makeReq())

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.status).toBe(200)

    const body = await res.json()
    // Explicit structural check against EMPTY_PULL_BODY constant
    expect(body).toEqual(EMPTY_PULL_BODY)
    // Snapshot the exact wire JSON (including singular "tombstone" cursor key)
    expect(body).toMatchSnapshot()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 401: Unauthenticated (UnauthenticatedError thrown by getCurrentUser)
  // ───────────────────────────────────────────────────────────────────────────
  it('401: unauthenticated + Cache-Control: no-store', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())

    const res = await GET(makeReq())

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.status).toBe(401)

    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 500: Internal error (unexpected auth error or DB error)
  // ───────────────────────────────────────────────────────────────────────────
  it('500: unexpected auth error + Cache-Control: no-store', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('clerk down'))

    const res = await GET(makeReq())

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('500: DB error after auth + Cache-Control: no-store', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    vi.mocked(getCardsDelta).mockRejectedValue(new Error('neon down'))
    vi.mocked(getExamsDelta).mockResolvedValue(fakeExamsDelta())
    vi.mocked(getTombstonesDelta).mockResolvedValue(fakeTombstonesDelta())
    vi.mocked(getCategoriesDelta).mockResolvedValue(fakeCategoriesDelta())
    vi.mocked(getOptionsDelta).mockResolvedValue(fakeOptionsDelta())

    const res = await GET(makeReq())

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body).toMatchSnapshot()
  })
})
