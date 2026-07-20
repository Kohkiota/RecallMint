// R2: delta 混入 隔離 assertion。pull(delta 同期)が「A の since で引いた delta に
// B の行を混ぜない」(negative)かつ「A 自身の行は返る」(positive control)ことを
// 実 PG で検証する。
//
// 代表 RED = getCardsDelta(lib/db/cards-pull.ts)経由の getDeltaRows
// (lib/db/pull-delta.ts)。6 stream(cards/exams/tombstones/tag_categories/
// tag_options/card_tags)は同一 factory `getDeltaRows` の
// `conds = [eq(config.userIdCol, userId), ...since]` を通るため、cards はその代表。
// 他 5 stream + getAllStudyDaysForUser(別 endpoint・cursor 無)は非 RED・best-effort。
//
// since 境界値: delta は `gte(cursorCol, since)`。fixture の行は seed 時刻(~now)の
// updated_at/created_at を持つため、`since` を十分過去(2020-01-01)に固定すれば
// A/B 双方が候補になり、timestamp 同値・tz による偶然除外を避けられる
// (cards の getCardsForExam のような examId shadow は delta には無い: userId + since のみ)。
//
// read-only test ゆえ beforeAll で truncate→seed を 1 回のみ(per-test reset 不要)。
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { tombstones } from '@/lib/db/schema'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { getCategoriesDelta } from '@/lib/db/tag-categories-pull'
import { getOptionsDelta } from '@/lib/db/tag-options-pull'
import { getCardTagsDelta } from '@/lib/db/card-tags-pull'
import { getAllStudyDaysForUser } from '@/lib/db/study-days-pull'

import {
  type TenantFixture,
  closeFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

describe('delta isolation (R2)', () => {
  let fixture: TenantFixture
  // decoy 適格性: since を十分過去に固定し、A/B 双方の gte(cursorCol, since) を
  // 確実に成立させる(境界値の偶然除外を避ける)。
  const since = new Date('2020-01-01T00:00:00.000Z')

  // tombstones.entity_id は fixture 内で randomUUID() 採番され TenantFixture では
  // 追跡されない(cards/exams/tag_* のような既知 id が無い)。既知 id として使うため、
  // seed 直後に raw select で A/B それぞれの entity_id を取得しておく。
  let aTombstoneEntityId: string
  let bTombstoneEntityId: string

  beforeAll(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()

    const db = getDb()
    const aRows = await db
      .select()
      .from(tombstones)
      .where(eq(tombstones.userId, fixture.a.userId))
    const bRows = await db
      .select()
      .from(tombstones)
      .where(eq(tombstones.userId, fixture.b.userId))
    aTombstoneEntityId = aRows[0].entityId
    bTombstoneEntityId = bRows[0].entityId
  })

  // --- 代表 RED: getDeltaRows の eq(config.userIdCol, userId) を外すと B の card が
  // A の delta に漏れる(6 stream 単一 factory の代表)。---
  describe('getCardsDelta', () => {
    it('returns tenant A own card (positive control)', async () => {
      const { rows } = await getCardsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).toContain(fixture.a.cardId)
    })

    it('does not leak tenant B card into tenant A delta (negative)', async () => {
      const { rows } = await getCardsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.cardId)
    })
  })

  // --- 非 RED・best-effort: cards と同 factory・同 pattern(cursor = updatedAt)。---
  describe('getExamsDelta', () => {
    it('returns tenant A own exam (positive control)', async () => {
      const { rows } = await getExamsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).toContain(fixture.a.examId)
    })

    it('does not leak tenant B exam into tenant A delta (negative)', async () => {
      const { rows } = await getExamsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.examId)
    })
  })

  // --- 非 RED・best-effort: cursor = deletedAt。既知 id は beforeAll の raw select 由来。---
  describe('getTombstonesDelta', () => {
    it('returns tenant A own tombstone (positive control)', async () => {
      const { rows } = await getTombstonesDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.entity_id)).toContain(aTombstoneEntityId)
    })

    it('does not leak tenant B tombstone into tenant A delta (negative)', async () => {
      const { rows } = await getTombstonesDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.entity_id)).not.toContain(bTombstoneEntityId)
    })
  })

  // --- 非 RED・best-effort: cursor = updatedAt。---
  describe('getCategoriesDelta', () => {
    it('returns tenant A own tag category (positive control)', async () => {
      const { rows } = await getCategoriesDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).toContain(fixture.a.tagCategoryId)
    })

    it('does not leak tenant B tag category into tenant A delta (negative)', async () => {
      const { rows } = await getCategoriesDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.tagCategoryId)
    })
  })

  // --- 非 RED・best-effort: cursor = updatedAt。---
  describe('getOptionsDelta', () => {
    it('returns tenant A own tag option (positive control)', async () => {
      const { rows } = await getOptionsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).toContain(fixture.a.tagOptionId)
    })

    it('does not leak tenant B tag option into tenant A delta (negative)', async () => {
      const { rows } = await getOptionsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.tagOptionId)
    })
  })

  // --- 非 RED・best-effort: card_tags は id を持たない junction。cursor = createdAt。
  // 既知 id として fixture の cardId(card_tags.card_id)を使う。---
  describe('getCardTagsDelta', () => {
    it('returns tenant A own card_tag (positive control)', async () => {
      const { rows } = await getCardTagsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.card_id)).toContain(fixture.a.cardId)
    })

    it('does not leak tenant B card_tag into tenant A delta (negative)', async () => {
      const { rows } = await getCardTagsDelta(fixture.a.userId, getDb(), since)
      expect(rows.map((r) => r.card_id)).not.toContain(fixture.b.cardId)
    })
  })

  // --- 非 RED・best-effort: getDeltaRows を経由しない別 endpoint(cursor 無・90 日窓)。
  // rows は user_id を直接持つため、R1 の getReviewStatsForUser と違い decoy 差分
  // 設定は不要(id 直接比較で足りる)。---
  describe('getAllStudyDaysForUser', () => {
    // todayInJst(now) = '2026-07-18'(fixture の study_days.day と一致させる)。
    const now = new Date('2026-07-18T12:00:00.000Z')

    it('returns tenant A own study day (positive control)', async () => {
      const rows = await getAllStudyDaysForUser(fixture.a.userId, getDb(), now)
      expect(rows.map((r) => r.user_id)).toContain(fixture.a.userId)
    })

    it('does not leak tenant B study day into tenant A result (negative)', async () => {
      const rows = await getAllStudyDaysForUser(fixture.a.userId, getDb(), now)
      expect(rows.map((r) => r.user_id)).not.toContain(fixture.b.userId)
    })
  })
})
