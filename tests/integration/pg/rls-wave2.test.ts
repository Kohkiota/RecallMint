// RLS-P3 Wave 2 — 軽配線 5 表の RLS 単独防御 + WITH CHECK + loud + 配線経路 (DB 層)。
//
// 対象 5 表: study_sessions / user_settings / assets / source_documents / upload_records。
// 各表の残存 raw getDb 経路を withTenantTx で context 下に入れた後に policy を張った
// (Step 0 §5.3 Wave 2)。本 file は policy の behavioral 実効を Wave 1 (rls-wave1.test.ts) と
// 同型に pin する:
//   - read (USING) : eq(userId) を意図的に外した select → A 行のみ・B 非混在。
//   - write (USING): user_id 述語なしで B を狙う → 0 行 (USING が B を A から不可視化)。
//   - WITH CHECK   : user_id=B の insert → 42501 / A 行を B へ付替える update → 42501。
//   - loud (P0RLS) : context 未設定で read/write → app_current_user_id() が RAISE。
//   刺激 = app-role + tenant context (asTenant)。観測/seed = owner (RLS bypass)。
//
// 配線経路 (DB 層): asTenant で wire 済関数/query を直呼びし RLS-on 下で従来どおり動くこと
// (P0RLS/42501 なし + owner 観測で A のみ変化)。route/action/page の caller 配線完全性は
// canonical review + Task 6 の機械 re-grep + build が担保 (iso では Next 境界を叩かない)。
//
// mutating test ゆえ beforeEach で truncate→seed。upload_records の id は TenantFixture に
// 無いため owner で拾う。
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import {
  assets,
  sourceDocuments,
  studySessions,
  uploadRecords,
  userSettings,
  type User,
} from '@/lib/db/schema'
import { getCurrentMonthOcrPages } from '@/lib/ai-usage-mcq'
import { upsertSessionGuarded } from '@/lib/reviews/session-repository'

import { asTenant } from './setup/as-tenant'
import {
  assertRejectsWithP0RLS,
  assertRejectsWithRlsViolation,
} from './setup/rls-assert'
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

