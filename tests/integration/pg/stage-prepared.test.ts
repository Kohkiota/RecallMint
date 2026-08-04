// ②-4a Phase C Task 8b: stagePrepared(OCR → 正規化 → stage payload)の実 PG 検証。
//
// R2(getObject)/Gemini(callGemini)を mock し(実 R2・実 Gemini を叩かない・
// CLAUDE.md AI 絶対ルール 3)、fencing(claimed + lease_version 一致)・
// prepared_payload の atomic 保存・非 terminal failure(retryable_failed /
// empty)の DB 永続を実 PG 上で検証する。 parseRetryAfterMs は実装のまま
// (importOriginal・プレーン Error には反応せず null を返すだけの pure fn)。
//
// stagePrepared は Clerk 認証を持たない claimOperationTx とは異なり、内部で
// 複数回 withTenantTx を開く多段オーケストレーションのため(brief: 外部 I/O は
// tx の外)、Tx-suffix 変種は無い — source-asset-finalize.test.ts と同じ流儀で
// getCurrentUser を mock し、exported Server Action (`stagePrepared`) を直接叩く。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import { exams, sourceAssets, sourceDocuments, uploadOperations, users } from '@/lib/db/schema'
import { preparedPayloadSchema } from '@/lib/ocr/prepared-schema'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockGetCurrentUser, mockGetObject, mockCallGemini, mockDeleteObject } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockGetObject: vi.fn(),
  mockCallGemini: vi.fn(),
  mockDeleteObject: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

// deleteObject: ②-4a Task 14b′ の purgeOperationSourcesForOp(stagePrepared が
// terminal_failed 観測後に呼ぶ)向け。
vi.mock('@/lib/storage/r2', () => ({
  getObject: mockGetObject,
  deleteObject: mockDeleteObject,
}))

// parseRetryAfterMs は実実装のまま使う(プレーン Error には反応せず null を返す
// だけの pure fn・stage-prepared-retry.test.ts と同じ importOriginal 方式)。
vi.mock('@/lib/ai/clients/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/clients/gemini')>()
  return { ...actual, callGemini: mockCallGemini }
})

// vi.mock は import より前に hoist されるため top-level import で問題ない
// (source-asset-finalize.test.ts と同じ方針)。
import { stagePrepared } from '@/app/(app)/app/upload/_actions/stage-prepared'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

type SeedOperationOverrides = Partial<{
  status: 'awaiting_sources' | 'claimed' | 'prepared' | 'completed' | 'terminal_failed'
  leaseVersion: number
  leaseExpiresAt: Date | null
  attemptCount: number
  expectedSourceCount: number
  lastErrorCode: string | null
  nextRetryAt: Date | null
}>

async function seedOperation(
  userId: string,
  overrides: SeedOperationOverrides = {},
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
    idempotencyKey: `idem-${operationId}`,
    examId,
    sourceDocumentId,
    status: overrides.status ?? 'claimed',
    leaseVersion: overrides.leaseVersion ?? 1,
    leaseExpiresAt: overrides.leaseExpiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
    attemptCount: overrides.attemptCount ?? 1,
    expectedSourceCount: overrides.expectedSourceCount ?? 1,
    lastErrorCode: overrides.lastErrorCode ?? null,
    nextRetryAt: overrides.nextRetryAt ?? null,
  })
  return { operationId, examId, sourceDocumentId }
}

async function seedReadySourceAsset(
  userId: string,
  sourceDocumentId: string,
  sourceId: string,
  overrides: Partial<{ mime: string | null }> = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const assetId = randomUUID()
  await owner.insert(sourceAssets).values({
    id: assetId,
    userId,
    sourceDocumentId,
    sourceId,
    objectKey: `users/${userId}/src/${assetId}.png`,
    mime: overrides.mime === undefined ? 'image/png' : overrides.mime,
    contentHash: `hash-${assetId}`,
    byteSize: 1000,
    width: 100,
    height: 100,
    status: 'ready',
    originalFilename: `${sourceId}.png`,
    readyAt: new Date(),
  })
  return assetId
}

async function readOperationRow(operationId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select()
    .from(uploadOperations)
    .where(eq(uploadOperations.id, operationId))
  return rows[0]
}

