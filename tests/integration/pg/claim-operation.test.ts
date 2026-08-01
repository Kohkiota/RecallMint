// ②-4a Phase B Task 6: claim + lease CAS(+ 日次 cap 判定・単一 tx)の実 PG 検証。
//
// 2026-07-31 T6 fencing checkpoint 裁定(OT 確定)により全面改訂: claim を
// 1 transaction に統合(`upload_operations` SELECT…FOR UPDATE → 分類(daily cap
// より前)→ claim 候補のみ daily cap → 全 source_assets ORDER BY id FOR UPDATE
// (status で絞らない)→ source 集合検証 → claim CAS)。**契約変更**: 旧版の
// 「reserved 行を除外して claim 成功」テストは Critical #2(finalize 途中の部分
// 合計で claim してしまう欠陥)を「正しい挙動」として pin していたため削除し、
// 新契約(reserved が 1 件でもあれば `sources_not_ready`)のテストへ差し替えた。
//
// claimOperationTx は Clerk 認証を持たない(prepareUploadTx と同型 — tx と user を
// 呼出側から受け取るだけ)ため asTenant + Pick<User,'id'> で直接 exercise できる。
// 外側の claimOperation(Clerk 経由)はこの iso suite の対象外。
//
// ★ concurrent-claim 系 test が本 task の核心(OT checkpoint 対象)。claim は
// `upload_operations` を冒頭で SELECT…FOR UPDATE するため、同一行への並行 claim
// は「後着 tx がこの行ロックでブロック → 先着 commit 後に最新のコミット済み行を
// 読んで分類し直す」という pessimistic locking で解決する。ゆえに 2 つの
// claimOperationTx 呼出を Promise.all で並行実行するだけで、Postgres の
// 行ロックにより「どちらが先に実行されても・どれだけ重なっても、必ず一方だけが
// claim できる」ことが DB レベルで保証される — app 側で明示的な gate/signal を
// 組む必要がない(T5 finalize の TOCTOU race テスト(read-tx/外部I/O/write-tx に
// 分割)とは異なり、claim は 1 tx に閉じているため)。
//
// 日次 cap 判定は getTodayAiUsageGlobal(tx) 経由で実 ai_usage 表を読む。ai_usage は
// user_id を持たない global 表で truncateAllUserTables の対象外(rls-partial-mixed
// test と同じ理由)なので、対象日付行を beforeEach/afterEach で個別掃除する。
//
// T12b(2026-08-01): prepared takeover の CAS 検証を追加(「prepared operation」
// describe 参照)。旧 worker fencing の統合 test は T12a の publishPreparedUpload
// を実際に呼ぶ — R2/Clerk は publish-prepared.test.ts と同じ理由(module load 時
// fail-fast の r2.ts / 実 Clerk 非依存)で mock する。
//
// mutating test ゆえ beforeEach で truncate→seed(各 test を clean state から)。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import {
  aiUsage,
  cards,
  exams,
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  users,
} from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'
import {
  claimOperationTx,
  type ClaimOperationResult,
} from '@/app/(app)/app/upload/_actions/claim-operation'
import { TOTAL_UPLOAD_LIMIT_BYTES } from '@/app/(app)/app/upload/_lib/constants'
import type { PreparedCard, PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'

import { asTenant } from './setup/as-tenant'
import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))
// crop-and-store.ts(publish-prepared.ts の import chain)が module load 時に
// @/lib/storage/r2 を評価すると env fail-fast で throw しうる(publish-prepared.test.ts
// と同じ理由)。 本 file の統合 test は figures:[] の text-only card しか publish
// しないため getObject/putObject は呼ばれないが、import 自体を安全にするため mock する。
vi.mock('@/lib/storage/r2', () => ({
  getObject: vi.fn(),
  putObject: vi.fn(),
}))

// vi.mock は import より前に hoist される。
import { publishPreparedUpload } from '@/app/(app)/app/upload/_actions/publish-prepared'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

