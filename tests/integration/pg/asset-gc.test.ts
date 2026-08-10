// 画像 asset GC 日次 cron sprint(spec §3.2)— 第 1 部: SECURITY DEFINER 関数
// public.app_list_asset_gc_user_ids()(migration 0033)の behavioral 保証。
// 第 2 部(cron 本体)は Task 8 が本 file に追記する。
//
// 目的: cron lane は app role(recallmint_app)で動くが、RLS の下では tenant
// context(app.user_id)無しに assets を 1 行も読めない。app_list_asset_gc_user_ids()
// は「GC 作業のある user_id」だけを SECURITY DEFINER で横断的に返す迂回口 —
// この file はその迂回が (a) 意図した 3 arm の行だけを正しく拾い(両方向 pin)、
// (b) 権限面で cron lane 専用に閉じている(hardening pin)、(c) core reconciler
// (scripts/gc-image-assets.ts)の 3 つの WHERE と集合として同値であり続ける
// (oracle 同値性 pin)ことを固定する。
//
// 接続の使い分け(rls-functions.test.ts と同規約):
//   - 関数呼出(検証対象) = getDb()(app role recallmint_app)。
//   - seed / oracle 側の独立走査 = getFixtureOwnerDb()(owner・RLS bypass)。
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { assets, cardAssetRefs, cards, exams, users } from '@/lib/db/schema'

import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

beforeEach(async () => {
  await truncateAllUserTables()
})

// ---------------------------------------------------------------------------
// seed helpers(owner 接続。この file は tenant 横断関数を検証するため tenant tx
// を張らない — RLS-P2 の他 iso test と異なり、owner で好きな形の行を直接作る)。
// ---------------------------------------------------------------------------

