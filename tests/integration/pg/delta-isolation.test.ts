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
//
// card_tags delta 完全性 fix(2026-08-17 spec)で describe を 4 本追加した。spec 対応:
// - §4-3 = getCardTagsByCardIds を owner 接続(RLS bypass)で呼ぶ第 1 層 pin
//   (明示 predicate 単独で隔離が成立することの証明)
// - §4-4 = getCardTagsByCardIds を asTenant で呼ぶ positive / negative の 2 本
//   (predicate + RLS 重畳の通常経路。既存 6 delta と同形)
// - backstop = §4-4 とは別の追加 pin(brief 指定)。userId=B を渡して RLS 単独の遮断を見る
// - §4-5 = I-4(b) が前提にする「全件 fallback に LIMIT / 時間窓等の filter が無い」ことの
//   機械化(file 末尾の専用 describe)
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cardTags, tagOptions, tombstones } from '@/lib/db/schema'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { getCategoriesDelta } from '@/lib/db/tag-categories-pull'
import { getOptionsDelta } from '@/lib/db/tag-options-pull'
import { getCardTagsByCardIds, getCardTagsDelta } from '@/lib/db/card-tags-pull'
import { getAllStudyDaysForUser } from '@/lib/db/study-days-pull'
import type { TenantDb } from '@/lib/db/tenant-tx'

import { asTenant } from './setup/as-tenant'
import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// card_tags の assert は配列順序を契約にしない(spec §4-8): (card_id, option_id) の
// 集合として比較する。件数一致だけの assert は欠落と重複追加が相殺するため使わない。
function pairSet(rows: { card_id: string; option_id: string }[]): string[] {
  return rows.map((r) => `${r.card_id}|${r.option_id}`).sort()
}

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

    // 既知 id の取得は ground-truth read(A/B 双方の行を跨いで拾う)。RLS-P2:
    // owner 接続で RLS を bypass して両テナントの tombstone を読む。
    const owner = getFixtureOwnerDb()
    const aRows = await owner
      .select()
      .from(tombstones)
      .where(eq(tombstones.userId, fixture.a.userId))
    const bRows = await owner
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
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getCardsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.cardId)
    })

    it('does not leak tenant B card into tenant A delta (negative)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getCardsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.cardId)
    })
  })

  // --- 非 RED・best-effort: cards と同 factory・同 pattern(cursor = updatedAt)。---
  describe('getExamsDelta', () => {
    it('returns tenant A own exam (positive control)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getExamsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.examId)
    })

    it('does not leak tenant B exam into tenant A delta (negative)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getExamsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.examId)
    })
  })

  // --- 非 RED・best-effort: cursor = deletedAt。既知 id は beforeAll の raw select 由来。---
  describe('getTombstonesDelta', () => {
    it('returns tenant A own tombstone (positive control)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getTombstonesDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.entity_id)).toContain(aTombstoneEntityId)
    })

    it('does not leak tenant B tombstone into tenant A delta (negative)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getTombstonesDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.entity_id)).not.toContain(bTombstoneEntityId)
    })
  })

  // --- 非 RED・best-effort: cursor = updatedAt。---
  describe('getCategoriesDelta', () => {
    it('returns tenant A own tag category (positive control)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getCategoriesDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.tagCategoryId)
    })

    it('does not leak tenant B tag category into tenant A delta (negative)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getCategoriesDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.tagCategoryId)
    })
  })

  // --- 非 RED・best-effort: cursor = updatedAt。---
  describe('getOptionsDelta', () => {
    it('returns tenant A own tag option (positive control)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getOptionsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.tagOptionId)
    })

    it('does not leak tenant B tag option into tenant A delta (negative)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getOptionsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.tagOptionId)
    })
  })

  // --- 非 RED・best-effort: card_tags は id を持たない junction。cursor = createdAt。
  // 既知 id として fixture の cardId(card_tags.card_id)を使う。---
  describe('getCardTagsDelta', () => {
    it('returns tenant A own card_tag (positive control)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getCardTagsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.card_id)).toContain(fixture.a.cardId)
    })

    it('does not leak tenant B card_tag into tenant A delta (negative)', async () => {
      const { rows } = await asTenant(fixture.a.userId, (tx) =>
        getCardTagsDelta(fixture.a.userId, tx, since),
      )
      expect(rows.map((r) => r.card_id)).not.toContain(fixture.b.cardId)
    })
  })

  // --- I-3 第 1 層(明示 predicate 単独)の behavioral 証明。RLS を bypass する owner
  // 接続を dbc に渡し、cardIds に B の card を混ぜても B 行が返らないことを pin する。
  // RLS が覆い隠せない経路なので、eq(cardTags.userId, userId) 単独で隔離が成立して
  // いることの証明になる(rls-single-defense.test.ts「RLS 単独」の対称形)。---
  describe('getCardTagsByCardIds (owner connection = RLS bypass)', () => {
    it('returns only tenant A pairs when tenant B card id is mixed into cardIds', async () => {
      // test 限定 cast: getFixtureOwnerDb() は schema 未設定の drizzle instance だが、
      // helper が使うのは select/from/where のみで TenantDb と構造互換。
      const ownerDb = getFixtureOwnerDb() as unknown as TenantDb
      const rows = await getCardTagsByCardIds(fixture.a.userId, ownerDb, [
        fixture.a.cardId,
        fixture.b.cardId,
      ])
      expect(pairSet(rows)).toEqual([`${fixture.a.cardId}|${fixture.a.tagOptionId}`])
    })
  })

  // --- 通常経路(app role + tenant context = predicate と RLS の重畳)。---
  describe('getCardTagsByCardIds (asTenant)', () => {
    it('returns tenant A own card_tag (positive control)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getCardTagsByCardIds(fixture.a.userId, tx, [fixture.a.cardId]),
      )
      expect(pairSet(rows)).toEqual([`${fixture.a.cardId}|${fixture.a.tagOptionId}`])
    })

    it('does not leak tenant B card_tag when B card id is requested (negative)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getCardTagsByCardIds(fixture.a.userId, tx, [fixture.b.cardId]),
      )
      expect(pairSet(rows)).toEqual([])
    })
  })

  // --- 第 2 層(RLS)単独の pin。spec §4-4(直上の通常経路)とは別の追加 pin。
  // predicate は B 行を候補にする(userId=B を渡す)が、tenant context = A の RLS が
  // 遮断する。predicate にマスクされない構成そのもので第 2 層を見ているため、
  // policy 無効化の変異注入は行わない(OT 裁定 2)。---
  describe('getCardTagsByCardIds (RLS backstop)', () => {
    it('returns nothing when tenant B rows are requested inside tenant A context', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getCardTagsByCardIds(fixture.b.userId, tx, [fixture.b.cardId]),
      )
      expect(pairSet(rows)).toEqual([])
    })
  })

  // --- 非 RED・best-effort: getDeltaRows を経由しない別 endpoint(cursor 無・90 日窓)。
  // rows は user_id を直接持つため、R1 の getReviewStatsForUser と違い decoy 差分
  // 設定は不要(id 直接比較で足りる)。---
  describe('getAllStudyDaysForUser', () => {
    // todayInJst(now) = '2026-07-18'(fixture の study_days.day と一致させる)。
    const now = new Date('2026-07-18T12:00:00.000Z')

    it('returns tenant A own study day (positive control)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getAllStudyDaysForUser(fixture.a.userId, tx, now),
      )
      expect(rows.map((r) => r.user_id)).toContain(fixture.a.userId)
    })

    it('does not leak tenant B study day into tenant A result (negative)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        getAllStudyDaysForUser(fixture.a.userId, tx, now),
      )
      expect(rows.map((r) => r.user_id)).not.toContain(fixture.b.userId)
    })
  })
})

