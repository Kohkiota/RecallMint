// entity-mutations sync helper の test (S-sync-1 で旧 card-mutations を汎用化、
// 挙動不変)。 fake-indexeddb 経由で実 Dexie を動かし、 coalesce / status 遷移 /
// stale drop を verify する。 entity_type='card' でテストする (現状の唯一の entity)。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import {
  enqueueEntityMutation,
  getPendingEntityMutations,
  markEntityMutationsSynced,
  markEntityMutationsAttempted,
  dropStalePendingEntityMutations,
  newId,
} from './entity-mutations'

// 各 test の前に entity_mutations table を全 clear。 fake-indexeddb は process 越しに
// state を持つので .clear() で isolation を保つ。
beforeEach(async () => {
  const db = getClientDb()
  await db.entity_mutations.clear()
})

// ---------------------------------------------------------------------------
// newId
// ---------------------------------------------------------------------------

describe('newId', () => {
  it('v4 UUID 形式の文字列を返す', () => {
    const id = newId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('毎回異なる値を返す', () => {
    const a = newId()
    const b = newId()
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// enqueueEntityMutation — 基本動作
// ---------------------------------------------------------------------------

describe('enqueueEntityMutation — 基本動作', () => {
  it('新規 enqueue で pending 1 行が作成される', async () => {
    const cardId = newId()
    const row = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Hello' },
    })

    expect(row.entity_id).toBe(cardId)
    expect(row.op).toBe('update_field')
    expect(row.sync_status).toBe('pending')
    expect(row.local_id).toBeDefined()
    expect(row.mutation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].entity_id).toBe(cardId)
  })

  it('edited_at が未指定なら ISO 8601 文字列が自動設定される', async () => {
    const row = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'note' },
    })
    expect(Number.isNaN(Date.parse(row.edited_at))).toBe(false)
  })

  it('edited_at を指定するとその値が使われる', async () => {
    const editedAt = '2026-05-30T10:00:00.000Z'
    const row = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'note' },
      edited_at: editedAt,
    })
    expect(row.edited_at).toBe(editedAt)
  })
})

// ---------------------------------------------------------------------------
// enqueueEntityMutation — coalesce (update_field)
// ---------------------------------------------------------------------------

describe('enqueueEntityMutation — coalesce (update_field)', () => {
  it('同 card・同 field に 2 回 enqueue → pending 1 行・最新 patch で上書き', async () => {
    const cardId = newId()
    const first = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'First' },
    })
    const second = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Second' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'title', value: 'Second' })
    // coalesce 後に mutation_id が再採番されている
    expect(pending[0].mutation_id).not.toBe(first.mutation_id)
    expect(pending[0].mutation_id).toBe(second.mutation_id)
    // local_id は変わらない (同じ行の更新)
    expect(pending[0].local_id).toBe(first.local_id)
  })

  it('同 card・別 field への enqueue → 別行 (2 pending)', async () => {
    const cardId = newId()
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Title' },
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'memo', value: 'Memo' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(2)
    const fields = pending.map((r) => r.patch.field).sort()
    expect(fields).toEqual(['memo', 'title'])
  })

  it('別 card の同 field → 別行 (2 pending、 coalesce しない)', async () => {
    const cardA = newId()
    const cardB = newId()
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardA,
      op: 'update_field',
      patch: { field: 'title', value: 'A' },
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardB,
      op: 'update_field',
      patch: { field: 'title', value: 'B' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(2)
  })

  it('3 回 enqueue → 最後の patch が残る', async () => {
    const cardId = newId()
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'question_text', value: 'v1' },
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'question_text', value: 'v2' },
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'question_text', value: 'v3' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'question_text', value: 'v3' })
  })

  it('synced 行は coalesce 対象外 — pending 新規行が作られる', async () => {
    const cardId = newId()
    // synced 行を直接 seed
    await getClientDb().entity_mutations.add({
      mutation_id: newId(),
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Old (synced)' },
      edited_at: new Date().toISOString(),
      sync_status: 'synced',
    })

    // 同 field に enqueue → synced 行を上書きせず新規 pending 行を作る
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'New (pending)' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'title', value: 'New (pending)' })

    // synced 行は変わっていない
    const all = await getClientDb().entity_mutations.toArray()
    expect(all).toHaveLength(2)
    const syncedRow = all.find((r) => r.sync_status === 'synced')
    expect(syncedRow).toBeDefined()
    expect(syncedRow!.patch).toEqual({ field: 'title', value: 'Old (synced)' })
  })

  it('failed 行は coalesce 対象外 — pending 新規行が作られる', async () => {
    const cardId = newId()
    await getClientDb().entity_mutations.add({
      mutation_id: newId(),
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'memo', value: 'stale' },
      edited_at: new Date().toISOString(),
      sync_status: 'failed',
    })

    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'memo', value: 'fresh' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'memo', value: 'fresh' })
  })
})

