// O1: OCR 完了 / 失敗 write の owner-scope 隔離 assertion。
// completeUploadTx / markFailed の source_documents UPDATE が `WHERE id` のみで
// `user_id` 述語を欠く既知バグ (Iso-0 §1.3) を fix したことを実 PG で検証する。
//
// 契約別に観測が異なる:
//   - completeUploadTx = 所有権違反 (0 行) で throw (完了 tx を確定させない)。
//     正常単一テナント経路 (id/userId 一致) は厳密 1 行 update。
//   - markFailed = best-effort no-throw 契約。所有権違反 (0 行) は warn のみで
//     台帳 (upload_records) を残さない。
// 両者とも「A の文脈で B の doc を complete/fail できない」(B の status 不変) を
// negative で確認し、A 自身は positive で通す。
//
// mutating test ゆえ beforeEach で truncate→seed(各 test を clean state から)。
// write-isolation.test.ts と同じ規約 (afterAll closeDb / @/lib/db は mock しない)。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { sourceDocuments, uploadRecords } from '@/lib/db/schema'
import {
  completeUploadTx,
  markFailed,
} from '@/app/(app)/app/upload/_actions/upload-persistence'

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

// RLS-P3 Wave2: source_documents / upload_records が RLS-on 化したため、ground-truth 観測は
// owner 接続 (getFixtureOwnerDb・RLS bypass) で行う (as-tenant.ts 規約: 観測/seed は owner)。
// RLS-P3 Task 3: completeUploadTx は tx を受け取る apply へ変わったため、刺激側は
// withTenantTx(userId, ...) で tenant context 付き tx を張って渡す (markFailed は内部で
// withTenantTx を張るため引数不変)。
async function statusOf(sourceDocumentId: string): Promise<string | undefined> {
  const rows = await getFixtureOwnerDb()
    .select({ status: sourceDocuments.status })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
  return rows[0]?.status
}

// 台帳行の識別: Sprint B (DB 全体掃除) で filename 列が消えたため、刺激で **増えた行**
// を id 差分で取る (fixture が seed 済の 1 行と混ざらないようにする)。
async function ledgerIdsOf(userId: string): Promise<Set<string>> {
  const rows = await getFixtureOwnerDb()
    .select({ id: uploadRecords.id })
    .from(uploadRecords)
    .where(eq(uploadRecords.userId, userId))
  return new Set(rows.map((r) => r.id))
}

async function ledgerRowsAppendedSince(userId: string, before: Set<string>) {
  const rows = await getFixtureOwnerDb()
    .select({
      id: uploadRecords.id,
      userId: uploadRecords.userId,
      status: uploadRecords.status,
      pagesProcessed: uploadRecords.pagesProcessed,
    })
    .from(uploadRecords)
    .where(eq(uploadRecords.userId, userId))
  return rows.filter((row) => !before.has(row.id))
}