type SeedOverrides = Partial<{
  status: 'awaiting_sources' | 'claimed' | 'prepared' | 'completed' | 'terminal_failed'
  leaseVersion: number
  leaseExpiresAt: Date | null
  attemptCount: number
  nextRetryAt: Date | null
  resultSummary: Record<string, unknown> | null
  lastErrorCode: string | null
  idempotencyKey: string
  expectedSourceCount: number
  // T12b: old-worker-rejection 統合 test(publishPreparedUpload を叩く)向け。
  preparedPayload: Record<string, unknown> | null
}>

async function seedOperation(
  userId: string,
  overrides: SeedOverrides = {},
): Promise<{ operationId: string; examId: string; sourceDocumentId: string }> {
  const owner = getFixtureOwnerDb()
  const examId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'テスト試験' })
  const sourceDocumentId = randomUUID()
  await owner.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'image',
    filename: 'test.png',
    fileSizeBytes: 1000,
    status: 'processing',
    pagesTotal: 1,
  })
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId,
    idempotencyKey: overrides.idempotencyKey ?? `idem-${operationId}`,
    examId,
    sourceDocumentId,
    status: overrides.status ?? 'awaiting_sources',
    leaseVersion: overrides.leaseVersion ?? 0,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    attemptCount: overrides.attemptCount ?? 0,
    nextRetryAt: overrides.nextRetryAt ?? null,
    resultSummary: overrides.resultSummary ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    // T6 fencing checkpoint 裁定: immutable manifest oracle。既定 1(既定で
    // 1 件の ready source_asset を伴わせる seedOperationWithReadySource と対
    // にする)。source 集合検証そのものをテストする describe では明示上書き。
    expectedSourceCount: overrides.expectedSourceCount ?? 1,
    preparedPayload: overrides.preparedPayload ?? null,
  })
  return { operationId, examId, sourceDocumentId }
}

async function seedSourceAsset(
  userId: string,
  sourceDocumentId: string,
  sourceId: string,
  overrides: Partial<{ status: 'reserved' | 'ready' | 'deleting'; byteSize: number | null }> = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const assetId = randomUUID()
  const status = overrides.status ?? 'ready'
  const byteSize =
    overrides.byteSize === undefined ? (status === 'ready' ? 1000 : null) : overrides.byteSize
  await owner.insert(sourceAssets).values({
    id: assetId,
    userId,
    sourceDocumentId,
    sourceId,
    objectKey:
      status === 'reserved'
        ? `users/${userId}/src/tmp/${assetId}`
        : `users/${userId}/src/${assetId}.png`,
    mime: status === 'reserved' ? null : 'image/png',
    contentHash: status === 'reserved' ? null : `hash-${assetId}`,
    byteSize,
    width: status === 'reserved' ? null : 100,
    height: status === 'reserved' ? null : 100,
    status,
    originalFilename: `${sourceId}.png`,
    readyAt: status === 'ready' ? new Date() : null,
  })
  return assetId
}

async function seedReadySourceAsset(
  userId: string,
  sourceDocumentId: string,
  sourceId: string,
  byteSize: number,
): Promise<string> {
  return seedSourceAsset(userId, sourceDocumentId, sourceId, { status: 'ready', byteSize })
}

// claim CAS まで到達させたい test 用の便宜 helper: expectedSourceCount=1 の
// operation + それに一致する 1 件の ready source_asset(既定 1000 bytes、
// TOTAL_UPLOAD_LIMIT_BYTES 内)をまとめて作る。
async function seedClaimableOperation(
  userId: string,
  overrides: SeedOverrides = {},
  byteSize = 1000,
): Promise<{ operationId: string; examId: string; sourceDocumentId: string }> {
  const seeded = await seedOperation(userId, { expectedSourceCount: 1, ...overrides })
  await seedReadySourceAsset(userId, seeded.sourceDocumentId, 's1', byteSize)
  return seeded
}