// ---------------------------------------------------------------------------
// enqueueEntityMutation — coalesce (create / delete)
// ---------------------------------------------------------------------------

describe('enqueueEntityMutation — coalesce (create / delete)', () => {
  it('同 card に create を 2 回 enqueue → pending 1 行・最新 patch', async () => {
    const cardId = newId()
    const examId = newId()
    const first = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'create',
      patch: { exam_id: examId, title: 'Draft 1', question_text: 'Q1', options: [] },
    })
    const second = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'create',
      patch: { exam_id: examId, title: 'Draft 2', question_text: 'Q2', options: [] },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toMatchObject({ title: 'Draft 2' })
    expect(pending[0].mutation_id).toBe(second.mutation_id)
    expect(pending[0].mutation_id).not.toBe(first.mutation_id)
  })

  it('同 card に delete を 2 回 enqueue → pending 1 行', async () => {
    const cardId = newId()
    await enqueueEntityMutation({ entity_type: 'card', entity_id: cardId, op: 'delete', patch: {} })
    await enqueueEntityMutation({ entity_type: 'card', entity_id: cardId, op: 'delete', patch: {} })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
  })

  it('create と delete は別 key → 別行 (2 pending)', async () => {
    const cardId = newId()
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'create',
      patch: { title: 'New card' },
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'delete',
      patch: {},
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// enqueueEntityMutation — coalesce (update_field, field 欠落 fallback)
// ---------------------------------------------------------------------------

describe('enqueueEntityMutation — coalesce (update_field field 欠落 fallback)', () => {
  // この describe block は update_field の field 欠落時の coalesce fallback 挙動を
  // pin する (将来 caller 追加時の誤用検知の足場)。
  // coalesceKey の実装: patch.field が string でない場合 `${card_id}:update_field`
  // にフォールバックするため、同 card への field 欠落 update_field は 1 行に coalesce される。

  it('op=update_field で patch.field 欠落の mutation を同 card に 2 回 enqueue → 1 行に coalesce される', async () => {
    // field キーが無いため coalesceKey は `${card_id}:update_field` で同一になる。
    // 2 回目が 1 回目を上書きし、pending は 1 行のみ残る。
    const cardId = newId()
    const first = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { value: 'first — field key missing' },
    })
    const second = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { value: 'second — field key missing' },
    })

    const pending = await getPendingEntityMutations()
    // field 欠落でも coalesce key が同一になり 1 行のみ残る
    expect(pending).toHaveLength(1)
    // 最新 patch で上書きされる
    expect(pending[0].patch).toEqual({ value: 'second — field key missing' })
    // local_id は変わらない (同じ行の更新)
    expect(pending[0].local_id).toBe(first.local_id)
    // mutation_id は再採番される
    expect(pending[0].mutation_id).toBe(second.mutation_id)
    expect(pending[0].mutation_id).not.toBe(first.mutation_id)
  })

  it('op=update_field で patch.field=非 string の mutation を同 card に 2 回 → 1 行に coalesce される', async () => {
    // patch.field が number など非文字列でも同様にフォールバックし coalesce される。
    const cardId = newId()
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 42, value: 'non-string field first' },
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 42, value: 'non-string field second' },
    })

    const pending = await getPendingEntityMutations()
    // patch.field が非 string のため coalesce key は `${card_id}:update_field` → 1 行
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 42, value: 'non-string field second' })
  })
})

// ---------------------------------------------------------------------------
// getPendingEntityMutations
// ---------------------------------------------------------------------------

describe('getPendingEntityMutations', () => {
  it('pending のみ返す (synced / failed は除外)', async () => {
    const db = getClientDb()
    await db.entity_mutations.add({
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'synced' },
      edited_at: new Date().toISOString(),
      sync_status: 'synced',
    })
    await db.entity_mutations.add({
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'failed' },
      edited_at: new Date().toISOString(),
      sync_status: 'failed',
    })
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'pending' },
    })

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'title', value: 'pending' })
  })

  it('pending が 0 件なら空配列', async () => {
    const pending = await getPendingEntityMutations()
    expect(pending).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// markEntityMutationsSynced
// ---------------------------------------------------------------------------

describe('markEntityMutationsSynced', () => {
  it('指定 mutation_id を synced に遷移させる', async () => {
    const m1 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'A' },
    })
    const m2 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'B' },
    })

    await markEntityMutationsSynced([m1.mutation_id])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].mutation_id).toBe(m2.mutation_id)

    const stored = await getClientDb().entity_mutations
      .where('mutation_id')
      .equals(m1.mutation_id)
      .first()
    expect(stored!.sync_status).toBe('synced')
  })

  it('空配列を渡しても例外にならない', async () => {
    await expect(markEntityMutationsSynced([])).resolves.toBeUndefined()
  })

  it('複数 mutation_id を一括 synced 化できる', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = await enqueueEntityMutation({
        entity_type: 'card', entity_id: newId(),
        op: 'update_field',
        patch: { field: 'title', value: String(i) },
      })
      ids.push(m.mutation_id)
    }

    await markEntityMutationsSynced(ids)

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// markEntityMutationsAttempted
// ---------------------------------------------------------------------------

