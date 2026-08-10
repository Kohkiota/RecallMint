// 画像 asset GC 日次 cron sprint(spec §3.2)— 第 1 部: SECURITY DEFINER 関数
// public.app_list_asset_gc_user_ids()(migration 0033)の behavioral 保証。
// 第 2 部(cron 本体・Task 8 追記): buildReconcilerDeps + runReconciler(本物・
// deleteObject のみ注入 stub)を実 PG に対して実走し、A/B 2 card が同一 asset を
// 参照する refs↔GC 整合を pin する(証明の空白 #8・spec §9・OT 裁定 4)。
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

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { assets, cardAssetRefs, cards, exams, users } from '@/lib/db/schema'
import { runReconciler, buildReconcilerDeps } from '@/lib/storage/asset-gc'

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

// ---------------------------------------------------------------------------
// Task 8(第 2 部)専用 fixture: card_asset_refs の PK は (card_id, field_key,
// ordinal) で asset_id は PK に入らないため、同一 asset を複数 card から参照
// できる — が、stg 実測(refs_per_asset: 1 が 32 件・2 以上は 0 件)でも既存
// unit test(DI mock)でも、この「複数 card が同一 asset を共有参照する」状態は
// 一度も実 SQL で成立したことがない(証明の空白 #8)。ここで A(cardAId)/
// B(cardBId)の 2 card が同一 assetId を参照する行を実際に INSERT する。
// ---------------------------------------------------------------------------
async function seedSharedAssetTwoCards(label: string): Promise<{
  userId: string
  cardAId: string
  cardBId: string
  assetId: string
  objectKey: string
}> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  const examId = randomUUID()
  const cardAId = randomUUID()
  const cardBId = randomUUID()
  const assetId = randomUUID()
  // seedAsset と同一の object_key 形式(schema.ts コメント §2.1 参照)。
  const objectKey = `users/${userId}/${assetId}.webp`

  await owner.insert(users).values({ id: userId, clerkId: `clerk_gc_shared_${label}_${userId}` })
  await owner.insert(exams).values({ id: examId, userId, name: `GC shared exam ${label}` })
  await owner.insert(assets).values({
    id: assetId,
    userId,
    objectKey,
    mime: 'image/webp',
    byteSize: 100,
    width: 10,
    height: 10,
    hash: `hash_${assetId}`,
    status: 'ready',
    unreferencedAt: null,
  })
  for (const cardId of [cardAId, cardBId]) {
    await owner.insert(cards).values({
      id: cardId,
      userId,
      examId,
      title: `GC shared card ${cardId}`,
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
  }

  return { userId, cardAId, cardBId, assetId, objectKey }
}

// owner 接続での状態読み戻し(status / unreferenced_at のみ)。行が既に DELETE
// 済みなら undefined を返す(collect 後の消滅 assertion 用)。
async function readAssetState(
  assetId: string,
): Promise<{ status: string; unreferencedAt: Date | null } | undefined> {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select({ status: assets.status, unreferencedAt: assets.unreferencedAt })
    .from(assets)
    .where(eq(assets.id, assetId))
  return rows[0]
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

describe('asset GC cron — Task 8: A/B shared-asset refs↔GC 整合 pin(実 SQL・DI mock なし)', () => {
  it('2 card 共有 asset のライフサイクル: 片方の ref 削除では mark が保留され、両方消えて初めて mark→promote→collect が実 SQL で完走する', async () => {
    const owner = getFixtureOwnerDb()
    const { userId, cardAId, cardBId, assetId, objectKey } =
      await seedSharedAssetTwoCards('lifecycle')

    // deleteObject のみ stub。exec は cron lane(asset-gc-lane.ts)と同じ
    // app executor(withTenantTx)— buildReconcilerDeps / runReconciler は本物。
    const deleteObjectMock = vi.fn(async (_objectKey: string) => ({
      ok: true,
      status: 204,
    }))
    const deps = buildReconcilerDeps({
      exec: (fn) => withTenantTx(userId, fn),
      userId,
      deleteObject: deleteObjectMock,
      log: () => {},
    })

    // ① card A の ref だけ削除 → mark 実行 → unreferenced_at は NULL のまま
    // (card B がまだ参照している = refsExists は真のまま)。
    await owner
      .delete(cardAssetRefs)
      .where(and(eq(cardAssetRefs.cardId, cardAId), eq(cardAssetRefs.userId, userId)))
    const summaryA = await runReconciler(
      { sweep: false, dryRun: false, graceDays: 0, userId },
      deps,
    )
    // summary.marked も見る(final state だけでは不十分): markSet の NOT EXISTS が
    // 万一欠落しても、同じ mark 実行内で markClear(EXISTS refs で orphaned_at を
    // 戻す)が直後に走り、B の ref が残っている限り最終状態だけは偶然一致してしまう
    // (実測済 — red 検証 §参照)。summary.marked===0 は markSet 自体が 1 行も触って
    // いないことの直接証拠であり、この masking を回避する。
    expect(summaryA.marked).toBe(0)
    expect(summaryA.cleared).toBe(0)
    const afterA = await readAssetState(assetId)
    expect(afterA?.unreferencedAt).toBeNull()
    expect(afterA?.status).toBe('ready')

    // ② card B の ref も削除 → mark 実行 → unreferenced_at が set される
    // (refsExists がついに偽になる)。
    await owner
      .delete(cardAssetRefs)
      .where(and(eq(cardAssetRefs.cardId, cardBId), eq(cardAssetRefs.userId, userId)))
    await runReconciler({ sweep: false, dryRun: false, graceDays: 0, userId }, deps)
    const afterB = await readAssetState(assetId)
    expect(afterB?.unreferencedAt).not.toBeNull()

    // grace 0 の promote 境界は `unreferenced_at < now()`。mark と promote は別 exec
    // 呼出(= 別 tx = 別 now())なので理論上は自然に満たすが、ms 差という実行環境依存の
    // 余地を残したくないため、owner 接続で unreferenced_at を明示的に過去へ押し戻し
    // 時刻依存をゼロにする(stg smoke runbook
    // docs/audit/2026-07-16-gc-reconciler-smoke4-procedure.md §4 と同型の決定的技法)。
    await owner
      .update(assets)
      .set({ unreferencedAt: sql`now() - interval '1 day'` })
      .where(eq(assets.id, assetId))

    // ③④ grace 0 の sweep 1 回で promote(reserved|ready → deleting)→ collect(R2
    // 削除 stub 呼出 → 行 DELETE)まで実 SQL で通す。summary.promoted は promote の
    // UPDATE ... RETURNING の行数(mock の戻り値でなく実 UPDATE が実際に何行
    // status='deleting' へ遷移させたかの証拠)。
    const summary = await runReconciler(
      { sweep: true, dryRun: false, graceDays: 0, userId },
      deps,
    )
    expect(summary.promoted).toBe(1)
    expect(deleteObjectMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectMock).toHaveBeenCalledWith(objectKey)
    expect(summary.r2DeleteOk).toBe(1)
    expect(summary.reclaimed).toEqual([{ assetId, objectKey }])

    const afterCollect = await readAssetState(assetId)
    expect(afterCollect).toBeUndefined()
  })

  it('self-heal: collect 直前に ref が戻ると deleting → ready に復元され、R2 は未呼出のまま', async () => {
    const owner = getFixtureOwnerDb()
    // mark→promote の実 SQL 遷移は上のテストで pin 済みなので、ここでは collect
    // ループの self-heal 分岐(hasRefs && status==='deleting')に的を絞り、Part 1 の
    // 状態 fixture 規約(owner 直接 seed)で 'deleting' 到達済み状態を用意する。
    const userId = await seedUser('selfheal')
    const assetId = await seedAsset(userId, {
      status: 'deleting',
      unreferencedAt: new Date('2026-07-01T00:00:00.000Z'),
    })

    // 「collect 直前に refs を戻す」= 削除で参照が尽きて deleting へ到達した後、
    // 別カードが再びこの asset を参照し始めた状態を再現する。
    const examId = randomUUID()
    const cardId = randomUUID()
    await owner.insert(exams).values({ id: examId, userId, name: 'GC selfheal exam' })
    await owner.insert(cards).values({
      id: cardId,
      userId,
      examId,
      title: 'GC selfheal card',
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

    const deleteObjectMock = vi.fn(async (_objectKey: string) => ({
      ok: true,
      status: 204,
    }))
    const deps = buildReconcilerDeps({
      exec: (fn) => withTenantTx(userId, fn),
      userId,
      deleteObject: deleteObjectMock,
      log: () => {},
    })

    const summary = await runReconciler(
      { sweep: true, dryRun: false, graceDays: 0, userId },
      deps,
    )
    expect(summary.selfHealed).toBe(1)
    expect(deleteObjectMock).not.toHaveBeenCalled()

    const after = await readAssetState(assetId)
    expect(after?.status).toBe('ready')
    expect(after?.unreferencedAt).toBeNull()
    // negative control: asset row 自体は消えていない(self-heal は行 DELETE でない)。
    expect(after).toBeDefined()
  })
})