function validGeminiResponseText(sourceId: string): string {
  return JSON.stringify({
    cards: [
      {
        title: '問1',
        question_text: 'リード文',
        options: [
          { id: 'a', text: '選択肢A', is_correct: true },
          { id: 'b', text: '選択肢B', is_correct: false },
        ],
        correct_answer_ids: ['a'],
        images: [],
        figure_regions: [{ source_id: sourceId, box_2d: [100, 100, 200, 200], target: 'question' }],
      },
    ],
  })
}

describe('stagePrepared (T8b)', () => {
  let userAId: string
  let userBId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetCurrentUser.mockReset()
    mockGetObject.mockReset()
    mockCallGemini.mockReset()
    mockDeleteObject.mockReset()
    mockDeleteObject.mockResolvedValue({ ok: true, status: 200 })

    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
    mockGetCurrentUser.mockResolvedValue({ id: userAId })
    mockGetObject.mockResolvedValue({ bytes: Buffer.from('fake-image-bytes') })
  })

  // --- (a) happy path ---
  it('happy path: claimed op + 1 ready source → Gemini mock returns a valid exploration response → stages prepared_payload/hash/schema_version and transitions claimed→prepared', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, { leaseVersion: 1 })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
    mockCallGemini.mockResolvedValueOnce({
      text: validGeminiResponseText('s1'),
      inputTokens: 100,
      outputTokens: 50,
      thoughtsTokens: 0,
    })

    const result = await stagePrepared({ operationId, leaseVersion: 1 })
    expect(result).toMatchObject({ outcome: 'staged', cardsTotal: 1, cardsExcluded: 0 })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('prepared')
    expect(row?.preparedSchemaVersion).toBe(1)
    expect(row?.preparedHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.preparedPayload).toBeTruthy()
    // 保存された payload が preparedPayloadSchema をそのまま通ることを確認
    // (T12 publisher が読む契約そのもの)。
    const parsed = preparedPayloadSchema.parse(row?.preparedPayload)
    expect(parsed.cards).toHaveLength(1)
    expect(parsed.cards[0].figures).toHaveLength(1)
    expect(parsed.cards[0].figures[0].sourceId).toBe('s1')

    expect(mockGetObject).toHaveBeenCalledWith(expect.stringContaining(`users/${userAId}/src/`))
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })

  // --- review fix(canonical Minor / Codex Important): success clears stale failure metadata ---
  it('a successful stage clears stale last_error_code/next_retry_at left by a prior retryable-failed attempt (attempt_count is left untouched as history)', async () => {
    const priorNextRetryAt = new Date(Date.now() - 30_000) // 到達済み(過去)
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      leaseVersion: 1,
      attemptCount: 2,
      lastErrorCode: 'gemini_call_failed',
      nextRetryAt: priorNextRetryAt,
    })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
    mockCallGemini.mockResolvedValueOnce({
      text: validGeminiResponseText('s1'),
      inputTokens: 100,
      outputTokens: 50,
      thoughtsTokens: 0,
    })

    const result = await stagePrepared({ operationId, leaseVersion: 1 })
    expect(result).toMatchObject({ outcome: 'staged' })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('prepared')
    expect(row?.lastErrorCode).toBeNull()
    expect(row?.nextRetryAt).toBeNull()
    // attempt_count は履歴として維持(このパスでは触らない)。
    expect(row?.attemptCount).toBe(2)
  })

  // --- (b) fencing ---
  it('fencing: leaseVersion mismatch (takeover happened) → stale, no payload written, status unchanged', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, { leaseVersion: 5 })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')

    // caller は古い(takeover 前の)leaseVersion=3 を持って stage しようとする。
    const result = await stagePrepared({ operationId, leaseVersion: 3 })
    expect(result).toEqual({ outcome: 'stale' })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('claimed')
    expect(row?.leaseVersion).toBe(5)
    expect(row?.preparedPayload).toBeNull()
    expect(mockCallGemini).not.toHaveBeenCalled()
    expect(mockGetObject).not.toHaveBeenCalled()
  })

  // --- [Critical fix] manifest re-validation: source vanished/went non-ready between claim and stage ---
  describe('source manifest re-validation (claim↔stage race / GC-GDPR)', () => {
    it('a source row deleted after claim (row count < expected_source_count) → does NOT call Gemini, does NOT write a payload, transitions to terminal_failed with source_manifest_incomplete', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        leaseVersion: 1,
        expectedSourceCount: 2,
      })
      const assetId1 = await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
      const assetId2 = await seedReadySourceAsset(userAId, sourceDocumentId, 's2')
      // claim 後の GC/GDPR race を模す: s1 の行が消える(claim は 2 件とも
      // ready を確認済みだったはず — stage 時点で 1 件しか残っていない)。
      await getFixtureOwnerDb().delete(sourceAssets).where(eq(sourceAssets.id, assetId1))

      const result = await stagePrepared({ operationId, leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'terminal_failed', reason: 'source_manifest_incomplete' })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
      expect(row?.lastErrorCode).toBe('source_manifest_incomplete')
      expect(row?.resultSummary).toMatchObject({
        reason: 'source_manifest_incomplete',
        expected: 2,
        actual: 1,
      })
      expect(row?.preparedPayload).toBeNull()
      expect(mockCallGemini).not.toHaveBeenCalled()
      expect(mockGetObject).not.toHaveBeenCalled()

      // ②-4a Task 14b′ 主経路 completeness(loadFencedSourceManifest 経由の
      // terminal): この op に残っていた s2(ready)も purge される。
      expect(mockDeleteObject).toHaveBeenCalledWith(`users/${userAId}/src/${assetId2}.png`)
      const remaining = await getFixtureOwnerDb()
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId2))
      expect(remaining).toHaveLength(0)
    })

    it('a source row transitions to deleting after claim (all rows present, one non-ready) → terminal_failed, no Gemini call, no payload', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        leaseVersion: 1,
        expectedSourceCount: 2,
      })
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
      const assetId2 = await seedReadySourceAsset(userAId, sourceDocumentId, 's2')
      // claim 後に GC が s2 を deleting へ遷移させたケース(行数は一致するが
      // 全行 ready ではない)。
      await getFixtureOwnerDb()
        .update(sourceAssets)
        .set({ status: 'deleting' })
        .where(eq(sourceAssets.id, assetId2))

      const result = await stagePrepared({ operationId, leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'terminal_failed', reason: 'source_manifest_incomplete' })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
      expect(row?.lastErrorCode).toBe('source_manifest_incomplete')
      expect(row?.preparedPayload).toBeNull()
      expect(mockCallGemini).not.toHaveBeenCalled()
      expect(mockGetObject).not.toHaveBeenCalled()
    })

    it('full manifest intact (control) → stages successfully, unaffected by the new manifest check', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        leaseVersion: 1,
        expectedSourceCount: 2,
      })
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
      await seedReadySourceAsset(userAId, sourceDocumentId, 's2')
      mockCallGemini.mockResolvedValueOnce({
        text: JSON.stringify({
          cards: [
            {
              title: '問1',
              question_text: 'リード文',
              options: [
                { id: 'a', text: '選択肢A', is_correct: true },
                { id: 'b', text: '選択肢B', is_correct: false },
              ],
              correct_answer_ids: ['a'],
              images: [],
              figure_regions: [
                { source_id: 's1', box_2d: [100, 100, 200, 200], target: 'question' },
              ],
            },
          ],
        }),
        inputTokens: 100,
        outputTokens: 50,
        thoughtsTokens: 0,
      })

      const result = await stagePrepared({ operationId, leaseVersion: 1 })
      expect(result).toMatchObject({ outcome: 'staged' })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('prepared')
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      expect(mockGetObject).toHaveBeenCalledTimes(2)
    })

    // --- [Critical fix #1] atomic re-check at stage-save time ---
    it('a source is deleted DURING the R2/Gemini window (after the early fast-fail read, before stage-save) → the atomic re-check at stage-save catches it → terminal_failed, no payload committed', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        leaseVersion: 1,
        expectedSourceCount: 1,
      })
      const assetId1 = await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
      // 手順1(fast-fail 読取)は通過させた上で、手順3(Gemini call・mock)の
      // 実行タイミングに合わせて source を削除する — これは実運用で「手順1 の
      // tx が commit した後・手順6 の stage-save tx が始まる前」に GC/GDPR が
      // 割り込む race を、Gemini mock の実行時点を借りて再現したもの(R2 GET は
      // 手順1 直後に既に成功しているため、Gemini call のタイミングが
      // 「手順1〜手順6 の間」を代表する)。
      mockCallGemini.mockImplementationOnce(async () => {
        await getFixtureOwnerDb().delete(sourceAssets).where(eq(sourceAssets.id, assetId1))
        return {
          text: validGeminiResponseText('s1'),
          inputTokens: 100,
          outputTokens: 50,
          thoughtsTokens: 0,
        }
      })

      const result = await stagePrepared({ operationId, leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'terminal_failed', reason: 'source_manifest_incomplete' })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('terminal_failed')
      expect(row?.lastErrorCode).toBe('source_manifest_incomplete')
      expect(row?.resultSummary).toMatchObject({
        reason: 'source_manifest_incomplete',
        expected: 1,
        actual: 0,
      })
      expect(row?.preparedPayload).toBeNull()
      // R2/Gemini は実際に呼ばれた(手順1 の fast-fail は通過していた)— この
      // test の核心は「呼ばれた後でも payload を commit しない」こと。
      expect(mockGetObject).toHaveBeenCalledTimes(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
    })

    // ②-4a Task 14b′ 主経路 completeness(stageSaveCas 経由の terminal): 手順1
    // (fast-fail 読取)は 2 件とも ready で通過させ、Gemini call のタイミングで
    // 1 件(s1)だけ削除する(s2 は残す)。stageSaveCas の atomic re-check が
    // 行数不一致(1 < 2)を検出して terminal 化する経路であり、上のテストとは
    // 異なり残存 source(s2)が存在する — その s2 が purge されることを確認する。
    it('stageSaveCas の atomic re-check が terminal 化した後、残存 source も purge される', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        leaseVersion: 1,
        expectedSourceCount: 2,
      })
      const assetId1 = await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
      const assetId2 = await seedReadySourceAsset(userAId, sourceDocumentId, 's2')
      mockCallGemini.mockImplementationOnce(async () => {
        await getFixtureOwnerDb().delete(sourceAssets).where(eq(sourceAssets.id, assetId1))
        return {
          text: validGeminiResponseText('s1'),
          inputTokens: 100,
          outputTokens: 50,
          thoughtsTokens: 0,
        }
      })

      const result = await stagePrepared({ operationId, leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'terminal_failed', reason: 'source_manifest_incomplete' })
      expect((await readOperationRow(operationId))?.status).toBe('terminal_failed')

      expect(mockDeleteObject).toHaveBeenCalledWith(`users/${userAId}/src/${assetId2}.png`)
      const remaining = await getFixtureOwnerDb()
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId2))
      expect(remaining).toHaveLength(0)
    })

    // --- [Important fix #2] source_id-ordered OCR request, independent of DB insertion order ---
    it('builds the Gemini parts in source_id order, not DB insertion/id order', async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userAId, {
        leaseVersion: 1,
        expectedSourceCount: 2,
      })
      // s2 を先に INSERT する(挿入順 = id 採番順は source_id の逆順)。
      // loadFencedSourceManifest の ORDER BY sourceAssets.sourceId により、
      // 挿入順に関わらず s1 が先に来ることを検証する。
      await seedReadySourceAsset(userAId, sourceDocumentId, 's2')
      await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
      mockCallGemini.mockResolvedValueOnce({
        text: JSON.stringify({ cards: [] }),
        inputTokens: 1,
        outputTokens: 1,
        thoughtsTokens: 0,
      })

      await stagePrepared({ operationId, leaseVersion: 1 })

      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      const callArg = mockCallGemini.mock.calls[0][0] as { parts: unknown[] }
      // buildSourceIdInterleavedParts の出力形: [text(source_id=X), inlineData, ...] × N, text(prompt)。
      expect(callArg.parts[0]).toEqual({ text: 'source_id=s1' })
      expect(callArg.parts[2]).toEqual({ text: 'source_id=s2' })
    })
  })

  // --- (c) retryable-failed: Gemini call throws ---
  it('retryable-failed: Gemini call throws (non-transient) → status stays claimed (non-terminal), lease released, next_retry_at set, attempt_count incremented, no payload', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      leaseVersion: 1,
      attemptCount: 1,
    })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
    mockCallGemini.mockRejectedValueOnce(new Error('boom: non-transient failure'))

    const result = await stagePrepared({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'retryable_failed', reason: 'gemini_call_failed' })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('claimed') // status maintained (spec §2)
    expect(row?.leaseExpiresAt).toBeNull() // lease released
    expect(row?.nextRetryAt).not.toBeNull()
    expect(row?.lastErrorCode).toBe('gemini_call_failed')
    expect(row?.attemptCount).toBe(2) // incremented
    expect(row?.preparedPayload).toBeNull()
  })

  // --- retryable-failed: JSON parse failure ---
  it('retryable-failed: unparseable Gemini JSON → status stays claimed, no payload', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, { leaseVersion: 1 })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
    mockCallGemini.mockResolvedValueOnce({
      text: '{ not json',
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })

    const result = await stagePrepared({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'retryable_failed', reason: 'json_parse_failed' })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('claimed')
    expect(row?.preparedPayload).toBeNull()
  })

  // --- (d) 0-valid-cards ---
  it('0-valid-cards: Gemini responds with cards:[] → empty outcome, status stays claimed (non-terminal), no payload', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, { leaseVersion: 1 })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
    mockCallGemini.mockResolvedValueOnce({
      text: JSON.stringify({ cards: [] }),
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })

    const result = await stagePrepared({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'empty', cardsTotal: 0, cardsExcluded: 0 })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('claimed')
    expect(row?.lastErrorCode).toBe('empty_cards')
    expect(row?.preparedPayload).toBeNull()
  })

  // --- (e) idempotency / no-double-save ---
  it('idempotency: staging an already-prepared operation (status !== claimed) is rejected as stale, not re-staged', async () => {
    const existingPayload = {
      schemaVersion: 1,
      cards: [],
      cardsTotal: 0,
      cardsExcluded: 0,
      figuresExcluded: {
        coordinate_null: 0,
        source_id_invalid: 0,
        malformed: 0,
        asset_id_invalid: 0,
      },
    }
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'prepared',
      leaseVersion: 1,
    })
    await seedReadySourceAsset(userAId, sourceDocumentId, 's1')
    await getFixtureOwnerDb()
      .update(uploadOperations)
      .set({
        preparedPayload: existingPayload,
        preparedHash: 'existing-hash',
        preparedSchemaVersion: 1,
      })
      .where(eq(uploadOperations.id, operationId))

    const result = await stagePrepared({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'stale' })

    const row = await readOperationRow(operationId)
    expect(row?.status).toBe('prepared')
    // 既存 payload が上書きされていない(再 stage されていない)。
    expect(row?.preparedHash).toBe('existing-hash')
    expect(mockCallGemini).not.toHaveBeenCalled()
  })

  // --- not-claimable / not-found ---
  // 未認証分岐(getCurrentUser throws UnauthenticatedError)は iso では検証しない
  // — static top-level import と test 内 dynamic import で `UnauthenticatedError`
  // が別 module instance を返しうる既知の挙動(asset-actions.test.ts /
  // source-asset-actions.test.ts のコメント参照)があり、本 iso suite の SUT
  // import は static のため、既存 iso 姉妹 suite(source-asset-finalize.test.ts)
  // と同じくこの分岐は対象外とする(unit test で担保する領域)。
  describe('not-claimable / not-found', () => {
    it('nonexistent operationId → not_found', async () => {
      const result = await stagePrepared({ operationId: randomUUID(), leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'not_found' })
    })

    it("another user's operation is not stageable by the caller (owner scope) → not_found, foreign row untouched", async () => {
      const { operationId, sourceDocumentId } = await seedOperation(userBId, { leaseVersion: 1 })
      await seedReadySourceAsset(userBId, sourceDocumentId, 's1')

      const result = await stagePrepared({ operationId, leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'not_found' })

      const row = await readOperationRow(operationId)
      expect(row?.status).toBe('claimed')
      expect(row?.preparedPayload).toBeNull()
      expect(mockCallGemini).not.toHaveBeenCalled()
    })

    it('malformed (non-UUID) operationId → not_found without hitting the DB with a bad cast', async () => {
      const result = await stagePrepared({ operationId: 'not-a-uuid', leaseVersion: 1 })
      expect(result).toEqual({ outcome: 'not_found' })
    })
  })
})
