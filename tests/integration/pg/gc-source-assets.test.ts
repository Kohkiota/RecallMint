// ②-4a Task 14b′(2026-08-03・軸反転): source_assets GC lane(scripts/gc-image-assets.ts
// の source lane・**網 = 二次防御**)の real-PG 破壊 end-to-end 検証。
//
// 新軸(OT 確定): source(OCR 元画像)は著作物の疑いゆえ R2 に残さない。risk 軸 =
// provenance(asset_derivations)消失は許容 / source が R2 に消え残ることは
// 受容しない(最優先)。旧 T14b(retention GC)はこの反対方向(source を残す)に
// 最適化されていた — 本 file は「残す」ことを pin していた旧 test を「消す」
// ことを pin する形へ反転する(削除でなく反転・brief「撤回で壊れる既存 test」節)。
//
// この file がカバーするのは**網(二次防御)のみ**: 主経路
// (lib/media/source-purge.ts の purgeOperationSources・op terminal 遷移の
// commit 直後に同期 purge)の regression/completeness は
// tests/integration/pg/source-purge.test.ts + 各 action の iso test に別置き。
// この file の②(terminal-op ready の即時 promote)がまさに「網 backstop」の
// 証明(主経路を一切経由せず、terminal op 下に残った ready source を網だけで
// 回収できることを示す)。
//
// なぜ real PG が要る(DI-mock だけでは検出不能): 適格判定は
// `isLiveUploadOperationCondition()`(lib/exams/source-doc-status.ts)を
// upload_operations に対する相関 EXISTS/NOT EXISTS で埋め込んだ実 SQL であり、
// 三値論理(lease NULL 等)の正しさは実 PostgreSQL 上でしか確認できない
// (gc-abandoned-operations.test.ts が real-PG NULL-lease バグを検出した前例と同じ
// 理由)。`buildSourceProductionDeps` は production が使う正確なクエリを iso
// harness に直接注入するための export(gc-abandoned-operations.ts の
// buildProductionDeps と同じ設計)。
//
// R2 は mock する(実 R2 を叩かない・§C1 の禁則。source-asset-finalize.test.ts と
// 同じ vi.mock パターン)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import {
  assetDerivations,
  assets,
  exams,
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  users,
} from '@/lib/db/schema'
import { PREPARED_RETENTION_MS } from '@/lib/exams/derive-exam-statuses'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockDeleteObject } = vi.hoisted(() => ({ mockDeleteObject: vi.fn() }))

vi.mock('@/lib/storage/r2', () => ({
  deleteObject: mockDeleteObject,
}))

// vi.mock は import より前に hoist されるため top-level import で問題ない
// (source-asset-finalize.test.ts と同じ方針)。
import {
  buildSourceProductionDeps,
  runSourceReconciler,
  SOURCE_RESERVED_NET_GRACE_MS,
} from '@/scripts/gc-image-assets'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const MIN_MS = 60 * 1000
// Class A(reserved-not-live)専用 margin(16分)の境界を試験するための基準時刻。
const OLD_CREATED = new Date(Date.now() - (SOURCE_RESERVED_NET_GRACE_MS + 10 * MIN_MS)) // margin 超
const RECENT_CREATED = new Date(Date.now() - 5 * MIN_MS) // margin 未満
const OP_RECENT = new Date(Date.now() - 1 * MIN_MS) // PREPARED_RETENTION_MS(7日)以内 = live

