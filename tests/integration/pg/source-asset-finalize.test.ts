// ②-4a Task 5: reserveSource/finalizeSource の実 PG 検証。
//
// reserveSource は owner scope + status='reserved' で既存 T4 reservation 行を
// authorize する(新規 INSERT はしない)。 finalizeSource は R2 GET/verify/PUT を
// mock し(実 R2 を叩かない・§C1 の禁則)、 実 PG 上の reserved→ready CAS が
// TOCTOU 防御込みで正しく動くことを検証する(spec §6.1/§6.2)。 sharp は mock
// しない(finalizeSource が実バイトを検証する経路そのものを確認するため)。
//
// mockPutObject/mockGetObject は簡易 in-memory R2 store(r2Store)を共有し、
// 条件付き PUT(ifNoneMatch)の 404→書込 / 既存→precondition_failed 意味論を
// 再現する(Critical fix: concurrent-finalize race 対処の実体検証に必須)。
// 個々の test は「temp key の GET」だけを mockResolvedValueOnce で上書きし、
// それ以降(final key の GET・putObject)は store 駆動の base 実装に委ねる。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

import { closeDb } from '@/lib/db'
import { exams, sourceAssets, sourceDocuments, users } from '@/lib/db/schema'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockGetCurrentUser, mockPresignPutUrl, mockGetObject, mockPutObject, mockDeleteObject } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockPresignPutUrl: vi.fn(),
    mockGetObject: vi.fn(),
    mockPutObject: vi.fn(),
    mockDeleteObject: vi.fn(),
  }))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/storage/r2', () => ({
  presignPutUrl: mockPresignPutUrl,
  getObject: mockGetObject,
  putObject: mockPutObject,
  deleteObject: mockDeleteObject,
}))

// source-asset-actions.ts は 'use server' file。auth/r2 mock を hoist 済のため
// top-level import で問題ない(vi.mock は import より前に hoist される。
// delete-isolation.test.ts と同じ方針)。
import { reserveSource, finalizeSource } from '@/app/(app)/app/upload/_actions/source-asset-actions'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

