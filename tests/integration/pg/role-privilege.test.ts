// RLS-P1 Task 3: least-privilege 構造的証明。code-under-test (getDb()) が
// owner (postgres) でなく非所有者 app role (recallmint_app) で接続していること、
// および grants ファイル (db/roles/recallmint_app-grants.sql) が意図した境界
// (table SELECT/INSERT/UPDATE/DELETE + schema USAGE のみ) を実際に作っている
// ことを実 PG で確認する。
//
// truncate/seed は harness owner 接続(fixture.ts の getFixtureOwnerDb 経由)で
// 行う — app role には TRUNCATE 権限が無いため。CRUD/DDL assertion 自体は
// getDb()(app role)で実行する。
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'

import { asTenant } from './setup/as-tenant'
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

// negative op が「権限拒否」で reject したことを判定する。SQLSTATE 42501
// (insufficient_privilege) を優先し、 環境差 (message 文言のゆらぎ) に備えて
// message 正規表現も OR で許容する。 op が reject しない場合はこの helper 自体が
// throw して test を落とす(vacuous pass を防ぐ)。
//
// drizzle-orm postgres-js driver は raw postgres-js の PostgresError(SQLSTATE
// を持つ `.code`)を DrizzleQueryError でラップし、 元 error は `.cause` に載る
// (drizzle-orm/errors.js)。 top-level とバージョン差を考慮し `.cause` chain の
// 両方を見る。
function permissionSemanticsIn(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === '42501') return true
  if (/permission denied|must be owner|insufficient/i.test(message)) return true
  const cause = (err as { cause?: unknown } | undefined)?.cause
  return cause !== undefined && cause !== err ? permissionSemanticsIn(cause) : false
}

async function assertRejectsWithPermissionDenied(
  op: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown
  try {
    await op()
  } catch (e) {
    caught = e
  }
  expect(caught, 'expected the operation to reject').toBeDefined()
  expect(
    permissionSemanticsIn(caught),
    `expected permission-denied semantics, got ${String(caught)}`,
  ).toBe(true)
}

describe('role privilege (least-privilege structural proof)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  // --- 恒久: code-under-test は owner でなく app role で接続する ---
  it('connects as recallmint_app (not the owner)', async () => {
    const rows = await getDb().execute<{ current_user: string }>(
      sql`SELECT current_user`,
    )
    expect(rows[0]?.current_user).toBe('recallmint_app')
  })

  // --- relowner: cards table の所有者は postgres のまま(app role に譲渡していない) ---
  it('does not own the cards table (relowner stays postgres)', async () => {
    const rows = await getDb().execute<{ relowner: string }>(
      sql`SELECT relowner::regrole::text AS relowner FROM pg_class WHERE relname = 'cards'`,
    )
    expect(rows[0]?.relowner).not.toBe('recallmint_app')
    expect(rows[0]?.relowner).toBe('postgres')
  })

  // --- negative: grant されていない operation は全て permission denied で拒否される ---
  describe('negative: privileged operations are rejected', () => {
    it('rejects CREATE TABLE (no CREATE on schema public)', async () => {
      await assertRejectsWithPermissionDenied(() =>
        getDb().execute(sql`CREATE TABLE public.rls_p1_probe (id int)`),
      )
    })

    it('rejects TRUNCATE (not granted; only SELECT/INSERT/UPDATE/DELETE)', async () => {
      await assertRejectsWithPermissionDenied(() =>
        getDb().execute(sql`TRUNCATE cards`),
      )
    })

    it('rejects ALTER TABLE ADD COLUMN (requires ownership)', async () => {
      await assertRejectsWithPermissionDenied(() =>
        getDb().execute(sql`ALTER TABLE cards ADD COLUMN rls_p1_probe int`),
      )
    })

    it('rejects DROP TABLE (requires ownership)', async () => {
      await assertRejectsWithPermissionDenied(() =>
        getDb().execute(sql`DROP TABLE cards`),
      )
    })

    it('rejects CREATE POLICY (requires ownership)', async () => {
      await assertRejectsWithPermissionDenied(() =>
        getDb().execute(sql`CREATE POLICY rls_p1_probe ON cards USING (true)`),
      )
    })

    it('rejects SET ROLE postgres (not a member of role postgres)', async () => {
      await assertRejectsWithPermissionDenied(() =>
        getDb().execute(sql`SET ROLE postgres`),
      )
    })
  })

  // --- positive: granted CRUD (SELECT/INSERT/UPDATE/DELETE) 全て succeed ---
  describe('positive: granted CRUD operations succeed', () => {
    // CRUD は RLS 対象表 (cards) への行アクセスゆえ tenant context が要る。
    // grant の positive 証明が主眼なので app-role + context (asTenant) で走らせる。
    it('selects a seeded card', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .select({ id: cards.id, title: cards.title })
          .from(cards)
          .where(eq(cards.id, fixture.a.cardId)),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.title).toBe('Card A')
    })

    it('inserts, updates, and deletes a card for the seeded tenant', async () => {
      const newCardId = randomUUID()

      await asTenant(fixture.a.userId, async (db) => {
        await db.insert(cards).values({
          id: newCardId,
          userId: fixture.a.userId,
          examId: fixture.a.examId,
          sourceDocumentId: fixture.a.sourceDocumentId,
          title: 'RLS-P1 probe card',
          questionText: 'Q?',
          options: [
            { id: 'a', uid: randomUUID(), text: 'opt a', is_correct: true },
            { id: 'b', uid: randomUUID(), text: 'opt b', is_correct: false },
          ],
          correctAnswerIds: ['a'],
          ...initialFsrsState(new Date()),
        })

        const inserted = await db
          .select({ title: cards.title })
          .from(cards)
          .where(eq(cards.id, newCardId))
        expect(inserted[0]?.title).toBe('RLS-P1 probe card')

        await db
          .update(cards)
          .set({ title: 'RLS-P1 probe card (updated)' })
          .where(eq(cards.id, newCardId))

        const updated = await db
          .select({ title: cards.title })
          .from(cards)
          .where(eq(cards.id, newCardId))
        expect(updated[0]?.title).toBe('RLS-P1 probe card (updated)')

        await db.delete(cards).where(eq(cards.id, newCardId))

        const afterDelete = await db
          .select({ id: cards.id })
          .from(cards)
          .where(eq(cards.id, newCardId))
        expect(afterDelete).toHaveLength(0)
      })
    })
  })
})
