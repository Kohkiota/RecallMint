/**
 * tests/fixtures/pull.ts
 *
 * Per-route fixtures for GET /api/pull contract tests.
 *
 * Ported from app/api/pull/route.test.ts:
 *   - makeReq (GET request builder)
 *   - Entity factories: fakeCard, fakeExam, fakeTombstone, fakeCardTag
 *   - Delta builders: fake*Delta (wrap rows + cursor into the shape getXxxDelta returns)
 *   - EMPTY_PULL_BODY (zero-rows response shape for snapshot baseline)
 *
 * The pull route has no DB writes, so no fake-tx/fakeDb builder is needed.
 * Mocking getCurrentUser + the six delta functions covers the handler only
 * while since_card_tags is absent; with since_card_tags + non-empty cards the
 * route also calls getCardTagsByCardIds (authoritative replace), which must be
 * mocked *and* given a resolved value or the route 500s.
 */

import type {
  ClientCard,
  ClientExam,
  ClientTagCategory,
  ClientTagOption,
  ClientCardTag,
} from '@/lib/client-db'
import type { ClientTombstone } from '@/lib/db/tombstones-pull'
import type { User } from '@/lib/db/schema'
import { FIXED_USER_ID } from './common'

// ─── Fake user ────────────────────────────────────────────────────────────

export const FAKE_USER = { id: FIXED_USER_ID } as unknown as User

// ─── Request builder ──────────────────────────────────────────────────────

/** GET request for /api/pull, optionally with query params. */
export function makeReq(url = 'http://x/api/pull'): Request {
  return new Request(url)
}

// ─── Delta builders ───────────────────────────────────────────────────────
// Match the return shape of getCardsDelta / getExamsDelta / etc.

export function fakeCardsDelta(
  rows: ClientCard[] = [],
  maxUpdatedAt: string | null = null,
) {
  return { rows, maxUpdatedAt }
}

export function fakeExamsDelta(
  rows: ClientExam[] = [],
  maxUpdatedAt: string | null = null,
) {
  return { rows, maxUpdatedAt }
}

export function fakeTombstonesDelta(
  rows: ClientTombstone[] = [],
  maxDeletedAt: string | null = null,
) {
  return { rows, maxDeletedAt }
}

export function fakeCategoriesDelta(
  rows: ClientTagCategory[] = [],
  maxUpdatedAt: string | null = null,
) {
  return { rows, maxUpdatedAt }
}

export function fakeOptionsDelta(
  rows: ClientTagOption[] = [],
  maxUpdatedAt: string | null = null,
) {
  return { rows, maxUpdatedAt }
}

export function fakeCardTagsDelta(
  rows: ClientCardTag[] = [],
  maxCreatedAt: string | null = null,
) {
  return { rows, maxCreatedAt }
}

// ─── Entity factories ─────────────────────────────────────────────────────

export function fakeCard(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: FIXED_USER_ID,
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'Q1',
    question_label: null,
    base_order: 1024,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-05-26T10:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

export function fakeExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: FIXED_USER_ID,
    name: 'Test Exam',
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

export function fakeTombstone(
  overrides?: Partial<ClientTombstone>,
): ClientTombstone {
  return {
    entity_type: 'card',
    entity_id: 'card-deleted-1',
    deleted_at: '2026-05-03T00:00:00.000Z',
    ...overrides,
  }
}

export function fakeCardTag(
  overrides?: Partial<ClientCardTag>,
): ClientCardTag {
  return {
    card_id: 'card-1',
    option_id: 'opt-1',
    user_id: FIXED_USER_ID,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

// ─── Empty response body ──────────────────────────────────────────────────
// Zero-rows snapshot baseline — all cursors null, all arrays empty.

export const EMPTY_PULL_BODY = {
  cards: [],
  exams: [],
  tombstones: [],
  tag_categories: [],
  tag_options: [],
  card_tags: [],
  cursors: {
    cards: null,
    exams: null,
    tombstone: null,
    tag_categories: null,
    tag_options: null,
    card_tags: null,
  },
} as const