describe('source reserve/finalize (T5) — 実 PG', () => {
  let userAId: string
  let userBId: string
  let examAId: string
  let sourceDocAId: string
  let pngBytes: Buffer
  // 簡易 in-memory R2 store: key → { bytes, mime }。 putObject の ifNoneMatch
  // 意味論(既存 key なら 'precondition_failed')・getObject の実体取得を再現する。
  let r2Store: Map<string, { bytes: Buffer; mime: string }>

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetCurrentUser.mockReset()
    mockPresignPutUrl.mockReset()
    mockGetObject.mockReset()
    mockPutObject.mockReset()
    mockDeleteObject.mockReset()
    mockPresignPutUrl.mockResolvedValue('https://r2.example.com/put-signed')

    r2Store = new Map()
    mockGetObject.mockImplementation(async (key: string) => {
      const stored = r2Store.get(key)
      return stored ? { bytes: stored.bytes } : null
    })
    mockPutObject.mockImplementation(
      async (
        key: string,
        bytes: Buffer,
        mime: string,
        options?: { ifNoneMatch?: boolean },
      ) => {
        if (options?.ifNoneMatch && r2Store.has(key)) {
          return 'precondition_failed'
        }
        r2Store.set(key, { bytes: Buffer.from(bytes), mime })
        return 'success'
      },
    )
    // lost-CAS orphan cleanup(Important fix)を実体レベルで検証できるよう、
    // deleteObject は r2Store から実際に該当 key を除去する(best-effort・
    // never-throw の r2.ts 実装と同じ挙動)。
    mockDeleteObject.mockImplementation(async (key: string) => {
      r2Store.delete(key)
      return { ok: true, status: 204 }
    })

    pngBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()

    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
    examAId = randomUUID()
    await owner.insert(exams).values({ id: examAId, userId: userAId, name: 'exam A' })
    sourceDocAId = randomUUID()
    await owner.insert(sourceDocuments).values({
      id: sourceDocAId,
      userId: userAId,
      examId: examAId,
      mode: 'new',
      fileType: 'image',
      filename: 'a.png',
      fileSizeBytes: 1000,
      pagesTotal: 1,
    })
  })

  // seed a lean reservation row (T4 shape: 検証済み5列 NULL, temp objectKey)。
  async function seedReservedRow(
    userId: string,
    status: 'reserved' | 'ready' | 'deleting' = 'reserved',
  ): Promise<string> {
    const assetId = randomUUID()
    const owner = getFixtureOwnerDb()
    await owner.insert(sourceAssets).values({
      id: assetId,
      userId,
      sourceDocumentId: sourceDocAId,
      sourceId: `s-${assetId}`,
      objectKey: `users/${userId}/src/tmp/${assetId}`,
      status,
      sourceKind: 'image',
      originalFilename: 'a.png',
    })
    return assetId
  }

  describe('reserveSource', () => {
    it('authorizes a reserved row owned by the caller and presigns its temp objectKey', async () => {
      const assetId = await seedReservedRow(userAId)
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const r = await reserveSource({ assetId, mime: 'image/webp', byteSize: 1000 })
      expect(r.ok).toBe(true)
      expect(mockPresignPutUrl).toHaveBeenCalledWith(
        `users/${userAId}/src/tmp/${assetId}`,
        'image/webp',
        1000,
      )
    })

    it('rejects a foreign asset (owned by another tenant) and does not presign', async () => {
      const assetId = await seedReservedRow(userBId)
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const r = await reserveSource({ assetId, mime: 'image/webp', byteSize: 1000 })
      expect(r.ok).toBe(false)
      expect(mockPresignPutUrl).not.toHaveBeenCalled()
    })

    it('rejects a non-reserved row (already ready) and does not presign', async () => {
      const assetId = await seedReservedRow(userAId, 'ready')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const r = await reserveSource({ assetId, mime: 'image/webp', byteSize: 1000 })
      expect(r.ok).toBe(false)
      expect(mockPresignPutUrl).not.toHaveBeenCalled()
    })

    it('rejects a non-reserved row (deleting — GC moved it) and does not presign', async () => {
      const assetId = await seedReservedRow(userAId, 'deleting')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const r = await reserveSource({ assetId, mime: 'image/webp', byteSize: 1000 })
      expect(r.ok).toBe(false)
      expect(mockPresignPutUrl).not.toHaveBeenCalled()
    })

    it('rejects a nonexistent assetId and does not presign', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      const r = await reserveSource({
        assetId: randomUUID(),
        mime: 'image/webp',
        byteSize: 1000,
      })
      expect(r.ok).toBe(false)
      expect(mockPresignPutUrl).not.toHaveBeenCalled()
    })
  })

  describe('finalizeSource', () => {
    it('CAS reserved→ready: verifies real bytes, promotes to the final key via conditional PUT, and writes all 5 verified columns + object_key + ready_at + status atomically', async () => {
      const assetId = await seedReservedRow(userAId)
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })

      const r = await finalizeSource(assetId)
      expect(r.ok).toBe(true)

      const finalKey = `users/${userAId}/src/${assetId}.png`
      expect(mockPutObject).toHaveBeenCalledTimes(1)
      expect(mockPutObject).toHaveBeenCalledWith(finalKey, pngBytes, 'image/png', {
        ifNoneMatch: true,
      })
      expect(r2Store.get(finalKey)?.bytes.equals(pngBytes)).toBe(true)

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.status).toBe('ready')
      expect(row.mime).toBe('image/png')
      expect(row.byteSize).toBe(pngBytes.length)
      expect(row.width).toBe(4)
      expect(row.height).toBe(4)
      expect(row.objectKey).toBe(finalKey)
      expect(row.readyAt).not.toBeNull()
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/)
      // 通常系(CAS に勝った)では最終 key の孤児は生まれないが、 promote 元の
      // temp key はもう不要になるため明示 delete される(Important fix)。
      const tempKey = `users/${userAId}/src/tmp/${assetId}`
      expect(mockDeleteObject).toHaveBeenCalledTimes(1)
      expect(mockDeleteObject).toHaveBeenCalledWith(tempKey)
    })

    it('a second finalize on an already-ready row is idempotent and does not re-GET/re-PUT/re-DELETE (temp already gone from the first call does not error)', async () => {
      const assetId = await seedReservedRow(userAId)
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
      const tempKey = `users/${userAId}/src/tmp/${assetId}`

      const first = await finalizeSource(assetId)
      expect(first.ok).toBe(true)
      expect(mockGetObject).toHaveBeenCalledTimes(1)
      expect(mockPutObject).toHaveBeenCalledTimes(1)
      // Important fix: 成功した finalize は promote 元の temp key を明示 delete。
      expect(mockDeleteObject).toHaveBeenCalledTimes(1)
      expect(mockDeleteObject).toHaveBeenCalledWith(tempKey)

      const second = await finalizeSource(assetId)
      expect(second.ok).toBe(true)
      // 冪等: GET/PUT をやり直さない (呼び出し回数が増えない)。 asset.status===
      // 'ready' の早期 return が temp cleanup コードより前に発火するため、
      // (既に消えている)temp key への再 delete も試みない — かつ既に消えた
      // temp を再度 delete しようとしてもエラーにならない(never-throw契約)
      // ことをここで担保する。
      expect(mockGetObject).toHaveBeenCalledTimes(1)
      expect(mockPutObject).toHaveBeenCalledTimes(1)
      expect(mockDeleteObject).toHaveBeenCalledTimes(1)

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select({ status: sourceAssets.status })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      expect(rows[0]?.status).toBe('ready')
    })

    it('a row not in reserved (GC already moved it to deleting) is not resurrected: 0 rows → not-found, no GET/PUT', async () => {
      const assetId = await seedReservedRow(userAId, 'deleting')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const r = await finalizeSource(assetId)
      expect(r.ok).toBe(false)
      expect(mockGetObject).not.toHaveBeenCalled()
      expect(mockPutObject).not.toHaveBeenCalled()
      expect(mockDeleteObject).not.toHaveBeenCalled()

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select({ status: sourceAssets.status })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      // status は deleting のまま変化しない (復活しない)。
      expect(rows[0]?.status).toBe('deleting')
    })

    it('write-time TOCTOU: GC promotes reserved→deleting between the read-tx and the write-tx CAS → 0 rows, not resurrected, AND the orphaned final object (this call\'s successful PUT) is deleted', async () => {
      const assetId = await seedReservedRow(userAId, 'reserved')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      // getObject の副作用として、外部 I/O の最中(read-tx 後・write-tx 前)に GC が
      // 行を deleting へ promote した状況を owner db で直接シミュレートする。
      mockGetObject.mockImplementationOnce(async () => {
        const owner = getFixtureOwnerDb()
        await owner
          .update(sourceAssets)
          .set({ status: 'deleting' })
          .where(eq(sourceAssets.id, assetId))
        return { bytes: pngBytes }
      })

      const finalKey = `users/${userAId}/src/${assetId}.png`
      const r = await finalizeSource(assetId)
      expect(r.ok).toBe(false)

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select({ status: sourceAssets.status, objectKey: sourceAssets.objectKey })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      // CAS の WHERE status='reserved' が 0 行にマッチし、deleting のまま復活しない
      // (object_key も最終 key へ書き換わらない = temp key のまま)。
      expect(rows[0]?.status).toBe('deleting')
      expect(rows[0]?.objectKey).toBe(`users/${userAId}/src/tmp/${assetId}`)

      // Important fix(lost-CAS orphan): この呼出の putObject は 'success' で
      // finalKey へ物理的に書込済み(GC promote は object_key を書き換えない
      // ため row はどの key も finalKey を指していない)。 §6.4 の row 駆動 GC は
      // 発見できないため、 CAS 負け後に明示 deleteObject(finalKey) される。
      expect(mockDeleteObject).toHaveBeenCalledWith(finalKey)
      expect(mockDeleteObject).toHaveBeenCalledTimes(1)
      expect(r2Store.has(finalKey)).toBe(false)
    })

    // Important fix(coordinator 指摘): 別 mime の concurrent finalize は同じ
    // key へ衝突しない(拡張子が異なる)ため、conditional PUT は両者とも
    // 'success' になる。 CAS が唯一の勝敗判定点になり、 敗者(A)の PUT は
    // 実際に成功しているのにどの行からも参照されない孤児になる —
    // deleteObject で明示的に消されることを確認する。
    it('race: two finalizeSource calls that verify DIFFERENT MIME (no key collision, both PUTs succeed) — the CAS loser\'s own successfully-written orphan is deleted, the winner\'s object is preserved', async () => {
      const assetId = await seedReservedRow(userAId, 'reserved')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const bytesA = pngBytes // A: png
      const bytesB = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } },
      })
        .jpeg()
        .toBuffer() // B: jpeg(別 mime → 別 key)
      const finalKeyA = `users/${userAId}/src/${assetId}.png`
      const finalKeyB = `users/${userAId}/src/${assetId}.jpg`
      const tempKey = `users/${userAId}/src/tmp/${assetId}`

      let tempGetCount = 0
      mockGetObject.mockImplementation(async (key: string) => {
        if (key === tempKey) {
          tempGetCount += 1
          return { bytes: tempGetCount === 1 ? bytesA : bytesB }
        }
        const stored = r2Store.get(key)
        return stored ? { bytes: stored.bytes } : null
      })

      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let reachedFirstPut: (() => void) | undefined
      const firstPutReached = new Promise<void>((resolve) => {
        reachedFirstPut = resolve
      })
      let putCallCount = 0
      mockPutObject.mockImplementation(
        async (
          key: string,
          bytes: Buffer,
          mime: string,
          options?: { ifNoneMatch?: boolean },
        ) => {
          putCallCount += 1
          if (putCallCount === 1) {
            reachedFirstPut!()
            await gate
          }
          if (options?.ifNoneMatch && r2Store.has(key)) {
            return 'precondition_failed'
          }
          r2Store.set(key, { bytes: Buffer.from(bytes), mime })
          return 'success'
        },
      )

      const pA = finalizeSource(assetId) // A: png(finalKeyA へ)。 1回目の putObject でブロックされる。
      await firstPutReached

      const rB = await finalizeSource(assetId) // B: jpeg(finalKeyB へ)。 key 衝突しないため無条件で成功 → CAS 勝利。
      expect(rB.ok).toBe(true)

      releaseGate!() // A の putObject 再開: finalKeyA は誰も書いていない(B は別 key)ため成功する。
      const rA = await pA // だが CAS は 0 行(B が既に reserved→ready 済) → A の書込は孤児化。

      // A は「行は ready」を観測して冪等 ok:true を返す(自分の内容が反映された
      // わけではないが、row 自体は有効な finalize 結果を指しているため)。
      expect(rA.ok).toBe(true)
      expect(putCallCount).toBe(2)

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      const row = rows[0]!
      const expectedHash = createHash('sha256').update(bytesB).digest('hex')
      // row は WINNER(B・jpeg)の内容のみを指す。
      expect(row.status).toBe('ready')
      expect(row.mime).toBe('image/jpeg')
      expect(row.contentHash).toBe(expectedHash)
      expect(row.objectKey).toBe(finalKeyB)

      // A(敗者)の孤児(finalKeyA)は明示 delete、B(勝者)の object は温存。
      // さらに A・B とも row が ready に到達したと観測するため、 それぞれが
      // 共有 temp key の delete を試みる(2 回・冪等・無害)— 合計 3 回
      // (finalKeyA×1 + tempKey×2)、finalKeyB は一度も対象にならない。
      expect(mockDeleteObject).toHaveBeenCalledWith(finalKeyA)
      expect(mockDeleteObject).toHaveBeenCalledWith(tempKey)
      expect(mockDeleteObject).not.toHaveBeenCalledWith(finalKeyB)
      expect(mockDeleteObject).toHaveBeenCalledTimes(3)
      expect(r2Store.has(finalKeyA)).toBe(false)
      expect(r2Store.has(finalKeyB)).toBe(true)
    })

    it('cross-user assetId (owned by another tenant) → { ok: false }, no GET/PUT (owner-scoped SELECT returns 0 rows)', async () => {
      const assetId = await seedReservedRow(userBId)
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const r = await finalizeSource(assetId)
      expect(r.ok).toBe(false)
      expect(mockGetObject).not.toHaveBeenCalled()

      // B の行は無傷。
      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select({ status: sourceAssets.status, userId: sourceAssets.userId })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      expect(rows[0]?.status).toBe('reserved')
      expect(rows[0]?.userId).toBe(userBId)
    })

    // --- Critical fix: concurrent-finalize race (canonical + Codex 独立指摘) ---
    //
    // シナリオ: reserved 行は GET〜verify〜PUT の間 status='reserved' のままで、
    // temp key は client 書換可能。ゆえに同一 assetId への 2 つの finalizeSource
    // 呼出しが「temp key への再アップロード」を挟んで異なるバイトを検証し、
    // 同じ最終 key へ書こうとしうる。 無条件 PUT だと後着が先着の実体を上書きし、
    // CAS の勝者(先に reserved→ready した側)が記録する hash/dims が、 実際に
    // R2 に残るバイト(後から PUT した側)と食い違う(mixed state)。
    //
    // 決定的に再現するため、 real timing に依存せず「一方の finalize を
    // putObject 直前で明示的にブロックし、 もう一方を完走させてから解放する」
    // gate 方式で 2 呼出を制御する(putObject の 1 回目の呼び出しだけをブロック
    // することで、 read-tx が先に完了している方 = ブロックされる側、をテストの
    // 意図通りに固定する)。
    it('race: two finalizeSource calls that verify DIFFERENT bytes for the same source — the loser gets a loud failure, and the row/object end up consistent with the WINNER only (never mixed)', async () => {
      const assetId = await seedReservedRow(userAId, 'reserved')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const bytesA = pngBytes
      const bytesB = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } },
      })
        .png()
        .toBuffer()
      const finalKey = `users/${userAId}/src/${assetId}.png`
      const tempKey = `users/${userAId}/src/tmp/${assetId}`

      // temp key の GET: 呼出順で bytesA → bytesB(client が finalize の合間に
      // temp key へ別バイトを再アップロードした状況を模する)。
      let tempGetCount = 0
      mockGetObject.mockImplementation(async (key: string) => {
        if (key === tempKey) {
          tempGetCount += 1
          return { bytes: tempGetCount === 1 ? bytesA : bytesB }
        }
        const stored = r2Store.get(key)
        return stored ? { bytes: stored.bytes } : null
      })

      // putObject: 1 回目の呼出だけ gate で明示的にブロックする(呼出順 = A が
      // 1 回目・B が 2 回目になるよう、A を先に起動し read-tx 完了を待ってから
      // B を起動する)。
      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let reachedFirstPut: (() => void) | undefined
      const firstPutReached = new Promise<void>((resolve) => {
        reachedFirstPut = resolve
      })
      let putCallCount = 0
      mockPutObject.mockImplementation(
        async (
          key: string,
          bytes: Buffer,
          mime: string,
          options?: { ifNoneMatch?: boolean },
        ) => {
          putCallCount += 1
          if (putCallCount === 1) {
            reachedFirstPut!()
            await gate
          }
          if (options?.ifNoneMatch && r2Store.has(key)) {
            return 'precondition_failed'
          }
          r2Store.set(key, { bytes: Buffer.from(bytes), mime })
          return 'success'
        },
      )

      const pA = finalizeSource(assetId)
      await firstPutReached // A は read-tx + GET(bytesA) + verify 済み、putObject 直前でブロック中。

      const rB = await finalizeSource(assetId) // B は GET(bytesB)→verify→putObject(成功・key未存在)→CAS(成功)まで完走。
      expect(rB.ok).toBe(true)

      releaseGate!()
      const rA = await pA // A の putObject が再開: key は既に B が書込済み → precondition_failed →
      // hash 照合(A自身の hash=hash(bytesA) vs 実体=hash(bytesB))→ 不一致 → loud failure。

      // 敗者(A)は loud failure、CAS を実行しない。
      expect(rA.ok).toBe(false)

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      const row = rows[0]!
      const expectedHash = createHash('sha256').update(bytesB).digest('hex')

      // row は WINNER(B)の内容で ready(A の内容が一部でも混ざっていない)。
      expect(row.status).toBe('ready')
      expect(row.contentHash).toBe(expectedHash)
      expect(row.objectKey).toBe(finalKey)

      // R2 上の実体も WINNER(B)のバイトのみ(mixed state ではない)。
      const stored = r2Store.get(finalKey)
      expect(stored?.bytes.equals(bytesB)).toBe(true)

      // 敗者の putObject は 1 回だけ試みられ(re-PUT していない)、成功していない。
      expect(putCallCount).toBe(2)

      // 敗者(A)は precondition_failed + hash 不一致で CAS 前に loud failure
      // 終了するため、 orphan cleanup にも temp cleanup にも到達しない
      // (deleteObject を一切呼ばない)。 勝者(B)は row が ready に到達したので
      // 共有 temp key を 1 回 delete する。
      expect(mockDeleteObject).toHaveBeenCalledTimes(1)
      expect(mockDeleteObject).toHaveBeenCalledWith(tempKey)
    })

    it('race: two finalizeSource calls that verify the SAME bytes for the same source — both are idempotent-success with a single consistent row (no re-PUT by the loser)', async () => {
      const assetId = await seedReservedRow(userAId, 'reserved')
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const bytes = pngBytes
      const finalKey = `users/${userAId}/src/${assetId}.png`
      const tempKey = `users/${userAId}/src/tmp/${assetId}`

      mockGetObject.mockImplementation(async (key: string) => {
        if (key === tempKey) return { bytes }
        const stored = r2Store.get(key)
        return stored ? { bytes: stored.bytes } : null
      })

      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let reachedFirstPut: (() => void) | undefined
      const firstPutReached = new Promise<void>((resolve) => {
        reachedFirstPut = resolve
      })
      let putCallCount = 0
      mockPutObject.mockImplementation(
        async (
          key: string,
          putBytes: Buffer,
          mime: string,
          options?: { ifNoneMatch?: boolean },
        ) => {
          putCallCount += 1
          if (putCallCount === 1) {
            reachedFirstPut!()
            await gate
          }
          if (options?.ifNoneMatch && r2Store.has(key)) {
            return 'precondition_failed'
          }
          r2Store.set(key, { bytes: Buffer.from(putBytes), mime })
          return 'success'
        },
      )

      const pA = finalizeSource(assetId)
      await firstPutReached

      const rB = await finalizeSource(assetId)
      expect(rB.ok).toBe(true)

      releaseGate!()
      const rA = await pA

      // 同一バイト = byte-identical concurrent finalize → 両方とも成功
      // (A は precondition_failed → hash 一致 → 再 PUT せず CAS へ進み、B が
      // 先に ready 化済みなら A の CAS は 0 行 → 冪等 ok:true に帰着)。
      expect(rA.ok).toBe(true)
      expect(rB.ok).toBe(true)

      const owner = getFixtureOwnerDb()
      const rows = await owner
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
      const row = rows[0]!
      const expectedHash = createHash('sha256').update(bytes).digest('hex')
      expect(row.status).toBe('ready')
      expect(row.contentHash).toBe(expectedHash)
      expect(row.objectKey).toBe(finalKey)

      // r2Store には 1 エントリのみ(A は再 PUT していない)。
      expect(putCallCount).toBe(2) // 呼出は2回(A・B)だが r2Store への実書込は1回のみ
      const stored = r2Store.get(finalKey)
      expect(stored?.bytes.equals(bytes)).toBe(true)

      // Important fix(coordinator 指摘): 同一 mime の byte-identical concurrent
      // finalize(winner の objectKey が自分の finalObjectKey と一致)なら
      // 最終 key を delete してはならない(winner の key を保全)。 A は
      // precondition_failed ゆえ putResult!=='success' で orphan cleanup ガード
      // に弾かれ、 B も CAS 勝ち(currentObjectKey===finalObjectKey)で orphan
      // cleanup ガードに弾かれる — 最終 key は一度も delete 対象にならない。
      // だが A・B とも row が ready に到達したと観測するため、 それぞれが
      // 共有 temp key の delete を試みる(2 回・冪等・無害)。
      expect(mockDeleteObject).not.toHaveBeenCalledWith(finalKey)
      expect(mockDeleteObject).toHaveBeenCalledTimes(2)
      expect(mockDeleteObject).toHaveBeenCalledWith(tempKey)
    })
  })
})