// I-4(b)(since_card_tags 欠落 = 全件 fallback は単独で authoritative snapshot)の
// 前提を機械化する(spec §4-5)。pin するのは「静的データに対する、owner 以外の絞り込みを
// 持たない全件契約」であって snapshot 同時性ではない。専用 describe にするのは、A へ
// 2 本目の card_tag を足す追加 seed を上の共有 fixture に混ぜないため(1 行だけでは
// 行数制限の変異を検出できない)。
// この describe は file 末尾に置く — beforeAll の truncate/reseed が上の共有 fixture を
// 壊すため、下に describe を足すとその test が壊れる(vitest は宣言順に直列実行)。
describe('card_tags full-stream contract (since 無し)', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    const owner = getFixtureOwnerDb()
    const extraOptionId = randomUUID()
    await owner.insert(tagOptions).values({
      id: extraOptionId,
      userId: fixture.a.userId,
      categoryId: fixture.a.tagCategoryId,
      name: 'Option 2',
    })
    // created_at を明示的に十分過去へ置く: default now() のままだと 2 行が同時刻に並び、
    // 行数制限の変異しか検出できない(時間窓 filter の混入を素通りさせる)。
    await owner.insert(cardTags).values({
      cardId: fixture.a.cardId,
      optionId: extraOptionId,
      userId: fixture.a.userId,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    })
  })

  it('returns every card_tag row of tenant A (set match against owner ground truth)', async () => {
    // ground-truth read と delta read を同一 test 内で行う(describe 間の実行順に
    // 依存しない)。owner 接続は RLS を bypass するので A の全行が真値として読める。
    const truth = await getFixtureOwnerDb()
      .select()
      .from(cardTags)
      .where(eq(cardTags.userId, fixture.a.userId))
    const { rows } = await asTenant(fixture.a.userId, (tx) =>
      getCardTagsDelta(fixture.a.userId, tx, undefined),
    )

    // seed 前提の確認(2 行かつ created_at が離れていないと行数制限 / 時間窓の変異を
    // 検出できない)。契約の assert は次行の集合一致。
    expect(truth).toHaveLength(2)
    expect(pairSet(rows)).toEqual(truth.map((r) => `${r.cardId}|${r.optionId}`).sort())
  })
})