describe('markEntityMutationsAttempted', () => {
  it('flush 試行時に last_attempted_at が書かれる', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'X' },
    })
    expect(m.last_attempted_at ?? null).toBeNull()

    const nowIso = new Date().toISOString()
    await markEntityMutationsAttempted([m.mutation_id], nowIso)

    const stored = await getClientDb().entity_mutations
      .where('mutation_id')
      .equals(m.mutation_id)
      .first()
    expect(stored!.last_attempted_at).toBe(nowIso)
    // sync_status は変わらない
    expect(stored!.sync_status).toBe('pending')
  })

  it('空配列を渡しても例外にならない', async () => {
    await expect(
      markEntityMutationsAttempted([], new Date().toISOString()),
    ).resolves.toBeUndefined()
  })

  it('複数 mutation の last_attempted_at を一括打刻できる', async () => {
    const m1 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: '1' },
    })
    const m2 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: '2' },
    })
    const ts = '2026-05-30T12:34:56.789Z'
    await markEntityMutationsAttempted([m1.mutation_id, m2.mutation_id], ts)

    for (const id of [m1.mutation_id, m2.mutation_id]) {
      const stored = await getClientDb().entity_mutations
        .where('mutation_id')
        .equals(id)
        .first()
      expect(stored!.last_attempted_at).toBe(ts)
    }
  })
})

// ---------------------------------------------------------------------------
// dropStalePendingEntityMutations
// ---------------------------------------------------------------------------

describe('dropStalePendingEntityMutations', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('edited_at が maxAge より古い pending を failed に隔離し mutation_id を返す', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()

    // 25h 前 (古い)
    await db.entity_mutations.add({
      mutation_id: 'old-id-1',
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'stale' },
      edited_at: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      sync_status: 'pending',
    })
    // 1h 前 (新しい)
    const freshId = newId()
    await db.entity_mutations.add({
      mutation_id: freshId,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'fresh' },
      edited_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      sync_status: 'pending',
    })

    const dropped = await dropStalePendingEntityMutations(now, DAY_MS)
    expect(dropped).toEqual(['old-id-1'])

    // 古い行は failed
    const staleRow = await db.entity_mutations
      .where('mutation_id')
      .equals('old-id-1')
      .first()
    expect(staleRow!.sync_status).toBe('failed')

    // 新しい行は pending のまま
    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].mutation_id).toBe(freshId)
  })

  it('境界 (ちょうど maxAge) は drop しない', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()
    const boundaryId = newId()
    await db.entity_mutations.add({
      mutation_id: boundaryId,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'boundary' },
      edited_at: new Date(now - DAY_MS).toISOString(), // ちょうど 24h (残す)
      sync_status: 'pending',
    })

    const dropped = await dropStalePendingEntityMutations(now, DAY_MS)
    expect(dropped).toEqual([])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    expect(pending[0].mutation_id).toBe(boundaryId)
  })

  it('pending が 0 件なら空配列を返す', async () => {
    const now = Date.now()
    const dropped = await dropStalePendingEntityMutations(now, DAY_MS)
    expect(dropped).toEqual([])
  })

  it('synced / failed 行は走査対象外 (pending のみ drop)', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()
    const oldIso = new Date(now - 48 * 60 * 60 * 1000).toISOString()

    // synced の古い行 — drop 対象外
    await db.entity_mutations.add({
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'synced old' },
      edited_at: oldIso,
      sync_status: 'synced',
    })
    // failed の古い行 — drop 対象外 (既に failed)
    await db.entity_mutations.add({
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'delete',
      patch: {},
      edited_at: oldIso,
      sync_status: 'failed',
    })

    const dropped = await dropStalePendingEntityMutations(now, DAY_MS)
    expect(dropped).toEqual([])
  })

  it('複数の古い pending を一括 drop できる', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()
    const staleIds: string[] = []

    for (let i = 0; i < 3; i++) {
      const mid = newId()
      staleIds.push(mid)
      await db.entity_mutations.add({
        mutation_id: mid,
        entity_type: 'card', entity_id: newId(),
        op: 'update_field',
        patch: { field: 'title', value: `stale-${i}` },
        edited_at: new Date(now - (26 + i) * 60 * 60 * 1000).toISOString(),
        sync_status: 'pending',
      })
    }

    const dropped = await dropStalePendingEntityMutations(now, DAY_MS)
    expect(dropped.sort()).toEqual(staleIds.sort())

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(0)
  })
})