async function seedUser(label: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_gc_${label}_${userId}` })
  return userId
}

type AssetOverrides = {
  status: string
  unreferencedAt: Date | null
}

async function seedAsset(userId: string, overrides: AssetOverrides): Promise<string> {
  const owner = getFixtureOwnerDb()
  const assetId = randomUUID()
  await owner.insert(assets).values({
    id: assetId,
    userId,
    objectKey: `users/${userId}/${assetId}.webp`,
    mime: 'image/webp',
    byteSize: 100,
    width: 10,
    height: 10,
    hash: `hash_${assetId}`,
    status: overrides.status,
    unreferencedAt: overrides.unreferencedAt,
  })
  return assetId
}

// referenced-ready fixture 専用: card_asset_refs FK(card_id → cards)を満たすため
// 最小 card(+ その exam)を作り、asset への参照を 1 本張る。
async function seedReferencedAsset(userId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const assetId = await seedAsset(userId, { status: 'ready', unreferencedAt: null })
  const examId = randomUUID()
  const cardId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'GC oracle exam' })
  await owner.insert(cards).values({
    id: cardId,
    userId,
    examId,
    title: 'GC oracle card',
    questionText: 'Q?',
    options: [
      { id: 'a', uid: randomUUID(), text: 'opt a', is_correct: true },
      { id: 'b', uid: randomUUID(), text: 'opt b', is_correct: false },
    ],
    correctAnswerIds: ['a'],
  })
  await owner
    .insert(cardAssetRefs)
    .values({ cardId, assetId, userId, fieldKey: 'question', ordinal: 0 })
  return assetId
}

async function callGcUserIds(): Promise<string[]> {
  const rows = await getDb().execute<{ app_list_asset_gc_user_ids: string }>(
    sql`SELECT * FROM public.app_list_asset_gc_user_ids()`,
  )
  return rows.map((r) => r.app_list_asset_gc_user_ids)
}

describe('asset GC cron — Task 1: app_list_asset_gc_user_ids() definer function (migration 0033)', () => {
  describe('両方向 pin: 返る側(3 arm の代表 fixture)', () => {
    it('returns the user when it has only a deleting asset (arm①)', async () => {
      const userId = await seedUser('deleting_only')
      await seedAsset(userId, { status: 'deleting', unreferencedAt: null })

      const result = await callGcUserIds()
      expect(result).toEqual([userId])
    })

    it('returns the user when it has only a marked (unreferenced_at set) asset (arm②)', async () => {
      const userId = await seedUser('marked_only')
      await seedAsset(userId, {
        status: 'ready',
        unreferencedAt: new Date('2026-07-01T00:00:00.000Z'),
      })

      const result = await callGcUserIds()
      expect(result).toEqual([userId])
    })

    it('returns the user when it has only a mark-candidate asset (arm③: unreferenced + unmarked)', async () => {
      const userId = await seedUser('mark_candidate_only')
      await seedAsset(userId, { status: 'ready', unreferencedAt: null })
      // NOT EXISTS(refs) を成立させるため card_asset_refs は一切張らない。

      const result = await callGcUserIds()
      expect(result).toEqual([userId])
    })
  })

  describe('両方向 pin: 返らない側', () => {
    it('does not return a user whose only asset is referenced and ready', async () => {
      const userId = await seedUser('referenced_ready_only')
      await seedReferencedAsset(userId)

      const result = await callGcUserIds()
      expect(result).toEqual([])
    })
  })

  describe('hardening pin(B-1・Codex 指摘 11): 権限 + pg_proc 直読', () => {
    it('PUBLIC has no EXECUTE; recallmint_app has EXECUTE', async () => {
      const rows = await getDb().execute<{ public_can: boolean; app_can: boolean }>(
        sql`SELECT
          has_function_privilege('public', 'public.app_list_asset_gc_user_ids()', 'EXECUTE') AS public_can,
          has_function_privilege('recallmint_app', 'public.app_list_asset_gc_user_ids()', 'EXECUTE') AS app_can`,
      )
      expect(rows[0]?.public_can).toBe(false)
      expect(rows[0]?.app_can).toBe(true)
    })

    it('is owned by postgres, is SECURITY DEFINER, and pins search_path=public', async () => {
      const rows = await getDb().execute<{
        owner: string
        prosecdef: boolean
        proconfig: string[] | null
      }>(
        sql`SELECT r.rolname AS owner, p.prosecdef, p.proconfig
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.proname = 'app_list_asset_gc_user_ids'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.owner).toBe('postgres')
      expect(rows[0]?.prosecdef).toBe(true)
      expect(rows[0]?.proconfig).toContain('search_path=public')
    })
  })

  describe('oracle 同値性 pin(B-2・Codex 指摘 12): core reconciler の 3 WHERE から独立導出した集合と一致', () => {
    it('matches the union of collect / markClear-or-promote / markSet candidates across 5 fixture states', async () => {
      const owner = getFixtureOwnerDb()

      // 5 状態(3 arm + deleted-only + referenced-ready-only)。
      const deletingUser = await seedUser('oracle_deleting')
      await seedAsset(deletingUser, { status: 'deleting', unreferencedAt: null })

      const deletedUser = await seedUser('oracle_deleted')
      await seedAsset(deletedUser, { status: 'deleted', unreferencedAt: null })

      const markedUser = await seedUser('oracle_marked')
      await seedAsset(markedUser, {
        status: 'ready',
        unreferencedAt: new Date('2026-07-01T00:00:00.000Z'),
      })

      const markCandidateUser = await seedUser('oracle_mark_candidate')
      await seedAsset(markCandidateUser, { status: 'ready', unreferencedAt: null })

      const referencedReadyUser = await seedUser('oracle_referenced_ready')
      await seedReferencedAsset(referencedReadyUser)

      // --- oracle: 関数の SQL をコピペせず、core reconciler(scripts/gc-image-assets.ts)
      // の 3 つの独立した WHERE(collect / markClear∪promote / markSet)を owner 接続で
      // 個別に走査し、JS 側で集合和を取る。関数側 SQL の drift(例: 1 arm の脱落や
      // 条件の取り違え)を検出できる形にするため、関数の WHERE 文字列は一切参照しない。
      const collectRows = await owner.execute<{ user_id: string }>(
        sql`SELECT DISTINCT user_id FROM assets WHERE status IN ('deleting', 'deleted')`,
      )
      // markClear(unreferenced_at IS NOT NULL AND EXISTS refs)と promote 対象
      // (status IN ('reserved','ready') AND unreferenced_at < now()-grace AND
      // NOT EXISTS refs)は、両者とも unreferenced_at IS NOT NULL に包含される
      // (brief 記載の同値性)。よって 1 本の独立 probe で両方をカバーする。
      const markClearOrPromoteRows = await owner.execute<{ user_id: string }>(
        sql`SELECT DISTINCT user_id FROM assets WHERE unreferenced_at IS NOT NULL`,
      )
      const markSetRows = await owner.execute<{ user_id: string }>(
        sql`SELECT DISTINCT a.user_id FROM assets a
          WHERE a.status IN ('reserved', 'ready')
            AND a.unreferenced_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM card_asset_refs r WHERE r.asset_id = a.id)`,
      )
      const oracleSet = new Set<string>([
        ...collectRows.map((r) => r.user_id),
        ...markClearOrPromoteRows.map((r) => r.user_id),
        ...markSetRows.map((r) => r.user_id),
      ])

      const functionResult = await callGcUserIds()

      expect(new Set(functionResult)).toEqual(oracleSet)
      expect(oracleSet).toEqual(
        new Set([deletingUser, deletedUser, markedUser, markCandidateUser]),
      )
      expect(oracleSet.has(referencedReadyUser)).toBe(false)
    })
  })
})