describe('OCR completion/failure owner-scope isolation (O1)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  // --- completeUploadTx: 正常単一テナント経路は厳密 1 行 update ---
  describe('completeUploadTx', () => {
    it('completes tenant A own document (positive control)', async () => {
      const ledgerBefore = await ledgerIdsOf(fixture.a.userId)
      await expect(
        withTenantTx(fixture.a.userId, (tx) =>
          completeUploadTx(tx, {
            sourceDocumentId: fixture.a.sourceDocumentId,
            userId: fixture.a.userId,
            totalPages: 3,
            cardsExtracted: 5,
          }),
        ),
      ).resolves.toBeUndefined()

      // A の doc が completed + 完了メタが確定
      const rows = await getFixtureOwnerDb()
        .select({
          status: sourceDocuments.status,
          pagesProcessed: sourceDocuments.pagesProcessed,
          cardsExtracted: sourceDocuments.cardsExtracted,
          completedAt: sourceDocuments.completedAt,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, fixture.a.sourceDocumentId))
      expect(rows[0]?.status).toBe('completed')
      expect(rows[0]?.pagesProcessed).toBe(3)
      expect(rows[0]?.cardsExtracted).toBe(5)
      expect(rows[0]?.completedAt).not.toBeNull()

      // 厳密 1 行 update の裏取り: completed になった doc は table 全体で 1 行のみ
      // (B の doc に波及していない)。
      const completed = await getFixtureOwnerDb()
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.status, 'completed'))
      expect(completed).toHaveLength(1)
      expect(completed[0]?.id).toBe(fixture.a.sourceDocumentId)

      // 台帳: completed 行が A 名義で 1 行 append (pages は渡した totalPages)
      const ledger = await ledgerRowsAppendedSince(fixture.a.userId, ledgerBefore)
      expect(ledger).toHaveLength(1)
      expect(ledger[0]?.userId).toBe(fixture.a.userId)
      expect(ledger[0]?.status).toBe('completed')
      expect(ledger[0]?.pagesProcessed).toBe(3)
    })

    // 代表 RED: fix 前は WHERE が id のみのため、A の文脈で B の doc を completed に
    // できてしまう。fix 後は 0 行 → throw し、B の doc は不変。
    it('does not complete tenant B document via tenant A context (negative)', async () => {
      const ledgerBeforeA = await ledgerIdsOf(fixture.a.userId)
      const ledgerBeforeB = await ledgerIdsOf(fixture.b.userId)
      await expect(
        withTenantTx(fixture.a.userId, (tx) =>
          completeUploadTx(tx, {
            sourceDocumentId: fixture.b.sourceDocumentId,
            userId: fixture.a.userId,
            totalPages: 9,
            cardsExtracted: 9,
          }),
        ),
      ).rejects.toThrow()

      // B の doc は seed 時の 'processing' のまま
      expect(await statusOf(fixture.b.sourceDocumentId)).toBe('processing')

      // 完了 tx が rollback され、どちらの名義でも台帳行は増えない
      expect(await ledgerRowsAppendedSince(fixture.a.userId, ledgerBeforeA)).toHaveLength(0)
      expect(await ledgerRowsAppendedSince(fixture.b.userId, ledgerBeforeB)).toHaveLength(0)
    })
  })

  // --- markFailed: best-effort no-throw。所有権違反は warn のみ ---
  describe('markFailed', () => {
    it('marks tenant A own document failed (positive control)', async () => {
      const ledgerBefore = await ledgerIdsOf(fixture.a.userId)
      await expect(
        markFailed(fixture.a.sourceDocumentId, new Error('ocr boom'), {
          userId: fixture.a.userId,
          pagesProcessed: 2,
        }),
      ).resolves.toBeUndefined()

      const rows = await getFixtureOwnerDb()
        .select({
          status: sourceDocuments.status,
          errorMessage: sourceDocuments.errorMessage,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, fixture.a.sourceDocumentId))
      expect(rows[0]?.status).toBe('failed')
      expect(rows[0]?.errorMessage).toBe('ocr boom')

      const ledger = await ledgerRowsAppendedSince(fixture.a.userId, ledgerBefore)
      expect(ledger).toHaveLength(1)
      expect(ledger[0]?.userId).toBe(fixture.a.userId)
      expect(ledger[0]?.status).toBe('failed')
      expect(ledger[0]?.pagesProcessed).toBe(2)
    })

    // RED: fix 前は A の文脈で B の doc を failed にできてしまう。markFailed は
    // best-effort ゆえ throw はしない (fix 前後とも) が、fix 後は B が不変。
    it('does not mark tenant B document failed via tenant A context (negative)', async () => {
      const ledgerBeforeA = await ledgerIdsOf(fixture.a.userId)
      const ledgerBeforeB = await ledgerIdsOf(fixture.b.userId)
      await expect(
        markFailed(fixture.b.sourceDocumentId, new Error('ocr boom'), {
          userId: fixture.a.userId,
          pagesProcessed: 2,
        }),
      ).resolves.toBeUndefined()

      // B の doc は seed 時の 'processing' のまま
      expect(await statusOf(fixture.b.sourceDocumentId)).toBe('processing')

      // 越境の台帳行も残らない (no-row は台帳 append しない)
      expect(await ledgerRowsAppendedSince(fixture.a.userId, ledgerBeforeA)).toHaveLength(0)
      expect(await ledgerRowsAppendedSince(fixture.b.userId, ledgerBeforeB)).toHaveLength(0)
    })
  })
})