async function seedUser(): Promise<string> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_${userId}` })
  return userId
}

async function seedExam(userId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const examId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
  return examId
}

async function seedSourceDocument(userId: string, examId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const sourceDocumentId = randomUUID()
  await owner.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'image',
    filename: 'doc.png',
    fileSizeBytes: 100,
  })
  return sourceDocumentId
}

async function seedOp(
  userId: string,
  examId: string,
  sourceDocumentId: string,
  overrides: Partial<{
    status: 'awaiting_sources' | 'claimed' | 'prepared' | 'completed' | 'terminal_failed'
    createdAt: Date
    leaseExpiresAt: Date | null
  }> = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId,
    idempotencyKey: `idem-${operationId}`,
    examId,
    sourceDocumentId,
    status: overrides.status ?? 'awaiting_sources',
    expectedSourceCount: 1,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
  })
  return operationId
}

async function seedSourceAsset(
  userId: string,
  sourceDocumentId: string,
  overrides: Partial<{
    status: 'reserved' | 'ready' | 'deleting'
    createdAt: Date
  }> = {},
): Promise<{ id: string; objectKey: string }> {
  const owner = getFixtureOwnerDb()
  const id = randomUUID()
  const objectKey = `sources/${userId}/${id}.webp`
  await owner.insert(sourceAssets).values({
    id,
    userId,
    sourceDocumentId,
    sourceId: `s-${id}`,
    objectKey,
    mime: 'image/webp',
    byteSize: 100,
    status: overrides.status ?? 'reserved',
    originalFilename: 'orig.webp',
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
  })
  return { id, objectKey }
}

async function readSourceAsset(id: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner.select().from(sourceAssets).where(eq(sourceAssets.id, id))
  return rows[0]
}

// 軸反転(旧 Finding 1 の noDerivations guard 撤去)を pin するための helper:
// 図版が crop 済(assets + asset_derivations 行 commit 済・crop-and-store.ts の
// writeCropAssetRows 相当)の状態を直接 seed する。新軸ではこの生存 provenance が
// あっても source を purge してよい(旧軸は逆に RETAIN していた)。
async function seedDerivation(userId: string, sourceAssetId: string): Promise<string> {
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
    status: 'ready',
  })
  await owner.insert(assetDerivations).values({
    assetId,
    userId,
    sourceAssetId,
    origBbox: { x: 0, y: 0, w: 10, h: 10 },
    paddingPct: 0.1,
    clampedBbox: { x: 0, y: 0, w: 10, h: 10 },
    cropW: 10,
    cropH: 10,
    detectTarget: 'figure',
    pipelineVersion: 'v1',
  })
  return assetId
}

beforeEach(async () => {
  await truncateAllUserTables()
  mockDeleteObject.mockReset()
  mockDeleteObject.mockResolvedValue({ ok: true, status: 200 })
})

describe('gc-image-assets source lane (T14b′・網) — 実 PG 破壊 end-to-end', () => {
  it('① Class A(stale reserved・op 不在): margin 超 reserved + owning op 無し → promote(deleting) → R2 delete → 行 DELETE', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    // op を一切 seed しない(op 不在ケース = 防御既定で reserved は eligible)。
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(1)
    expect(summary.r2DeleteOk).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
  })

  it('② Class B(terminal-op ready・網 backstop の核心): grace 無しで即 promote — 作成直後(margin 未満)の ready でも op が terminal_failed なら即座に GC される', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    await seedOp(userId, examId, sourceDocumentId, {
      status: 'terminal_failed',
      createdAt: OLD_CREATED,
    })
    // 軸反転の核心: RECENT_CREATED(margin 未満)でも Class B は grace 無しゆえ
    // promote される(旧軸は grace 判定があったが、新軸の Class B に grace は無い)。
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'ready',
      createdAt: RECENT_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
  })

  // 軸反転(旧③「RETAIN: completed-op ready は GC されない」を反転): 新軸は
  // completed も Class B の対象に含める(brief 冒頭「新軸」= 正常完走 source の
  // 永続 RETAIN が最重要の違反だった)。
  it('③ 軸反転: completed-op ready も GC される(旧 RETAIN を撤回)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    await seedOp(userId, examId, sourceDocumentId, {
      status: 'completed',
      createdAt: OLD_CREATED,
    })
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'ready',
      createdAt: RECENT_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
  })

  it('④ live-op 除外: reserved source 自体は margin 超だが owning op が live(直近作成・非終端)→ GC されない', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    await seedOp(userId, examId, sourceDocumentId, {
      status: 'awaiting_sources',
      createdAt: OP_RECENT, // PREPARED_RETENTION_MS 以内 = live
      leaseExpiresAt: null,
    })
    const { id } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: OLD_CREATED, // source 自体は margin 超だが op が live
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(0)
    expect(mockDeleteObject).not.toHaveBeenCalled()
    const row = await readSourceAsset(id)
    expect(row?.status).toBe('reserved')
  })

  it('live-op 除外(lease 版): op が PREPARED_RETENTION_MS 超だが有効 lease 保持中 → GC されない(concurrently-advancing operation 保護)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    await seedOp(userId, examId, sourceDocumentId, {
      status: 'claimed',
      createdAt: new Date(Date.now() - PREPARED_RETENTION_MS - 60_000), // 7日+1分前
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // 有効 lease
    })
    const { id } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(0)
    expect((await readSourceAsset(id))?.status).toBe('reserved')
  })

  it('⑤ dry-run: write ゼロ(promote/R2/行 DELETE 一切なし)。予告のみ返す', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: true, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    // 予告としては eligible 1 件を報告するが、
    expect(summary.promoted).toBe(1)
    expect(summary.reclaimed).toEqual([{ id, objectKey }])
    // 実書込はゼロ: R2 未呼出・status 不変。
    expect(mockDeleteObject).not.toHaveBeenCalled()
    const row = await readSourceAsset(id)
    expect(row?.status).toBe('reserved')
  })

  it('⑥ decouple order pin: R2 delete 失敗 → 行は deleting のまま残る(R2 success-equivalent 確認前に行 DELETE しない)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })
    mockDeleteObject.mockResolvedValueOnce({ ok: false, status: 500 })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    // promote 自体は起きた(status='deleting' に遷移済)が、R2 失敗ゆえ行は残る。
    expect(summary.promoted).toBe(1)
    expect(summary.r2DeleteFailed).toBe(1)
    expect(summary.rowDeleteOk).toBe(0)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    // 決定的な pin: 行 DELETE は R2 失敗時に一切呼ばれない(逆順なら object_key を
    // 喪失した状態で行だけ消え R2 orphan を残す — この test はそれが起きないことの証明)。
    const row = await readSourceAsset(id)
    expect(row).toBeDefined()
    expect(row?.status).toBe('deleting')
  })

  it('crash 復旧: 前 run で deleting のまま残った source を次 run が拾い、R2 404(冪等)でも回収する', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    // 前 run で promote 済 → deleting のまま残置された状態を直接 seed で再現する。
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'deleting',
      createdAt: OLD_CREATED,
    })
    mockDeleteObject.mockResolvedValueOnce({ ok: true, status: 404 })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    // すでに deleting ゆえ promote 対象外(0 件)だが collect が拾って回収する。
    expect(summary.promoted).toBe(0)
    expect(summary.r2Delete404).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
  })

  it('margin 未満(まだ猶予)の reserved は promote されない', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    const { id } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: RECENT_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(0)
    expect((await readSourceAsset(id))?.status).toBe('reserved')
  })

  it('--user scope: 他 user の GC 対象 source は対象外(owner-scope 貫通)', async () => {
    const userA = await seedUser()
    const examA = await seedExam(userA)
    const sourceDocA = await seedSourceDocument(userA, examA)
    const { id: idA } = await seedSourceAsset(userA, sourceDocA, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })

    const userB = await seedUser()
    const examB = await seedExam(userB)
    const sourceDocB = await seedSourceDocument(userB, examB)
    const { id: idB } = await seedSourceAsset(userB, sourceDocB, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId: userA },
      buildSourceProductionDeps(db, userA, mockDeleteObject),
    )

    expect(summary.promoted).toBe(1)
    expect(await readSourceAsset(idA)).toBeUndefined() // A は回収された
    expect((await readSourceAsset(idB))?.status).toBe('reserved') // B は無傷
  })

  // 軸反転(旧 Finding 1「asset_derivations 子行を持つ source を RETAIN」を撤回):
  // 図版が crop 済(生きた asset_derivations 子行あり)で op が terminal_failed の
  // ready source は、新軸では derivation の生死に関わらず即座に GC される
  // (provenance 消失は許容・brief 冒頭「新軸」節)。cascade で derivation も
  // 道連れに消えることを直接 SELECT で確認する。
  it('⑦ 軸反転: 生きた asset_derivations 子を持つ ready+terminal_failed source も GC される(provenance 道連れ消失を許容)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    await seedOp(userId, examId, sourceDocumentId, {
      status: 'terminal_failed',
      createdAt: OLD_CREATED,
    })
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'ready',
      createdAt: RECENT_CREATED,
    })
    await seedDerivation(userId, id)

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
    // provenance が cascade で道連れに消えたことを直接確認(新軸で許容する事実)。
    const derivationRows = await getFixtureOwnerDb()
      .select()
      .from(assetDerivations)
      .where(eq(assetDerivations.sourceAssetId, id))
    expect(derivationRows).toHaveLength(0)
  })

  // 軸反転(旧 Finding 2「reserved + completed op は RETAIN(自己完結ガード)」を
  // 撤回): completed は isLiveUploadOperationCondition() の対象外(isLive は
  // 元々偽)なので、明示ガードが無くても Class A の「op not-live」だけで eligible
  // になる(source-asset-state.ts コメント参照)。
  it('⑧ 軸反転: reserved + completed op も GC される(旧 RETAIN-completed を撤回)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    await seedOp(userId, examId, sourceDocumentId, {
      status: 'completed',
      createdAt: OLD_CREATED,
    })
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'reserved',
      createdAt: OLD_CREATED,
    })

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    expect(summary.promoted).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
  })

  // Finding 3(Codex・旧軸から不変): dry-run は promote 予告だけでなく、前 run の
  // R2 失敗/crash で残置された既存 deleting 行(実 --sweep なら collect される)も
  // write ゼロで予告しなければならない(asset lane の dry-run collect 予告と同型)。
  it('⑨ dry-run は既存 deleting 行(前 run 残置)も予告する(write ゼロ)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    // 前 run で promote 済 → deleting のまま残置された状態を直接 seed。
    const { id: deletingId, objectKey: deletingKey } = await seedSourceAsset(
      userId,
      sourceDocumentId,
      { status: 'deleting', createdAt: OLD_CREATED },
    )
    // さらに新規 promote 予告対象(reserved・op 不在)も同時に存在させる。
    const { id: reservedId, objectKey: reservedKey } = await seedSourceAsset(
      userId,
      sourceDocumentId,
      { status: 'reserved', createdAt: OLD_CREATED },
    )

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: true, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    // promote 予告は reserved の 1 件のみ(deleting は promote 対象の母集団に
    // 含まれない — 既に promote 済のため)。
    expect(summary.promoted).toBe(1)
    // reclaimed には両方(promote 予告 + 既存 deleting の collect 予告)が入る。
    expect(summary.reclaimed).toEqual(
      expect.arrayContaining([
        { id: reservedId, objectKey: reservedKey },
        { id: deletingId, objectKey: deletingKey },
      ]),
    )
    expect(summary.reclaimed).toHaveLength(2)
    // write ゼロ: R2 未呼出・両行とも status 不変。
    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect((await readSourceAsset(deletingId))?.status).toBe('deleting')
    expect((await readSourceAsset(reservedId))?.status).toBe('reserved')
  })

  // 軸反転(旧 Finding 5「collect 直前に derivation が付いた deleting source は
  // self-heal(ready に復元)」を撤回): self-heal 機構そのものが無くなったため、
  // collect 直前に derivation が付いても関係なく削除される(TOCTOU 窓の race
  // 自体は残るが、新軸ではその race が起きても「provenance が消える」方向にしか
  // 振れない=許容範囲・brief §5 到達不能論拠の再検証)。
  it('⑩ 軸反転: collect 直前に asset_derivations が付いた deleting source も self-heal せず削除される(旧 Finding 5 self-heal を撤去)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    // 「promote 済で collect 待ち」の状態を直接 seed。
    const { id, objectKey } = await seedSourceAsset(userId, sourceDocumentId, {
      status: 'deleting',
      createdAt: OLD_CREATED,
    })
    // 旧 Finding 5 が想定した race の再現: collect 直前に derivation が付く。
    await seedDerivation(userId, id)

    const db = getFixtureOwnerDb()
    const summary = await runSourceReconciler(
      { dryRun: false, userId },
      buildSourceProductionDeps(db, userId, mockDeleteObject),
    )

    // self-heal しない: R2 削除 + 行 DELETE が実行される。
    expect(summary.rowDeleteOk).toBe(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(await readSourceAsset(id)).toBeUndefined()
    // derivation も cascade で消える(新軸が許容する provenance 消失)。
    const derivationRows = await getFixtureOwnerDb()
      .select()
      .from(assetDerivations)
      .where(eq(assetDerivations.sourceAssetId, id))
    expect(derivationRows).toHaveLength(0)
  })
})