async function readOperationRow(operationId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      leaseExpiresAt: uploadOperations.leaseExpiresAt,
      attemptCount: uploadOperations.attemptCount,
      nextRetryAt: uploadOperations.nextRetryAt,
      resultSummary: uploadOperations.resultSummary,
      lastErrorCode: uploadOperations.lastErrorCode,
    })
    .from(uploadOperations)
    .where(eq(uploadOperations.id, operationId))
  return rows[0]
}

describe('claimOperationTx (T6)', () => {
  let userAId: string
  let userBId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetCurrentUser.mockReset()
    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
  })

  // --- concurrent-claim CAS: 本 task の核心 ---
  describe('concurrent claim CAS', () => {
    it('exactly one of two concurrent claims on the same awaiting_sources operation wins ("claimed"); the other gets "already_processing"; lease_version bumps by exactly 1', async () => {
      const { operationId } = await seedClaimableOperation(userAId)

      const [r1, r2] = await Promise.all([
        asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
        asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
      ])

      const outcomes = [r1.outcome, r2.outcome].sort()
      expect(outcomes).toEqual(['already_processing', 'claimed'])

      const winner = (r1.outcome === 'claimed' ? r1 : r2) as Extract<
        ClaimOperationResult,
        { outcome: 'claimed' }
      >
      expect(winner.leaseVersion).toBe(1)

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('claimed')
      expect(row?.leaseVersion).toBe(1)
      expect(row?.attemptCount).toBe(1)
    })

    it('expired-lease takeover race: two concurrent claims on the same claimed+expired-lease operation → exactly one wins ("claimed", lease bumps by 1); the other gets "already_processing" (sees the winner\'s fresh valid lease)', async () => {
      const { operationId } = await seedClaimableOperation(userAId, {
        status: 'claimed',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() - 60_000), // 期限切れ
        attemptCount: 1,
      })

      const [r1, r2] = await Promise.all([
        asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
        asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
      ])

      const outcomes = [r1.outcome, r2.outcome].sort()
      expect(outcomes).toEqual(['already_processing', 'claimed'])

      const winner = (r1.outcome === 'claimed' ? r1 : r2) as Extract<
        ClaimOperationResult,
        { outcome: 'claimed' }
      >
      expect(winner.leaseVersion).toBe(2) // 1 → 2

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('claimed')
      expect(row?.leaseVersion).toBe(2)
      expect(row?.attemptCount).toBe(2)
    })
  })

  // --- 二重 Gemini 抑止: claimed + lease 有効中の再 claim ---
  describe('double-suppression (claimed + valid lease)', () => {
    it('a 2nd claim while claimed with a still-valid lease returns already_processing and writes nothing', async () => {
      const leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000)
      const { operationId } = await seedOperation(userAId, {
        status: 'claimed',
        leaseVersion: 1,
        leaseExpiresAt,
        attemptCount: 1,
      })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('already_processing')

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('claimed')
      expect(row?.leaseVersion).toBe(1)
      expect(row?.attemptCount).toBe(1)
    })
  })

  // --- 再 claim: retryable-failed(next_retry_at 到達 vs 未到達) ---
  describe('retryable re-claim (next_retry_at gate)', () => {
    it('a retryable-failed op with next_retry_at in the past re-claims (lease bumps)', async () => {
      const { operationId } = await seedClaimableOperation(userAId, {
        status: 'claimed',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() - 60_000), // 期限切れ
        attemptCount: 1,
        nextRetryAt: new Date(Date.now() - 30_000), // 到達済み
      })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result).toMatchObject({ outcome: 'claimed', leaseVersion: 2 })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('claimed')
      expect(row?.leaseVersion).toBe(2)
      expect(row?.attemptCount).toBe(2)
    })

    it('a retryable-failed op with next_retry_at in the future is not claimable (not_found) and writes nothing', async () => {
      const { operationId } = await seedOperation(userAId, {
        status: 'claimed',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() - 60_000), // 期限切れ(lease だけなら takeover 可)
        attemptCount: 1,
        nextRetryAt: new Date(Date.now() + 5 * 60 * 1000), // 未到達(backoff 待ち)
      })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('not_found')

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('claimed')
      expect(row?.leaseVersion).toBe(1)
      expect(row?.attemptCount).toBe(1)
    })
  })

  // --- 日次 Gemini cap ---
  describe('daily Gemini cap', () => {
    let originalDailyLimit: string | undefined
    const today = todayInJst()

    beforeEach(async () => {
      originalDailyLimit = process.env.GEMINI_DAILY_LIMIT
      process.env.GEMINI_DAILY_LIMIT = '5'
      await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
    })

    afterEach(async () => {
      if (originalDailyLimit === undefined) {
        delete process.env.GEMINI_DAILY_LIMIT
      } else {
        process.env.GEMINI_DAILY_LIMIT = originalDailyLimit
      }
      await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
    })

    it('global daily count at the limit → daily_limit_exceeded, operation stays awaiting_sources (no claim)', async () => {
      await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 5 })
      const { operationId } = await seedOperation(userAId)

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result).toMatchObject({
        outcome: 'daily_limit_exceeded',
        current: 5,
        limit: 5,
      })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('awaiting_sources')
      expect(row?.leaseVersion).toBe(0)
      expect(row?.attemptCount).toBe(0)
    })

    it('global daily count over the limit → daily_limit_exceeded, operation stays awaiting_sources', async () => {
      await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 9 })
      const { operationId } = await seedOperation(userAId)

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result).toMatchObject({ outcome: 'daily_limit_exceeded', current: 9, limit: 5 })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('awaiting_sources')
    })

    it('global daily count under the limit → cap does not block a real claim', async () => {
      await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 4 })
      const { operationId } = await seedClaimableOperation(userAId)

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('claimed')
    })

    // [Critical #1 regression] classification (completed/terminal_failed の冪等
    // replay) は daily cap より前でなければならない — 再送は新規 Gemini call を
    // 要しないため、cap 枯渇状態でも保存済み結果をそのまま返す(spec §2 冪等
    // replay 契約)。
    it('a completed operation still returns its stored result_summary even when the daily cap is exhausted', async () => {
      await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 999 })
      const resultSummary = { schemaVersion: 1, cardsExtracted: 3 }
      const { operationId } = await seedOperation(userAId, {
        status: 'completed',
        resultSummary,
      })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result).toEqual({ outcome: 'completed', resultSummary })
    })
  })

  // --- source 集合検証(spec §2.1 手順4-5) ---
  describe('source set validation', () => {
    it('any source_asset still reserved (finalize in progress) → sources_not_ready (transient, operation status unchanged, no persisted failure)', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        expectedSourceCount: 2,
      })
      await seedSourceAsset(userAId, sourceDocumentId, 's1', { status: 'ready', byteSize: 1000 })
      await seedSourceAsset(userAId, sourceDocumentId, 's2', { status: 'reserved' })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result).toEqual({ outcome: 'sources_not_ready' })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('awaiting_sources') // 永続 status 不変
      expect(row?.leaseVersion).toBe(0)
      expect(row?.lastErrorCode).toBeNull()
    })

    // [Critical #2 regression / 契約変更] 旧版はここで「reserved 行は除外して
    // claim 成功」と assert していた(=部分合計での claim を pin していた)。
    // 新契約では finalize↔claim の実競合を real PG で駆動し、claim は決して
    // 古い/部分的な合計で claim しない(reserved を 1 件でも見れば
    // sources_not_ready で確定する・全 ready を見た時のみ完全な合計で claim
    // する)ことを確認する。 SELECT…FOR UPDATE による行ロックのおかげで、どちらの
    // 順序で実行されても不正な中間状態は観測されない — 両方の正当な帰結を
    // 許容しつつ、どちらでも「finalize 未反映の部分合計で claim」が起きないことを
    // 検証する。
    it('finalize↔claim race: claim never computes the total from a stale/partial read — resolves to sources_not_ready (claim locks first) or a claim using the FULLY finalized total (finalize commits first), and the row ends up ready either way', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        expectedSourceCount: 2,
      })
      const owner = getFixtureOwnerDb()
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1', 1000)
      const reservedAssetId = await seedSourceAsset(userAId, sourceDocumentId, 's2', {
        status: 'reserved',
      })

      // finalize 相当: reserved → ready への単文 UPDATE(単文ゆえ暗黙 auto-commit
      // の独立 tx)。claim の SELECT…FOR UPDATE と同じ行を取り合う。
      const finalizeRace = () =>
        owner
          .update(sourceAssets)
          .set({
            status: 'ready',
            byteSize: 2000,
            mime: 'image/png',
            contentHash: 'hash-finalized',
            width: 100,
            height: 100,
            readyAt: new Date(),
          })
          .where(eq(sourceAssets.id, reservedAssetId))

      const [claimResult] = await Promise.all([
        asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
        finalizeRace(),
      ])

      if (claimResult.outcome === 'sources_not_ready') {
        // claim が先に source_assets をロックした: 一時的outcome・永続status不変。
        const row = await readOperationRow(operationId)
        expect(row?.status).toBe('awaiting_sources')
      } else {
        // finalize が先に commit した: claim は完全な合計(1000+2000)を見たはず
        // (reserved が 1 件でも残っていれば sources_not_ready に分岐するため、
        // 'claimed' に到達したこと自体が「両行 ready を見た」ことの証明)。
        expect(claimResult.outcome).toBe('claimed')
      }

      // どちらの順序でも、最終的に reservedAssetId は ready 化されている。
      const finalRows = await owner
        .select({ status: sourceAssets.status })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, reservedAssetId))
      expect(finalRows[0]?.status).toBe('ready')
    })

    it('all ready but the real byte_size sum exceeds TOTAL_UPLOAD_LIMIT_BYTES → persists a terminal_failed result (size_exceeded), and a re-send returns the SAME terminal result (no re-check)', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        expectedSourceCount: 2,
      })
      const half = Math.floor(TOTAL_UPLOAD_LIMIT_BYTES / 2) + 1000
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1', half)
      await seedReadySourceAsset(userAId, sourceDocumentId, 's2', half)

      const first = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(first.outcome).toBe('terminal_failed')
      if (first.outcome !== 'terminal_failed') throw new Error('unreachable')
      expect(first.lastErrorCode).toBe('size_exceeded')
      expect(first.resultSummary).toMatchObject({
        reason: 'size_exceeded',
        current: half * 2,
        limit: TOTAL_UPLOAD_LIMIT_BYTES,
      })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
      expect(row?.leaseVersion).toBe(0) // 一度も claim CAS に到達していない

      // 再送: 同じ idempotency key(= 同じ operationId)で再度呼んでも、size 判定
      // を再実行せず保存済みの同じ終端結果をそのまま返す。
      const second = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(second).toEqual(first)
    })

    it('actual source_assets row count below expected_source_count (missing row) → terminal_failed (source_count_mismatch), not conflated with sources_not_ready', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        expectedSourceCount: 2,
      })
      // 1 件だけ seed(expected=2 に対し欠落)。
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1', 1000)

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('terminal_failed')
      if (result.outcome !== 'terminal_failed') throw new Error('unreachable')
      expect(result.lastErrorCode).toBe('source_count_mismatch')
      expect(result.resultSummary).toMatchObject({ expected: 2, actual: 1 })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
    })

    it('a ready row with byte_size IS NULL → terminal_failed (source_byte_size_missing)', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        expectedSourceCount: 1,
      })
      await seedSourceAsset(userAId, sourceDocumentId, 's1', { status: 'ready', byteSize: null })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('terminal_failed')
      if (result.outcome !== 'terminal_failed') throw new Error('unreachable')
      expect(result.lastErrorCode).toBe('source_byte_size_missing')

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
    })

    it('a deleting row mixed with a ready row → terminal_failed (source_deleting), not conflated with sources_not_ready', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        expectedSourceCount: 2,
      })
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1', 1000)
      await seedSourceAsset(userAId, sourceDocumentId, 's2', { status: 'deleting' })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('terminal_failed')
      if (result.outcome !== 'terminal_failed') throw new Error('unreachable')
      expect(result.lastErrorCode).toBe('source_deleting')

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
    })
  })

  // --- completed / terminal_failed: 冪等成功・再 claim なし ---
  describe('completed / terminal_failed operations (idempotent replay)', () => {
    it('completed: returns the stored result_summary and does not re-claim (row unchanged)', async () => {
      const resultSummary = { schemaVersion: 1, cardsExtracted: 3 }
      const { operationId } = await seedOperation(userAId, {
        status: 'completed',
        leaseVersion: 3,
        attemptCount: 2,
        resultSummary,
      })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result).toEqual({ outcome: 'completed', resultSummary })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('completed')
      expect(row?.leaseVersion).toBe(3)
      expect(row?.attemptCount).toBe(2)
    })

    it('terminal_failed: returns the same stored terminal result on repeated calls (idempotent replay), row unchanged', async () => {
      const resultSummary = { reason: 'size_exceeded', current: 5_000_000, limit: 4_000_000 }
      const { operationId } = await seedOperation(userAId, {
        status: 'terminal_failed',
        leaseVersion: 0,
        lastErrorCode: 'size_exceeded',
        resultSummary,
      })

      const first = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      const second = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(first).toEqual({
        outcome: 'terminal_failed',
        lastErrorCode: 'size_exceeded',
        resultSummary,
      })
      expect(second).toEqual(first)

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
      expect(row?.leaseVersion).toBe(0)
    })
  })

  // --- prepared: LIVE lease は再 claim せず already_prepared / 期限切れ・解放
  // 済み lease は T12b の takeover CAS で新 lease_version を発行する(spec §2.2)。
  describe('prepared operation', () => {
    it('a prepared op with a LIVE lease returns already_prepared and does not take over (lease_version unchanged)', async () => {
      const { operationId } = await seedOperation(userAId, {
        status: 'prepared',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // 有効
        attemptCount: 1,
      })

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('already_prepared')

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('prepared')
      expect(row?.leaseVersion).toBe(1)
    })

    // --- prepared takeover CAS(T12b・spec §2.2 の実装本体) ---
    describe('takeover (expired/released lease)', () => {
      it('expired lease → takes over with lease_version incremented by 1 (attempt_count unchanged: no Gemini re-run)', async () => {
        const { operationId } = await seedOperation(userAId, {
          status: 'prepared',
          leaseVersion: 3,
          leaseExpiresAt: new Date(Date.now() - 60_000), // 期限切れ
          attemptCount: 2,
          lastErrorCode: 'stale-note',
        })

        const result = await asTenant(userAId, (tx) =>
          claimOperationTx(tx, { id: userAId }, operationId),
        )
        expect(result).toMatchObject({ outcome: 'prepared_taken_over', leaseVersion: 4 })

        const row = await readOperationRow(operationId)
        expect(row?.status).toBe('prepared') // status は不変(publish はまだしていない)
        expect(row?.leaseVersion).toBe(4)
        expect(row?.leaseExpiresAt).not.toBeNull()
        expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
        expect(row?.attemptCount).toBe(2) // takeover は Gemini attempt ではない
        expect(row?.lastErrorCode).toBeNull() // takeover 時にクリア
      })

      it('null lease (released by a prior publish-retryable) → takes over', async () => {
        // T12a persistPublishRetryCas と同型の state: status='prepared' のまま
        // leaseExpiresAt=null(lease 解放済み)・next_retry_at 既に到達済み。
        const { operationId } = await seedOperation(userAId, {
          status: 'prepared',
          leaseVersion: 1,
          leaseExpiresAt: null,
          nextRetryAt: new Date(Date.now() - 1_000), // backoff 到達済み
          lastErrorCode: 'figure_retryable',
        })

        const result = await asTenant(userAId, (tx) =>
          claimOperationTx(tx, { id: userAId }, operationId),
        )
        expect(result).toMatchObject({ outcome: 'prepared_taken_over', leaseVersion: 2 })

        const row = await readOperationRow(operationId)
        expect(row?.leaseVersion).toBe(2)
        expect(row?.nextRetryAt).toBeNull()
        expect(row?.lastErrorCode).toBeNull()
      })

      it('expired lease but next_retry_at in the future (publish backoff not yet elapsed) → no takeover (already_prepared)', async () => {
        const { operationId } = await seedOperation(userAId, {
          status: 'prepared',
          leaseVersion: 2,
          leaseExpiresAt: null,
          nextRetryAt: new Date(Date.now() + 5 * 60 * 1000), // backoff 未到達
        })

        const result = await asTenant(userAId, (tx) =>
          claimOperationTx(tx, { id: userAId }, operationId),
        )
        expect(result.outcome).toBe('already_prepared')

        const row = await readOperationRow(operationId)
        expect(row?.leaseVersion).toBe(2) // 不変
      })

      // [Global Constraint AI-2 相当] Gemini を再実行しないため、日次 cap
      // 枯渇でも takeover はブロックされない — この分岐は cap 判定(daily
      // Gemini cap describe が検証する手順3)より前で return するため、cap
      // 判定自体に到達しない。
      it('daily Gemini cap exhausted does NOT block a takeover (no Gemini re-run)', async () => {
        const originalDailyLimit = process.env.GEMINI_DAILY_LIMIT
        process.env.GEMINI_DAILY_LIMIT = '1'
        const today = todayInJst()
        await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
        await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 999 }) // 大幅超過
        try {
          const { operationId } = await seedOperation(userAId, {
            status: 'prepared',
            leaseVersion: 1,
            leaseExpiresAt: new Date(Date.now() - 60_000),
          })

          const result = await asTenant(userAId, (tx) =>
            claimOperationTx(tx, { id: userAId }, operationId),
          )
          expect(result).toMatchObject({ outcome: 'prepared_taken_over', leaseVersion: 2 })
        } finally {
          if (originalDailyLimit === undefined) {
            delete process.env.GEMINI_DAILY_LIMIT
          } else {
            process.env.GEMINI_DAILY_LIMIT = originalDailyLimit
          }
          await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
        }
      })

      it('concurrent takeover race: exactly one of two concurrent calls wins ("prepared_taken_over"); the other gets "already_prepared"; lease_version bumps by exactly 1', async () => {
        const { operationId } = await seedOperation(userAId, {
          status: 'prepared',
          leaseVersion: 5,
          leaseExpiresAt: new Date(Date.now() - 60_000),
        })

        const [r1, r2] = await Promise.all([
          asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
          asTenant(userAId, (tx) => claimOperationTx(tx, { id: userAId }, operationId)),
        ])

        const outcomes = [r1.outcome, r2.outcome].sort()
        expect(outcomes).toEqual(['already_prepared', 'prepared_taken_over'])

        const winner = (
          r1.outcome === 'prepared_taken_over' ? r1 : r2
        ) as Extract<ClaimOperationResult, { outcome: 'prepared_taken_over' }>
        expect(winner.leaseVersion).toBe(6)

        const row = await readOperationRow(operationId)
        expect(row?.leaseVersion).toBe(6)
      })
    })

    // --- old worker fencing after takeover(T12b の checkpoint 要件・T12a 統合) ---
    describe('old-worker rejection after takeover (T12a fencing integration)', () => {
      function makePreparedCard(): PreparedCard {
        return {
          cardId: randomUUID(),
          title: 'T',
          sortKey: null,
          questionText: 'Q?',
          options: [
            { id: 'a', uid: randomUUID(), text: 'A', isCorrect: true },
            { id: 'b', uid: randomUUID(), text: 'B', isCorrect: false },
          ],
          correctAnswerIds: ['a'],
          explanationText: null,
          memo: null,
          figures: [], // text-only: R2 crop 不要(mock 済 r2 も未使用のまま)
          customProps: {},
        }
      }

      async function countCards(userId: string): Promise<number> {
        const rows = await getFixtureOwnerDb()
          .select({ id: cards.id })
          .from(cards)
          .where(eq(cards.userId, userId))
        return rows.length
      }

      it('after takeover, the OLD worker\'s publishPreparedUpload(oldLeaseVersion) is rejected (stale, zero cards); the NEW lease_version then publishes successfully', async () => {
        mockGetCurrentUser.mockResolvedValue({ id: userAId })
        const card = makePreparedCard()
        const payload: PreparedPayloadV1 = {
          schemaVersion: 1,
          cards: [card],
          cardsTotal: 1,
          cardsExcluded: 0,
          figuresExcluded: {
            coordinate_null: 0,
            source_id_invalid: 0,
            malformed: 0,
            asset_id_invalid: 0,
          },
        }
        // 旧 worker が保存した prepared payload(lease_version=1 で claim/stage
        // した想定)。lease 期限切れ = 旧 worker は死亡済み。
        const { operationId } = await seedOperation(userAId, {
          status: 'prepared',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() - 60_000),
          preparedPayload: payload as unknown as Record<string, unknown>,
        })
        const oldLeaseVersion = 1

        // T12b takeover: 新 worker が新 lease_version を取得する。
        const takeoverResult = await asTenant(userAId, (tx) =>
          claimOperationTx(tx, { id: userAId }, operationId),
        )
        expect(takeoverResult.outcome).toBe('prepared_taken_over')
        if (takeoverResult.outcome !== 'prepared_taken_over') throw new Error('unreachable')
        const newLeaseVersion = takeoverResult.leaseVersion
        expect(newLeaseVersion).toBe(2)
        expect(newLeaseVersion).toBeGreaterThan(oldLeaseVersion)

        // 旧 worker が(takeover を知らず)自分の古い lease_version で publish
        // しようとする → T12a の final-defense fencing が拒否(stale・cards 0)。
        const oldWorkerResult = await publishPreparedUpload({
          operationId,
          leaseVersion: oldLeaseVersion,
        })
        expect(oldWorkerResult).toEqual({ outcome: 'stale' })
        expect(await countCards(userAId)).toBe(0)
        const rowAfterOldAttempt = await readOperationRow(operationId)
        expect(rowAfterOldAttempt?.status).toBe('prepared') // 旧 worker は何も書けない

        // 新 worker(takeover 後の lease_version)で publish → 正常に成功する。
        const newWorkerResult = await publishPreparedUpload({
          operationId,
          leaseVersion: newLeaseVersion,
        })
        expect(newWorkerResult).toMatchObject({ outcome: 'published', cardsPublished: 1 })
        expect(await countCards(userAId)).toBe(1)
        const rowAfterPublish = await readOperationRow(operationId)
        expect(rowAfterPublish?.status).toBe('completed')
      })
    })
  })

  // --- not-claimable / not-found ---
  describe('not-claimable / not-found', () => {
    it('a nonexistent operationId returns not_found', async () => {
      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, randomUUID()),
      )
      expect(result.outcome).toBe('not_found')
    })

    it('a malformed (non-UUID) operationId returns not_found without hitting the DB with a bad cast', async () => {
      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, 'not-a-uuid'),
      )
      expect(result.outcome).toBe('not_found')
    })

    it("another user's operation is not claimable by the caller (owner scope) → not_found, foreign row untouched", async () => {
      const { operationId } = await seedOperation(userBId)

      const result = await asTenant(userAId, (tx) =>
        claimOperationTx(tx, { id: userAId }, operationId),
      )
      expect(result.outcome).toBe('not_found')

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('awaiting_sources')
      expect(row?.leaseVersion).toBe(0)
    })
  })
})