describe('RLS Wave 2 single-defense (study_sessions/user_settings/assets/source_documents/upload_records)', () => {
  let fixture: TenantFixture
  // upload_records.id は TenantFixture に含まれないため owner で拾う (write 代表用)。
  let aUploadRecordId: string
  let bUploadRecordId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    const owner = getFixtureOwnerDb()
    const [aUp] = await owner
      .select({ id: uploadRecords.id })
      .from(uploadRecords)
      .where(eq(uploadRecords.userId, fixture.a.userId))
    const [bUp] = await owner
      .select({ id: uploadRecords.id })
      .from(uploadRecords)
      .where(eq(uploadRecords.userId, fixture.b.userId))
    aUploadRecordId = aUp!.id
    bUploadRecordId = bUp!.id
  })

  // ------------------------------------------------------------------ reads
  describe('read (SELECT with no user_id predicate): A sees own only, never B', () => {
    it('study_sessions', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: studySessions.sessionId, userId: studySessions.userId }).from(studySessions),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.studySessionId)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.studySessionId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('user_settings', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: userSettings.userId }).from(userSettings),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe(fixture.a.userId)
    })

    it('assets', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: assets.id, userId: assets.userId }).from(assets),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.assetId)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.assetId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('source_documents', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: sourceDocuments.id, userId: sourceDocuments.userId }).from(sourceDocuments),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.sourceDocumentId)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.sourceDocumentId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('upload_records', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: uploadRecords.id, userId: uploadRecords.userId }).from(uploadRecords),
      )
      expect(rows.map((r) => r.id)).toContain(aUploadRecordId)
      expect(rows.map((r) => r.id)).not.toContain(bUploadRecordId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })
  })

  // ----------------------------------------------------------------- writes
  // negative: B の行を A context から狙う → 0 行 (USING が不可視化)・owner で B 不変。
  // positive control: A 自身の行への write は成功する。
  describe('write (targeting B → 0 rows; A own → applied)', () => {
    it('study_sessions UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const marker = new Date('2030-01-01T00:00:00.000Z')
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(studySessions)
          .set({ completedAt: marker })
          .where(eq(studySessions.sessionId, fixture.b.studySessionId))
          .returning({ id: studySessions.sessionId }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ completedAt: studySessions.completedAt })
        .from(studySessions)
        .where(eq(studySessions.sessionId, fixture.b.studySessionId))
      expect(bAfter[0]?.completedAt).toBeNull()

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(studySessions)
          .set({ completedAt: marker })
          .where(eq(studySessions.sessionId, fixture.a.studySessionId))
          .returning({ id: studySessions.sessionId }),
      )
      expect(ok).toHaveLength(1)
    })

    it('user_settings whole-table UPDATE hits only A (PK=user_id)', async () => {
      // user_settings は PK=user_id ゆえ B を「user_id 述語なし」で個別に狙えない。
      // where なし UPDATE を A context で撃つと USING が A の 1 行だけに scope する。
      const owner = getFixtureOwnerDb()
      const updated = await asTenant(fixture.a.userId, (tx) =>
        tx.update(userSettings).set({ sessionLimit: 99 }).returning({ userId: userSettings.userId }),
      )
      expect(updated).toHaveLength(1)
      expect(updated[0]?.userId).toBe(fixture.a.userId)

      // B は A の whole-table UPDATE の影響を受けず schema default (20) のまま。
      const bAfter = await owner
        .select({ sessionLimit: userSettings.sessionLimit })
        .from(userSettings)
        .where(eq(userSettings.userId, fixture.b.userId))
      expect(bAfter[0]?.sessionLimit).toBe(20)
    })

    it('assets UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(assets)
          .set({ hash: 'HACKED' })
          .where(eq(assets.id, fixture.b.assetId))
          .returning({ id: assets.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ hash: assets.hash })
        .from(assets)
        .where(eq(assets.id, fixture.b.assetId))
      expect(bAfter[0]?.hash).toBe(`hash_${fixture.b.assetId}`)

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(assets)
          .set({ hash: 'a-new-hash' })
          .where(eq(assets.id, fixture.a.assetId))
          .returning({ id: assets.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('source_documents UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(sourceDocuments)
          .set({ filename: 'HACKED.pdf' })
          .where(eq(sourceDocuments.id, fixture.b.sourceDocumentId))
          .returning({ id: sourceDocuments.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ filename: sourceDocuments.filename })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, fixture.b.sourceDocumentId))
      expect(bAfter[0]?.filename).toBe('src.pdf')

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(sourceDocuments)
          .set({ filename: 'a.pdf' })
          .where(eq(sourceDocuments.id, fixture.a.sourceDocumentId))
          .returning({ id: sourceDocuments.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('upload_records UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(uploadRecords)
          .set({ pagesProcessed: 999 })
          .where(eq(uploadRecords.id, bUploadRecordId))
          .returning({ id: uploadRecords.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ pagesProcessed: uploadRecords.pagesProcessed })
        .from(uploadRecords)
        .where(eq(uploadRecords.id, bUploadRecordId))
      expect(bAfter[0]?.pagesProcessed).toBe(0)

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(uploadRecords)
          .set({ pagesProcessed: 7 })
          .where(eq(uploadRecords.id, aUploadRecordId))
          .returning({ id: uploadRecords.id }),
      )
      expect(ok).toHaveLength(1)
    })
  })

  // ------------------------------------------------------- WITH CHECK (42501)
  // user_id=B の insert / A 行を B へ付替える update は WITH CHECK 違反で 42501。
  describe('WITH CHECK: cross-tenant user_id write rejected (42501)', () => {
    it('study_sessions insert userId=B → 42501', async () => {
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(studySessions).values({
            sessionId: randomUUID(),
            userId: fixture.b.userId,
            mode: 'smart',
            startedAt: new Date('2026-07-18T00:00:00.000Z'),
          }),
        ),
      )
    })

    it('user_settings insert userId=B → 42501', async () => {
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(userSettings).values({ userId: fixture.b.userId }),
        ),
      )
    })

    it('assets insert userId=B → 42501', async () => {
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(assets).values({
            id: randomUUID(),
            userId: fixture.b.userId,
            objectKey: `users/${fixture.b.userId}/x.webp`,
            mime: 'image/webp',
            byteSize: 10,
            width: 1,
            height: 1,
            hash: 'h',
          }),
        ),
      )
    })

    it('source_documents insert userId=B → 42501', async () => {
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(sourceDocuments).values({
            id: randomUUID(),
            userId: fixture.b.userId,
            examId: fixture.a.examId, // 有効 FK (WITH CHECK が user_id で先に落ちる)
            mode: 'new',
            fileType: 'pdf',
            filename: 'x.pdf',
            fileSizeBytes: 10,
          }),
        ),
      )
    })

    it('upload_records insert userId=B → 42501', async () => {
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(uploadRecords).values({
            userId: fixture.b.userId,
            filename: 'x.pdf',
            fileSizeBytes: 10,
            status: 'completed',
          }),
        ),
      )
    })

    it('assets A→B user_id 付替え update → 42501', async () => {
      // A 自身の行を B の所有へ移す update は WITH CHECK (new row user_id=B) が拒否。
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx
            .update(assets)
            .set({ userId: fixture.b.userId })
            .where(eq(assets.id, fixture.a.assetId)),
        ),
      )
    })
  })

  // ------------------------------------------------------------ loud (P0RLS)
  // context 未設定で当該表を触ると policy 述語 app_current_user_id() が RAISE する。
  // read = bare SELECT (全 scan で無条件 RAISE)、write = user_id 述語つき DELETE (補強)。
  describe('loud on missing context (P0RLS) — read + write per table', () => {
    const decoyUser = '00000000-0000-4000-8000-0000000000ff'

    it('study_sessions', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: studySessions.sessionId }).from(studySessions))
      await assertRejectsWithP0RLS(() => getDb().delete(studySessions).where(eq(studySessions.userId, decoyUser)))
    })
    it('user_settings', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ userId: userSettings.userId }).from(userSettings))
      await assertRejectsWithP0RLS(() => getDb().delete(userSettings).where(eq(userSettings.userId, decoyUser)))
    })
    it('assets', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: assets.id }).from(assets))
      await assertRejectsWithP0RLS(() => getDb().delete(assets).where(eq(assets.userId, decoyUser)))
    })
    it('source_documents', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: sourceDocuments.id }).from(sourceDocuments))
      await assertRejectsWithP0RLS(() => getDb().delete(sourceDocuments).where(eq(sourceDocuments.userId, decoyUser)))
    })
    it('upload_records', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: uploadRecords.id }).from(uploadRecords))
      await assertRejectsWithP0RLS(() => getDb().delete(uploadRecords).where(eq(uploadRecords.userId, decoyUser)))
    })
  })

  // ------------------------------------------- 配線経路 (DB 層) が RLS-on 下で動く
  describe('wired paths work under RLS (DB layer)', () => {
    it('upsertSessionGuarded: A の新規 session を context 下で insert → applied; owner が A 名義で観測', async () => {
      const owner = getFixtureOwnerDb()
      const newSessionId = randomUUID()
      const result = await asTenant(fixture.a.userId, (tx) =>
        upsertSessionGuarded(tx, { id: fixture.a.userId } as unknown as User, {
          session_id: newSessionId,
          mode: 'smart',
          card_ids: [],
          started_at: '2026-07-18T00:00:00.000Z',
          status: 'active',
        }),
      )
      expect(result.applied).toBe(true)
      const row = await owner
        .select({ userId: studySessions.userId })
        .from(studySessions)
        .where(eq(studySessions.sessionId, newSessionId))
      expect(row[0]?.userId).toBe(fixture.a.userId)
    })

    it('getCurrentMonthOcrPages: upload_records を context 下で SUM → A の当月 pages', async () => {
      const owner = getFixtureOwnerDb()
      // 当月 completed 行を A に 1 件追加 (fixture の seed 行は pagesProcessed=0)。
      await owner.insert(uploadRecords).values({
        userId: fixture.a.userId,
        filename: 'ocr.pdf',
        fileSizeBytes: 100,
        pagesProcessed: 5,
        status: 'completed',
      })
      const total = await asTenant(fixture.a.userId, (tx) =>
        getCurrentMonthOcrPages(fixture.a.userId, tx),
      )
      expect(total).toBe(5)
    })
  })
})
