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
  type EnqueueEntityMutationInput,
} from './entity-mutations'

// owner-scope 化 (Sprint B) 以降、 全 helper は user 引数を取る。 既存 test は USER_A を
// 単一 owner として通し、 別 owner (USER_B) との分離は末尾の owner-scope pin で検証する。
const USER_A = 'user-a'
const USER_B = 'user-b'

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
      user_id: USER_A,
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

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].entity_id).toBe(cardId)
  })

  it('edited_at が未指定なら ISO 8601 文字列が自動設定される', async () => {
    const row = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'note' },
    })
    expect(Number.isNaN(Date.parse(row.edited_at))).toBe(false)
  })

  it('edited_at を指定するとその値が使われる', async () => {
    const editedAt = '2026-05-30T10:00:00.000Z'
    const row = await enqueueEntityMutation({
      user_id: USER_A,
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
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'First' },
    })
    const second = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Second' },
    })

    const pending = await getPendingEntityMutations(USER_A)
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
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Title' },
    })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'memo', value: 'Memo' },
    })

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(2)
    // T5: ClientEntityMutation は discriminated union。 本 path は update_field のみ。
    const fields = pending
      .map((r) => (r.patch as { field: string }).field)
      .sort()
    expect(fields).toEqual(['memo', 'title'])
  })

  it('別 card の同 field → 別行 (2 pending、 coalesce しない)', async () => {
    const cardA = newId()
    const cardB = newId()
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardA,
      op: 'update_field',
      patch: { field: 'title', value: 'A' },
    })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardB,
      op: 'update_field',
      patch: { field: 'title', value: 'B' },
    })

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(2)
  })

  it('3 回 enqueue → 最後の patch が残る', async () => {
    const cardId = newId()
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'question_text', value: 'v1' },
    })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'question_text', value: 'v2' },
    })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'question_text', value: 'v3' },
    })

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'question_text', value: 'v3' })
  })

  it('synced 行は coalesce 対象外 — pending 新規行が作られる', async () => {
    const cardId = newId()
    // synced 行を直接 seed
    await getClientDb().entity_mutations.add({
      user_id: USER_A,
      mutation_id: newId(),
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Old (synced)' },
      edited_at: new Date().toISOString(),
      sync_status: 'synced',
    })

    // 同 field に enqueue → synced 行を上書きせず新規 pending 行を作る
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'New (pending)' },
    })

    const pending = await getPendingEntityMutations(USER_A)
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
      user_id: USER_A,
      mutation_id: newId(),
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'memo', value: 'stale' },
      edited_at: new Date().toISOString(),
      sync_status: 'failed',
    })

    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'memo', value: 'fresh' },
    })

    const pending = await getPendingEntityMutations(USER_A)
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
    // T5: create patch は coalesce 検証のみが目的のため、 必須 field (sort_key 等) を
    // 省いた最小 shape を cast で通す (runtime は coalesce key で 1 行集約を確認)。
    const first = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'create',
      patch: { exam_id: examId, title: 'Draft 1', question_text: 'Q1', options: [] },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })
    const second = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'create',
      patch: { exam_id: examId, title: 'Draft 2', question_text: 'Q2', options: [] },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toMatchObject({ title: 'Draft 2' })
    expect(pending[0].mutation_id).toBe(second.mutation_id)
    expect(pending[0].mutation_id).not.toBe(first.mutation_id)
  })

  it('同 card に delete を 2 回 enqueue → pending 1 行', async () => {
    const cardId = newId()
    await enqueueEntityMutation({ user_id: USER_A, entity_type: 'card', entity_id: cardId, op: 'delete', patch: {} })
    await enqueueEntityMutation({ user_id: USER_A, entity_type: 'card', entity_id: cardId, op: 'delete', patch: {} })

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
  })

  it('create と delete は別 key → 別行 (2 pending)', async () => {
    const cardId = newId()
    // T5: 分岐 key 比較が目的のため、 create patch の field は最小 (cast で通す)。
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'create',
      patch: { title: 'New card' },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'delete',
      patch: {},
    })

    const pending = await getPendingEntityMutations(USER_A)
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
    // T5: 意図的に envelope schema 不整合 (field 欠落) で coalesce fallback を test
    // するため cast で通す。 runtime 挙動 (coalesceKey の fallback) は変わらない。
    const cardId = newId()
    const first = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { value: 'first — field key missing' },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })
    const second = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { value: 'second — field key missing' },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })

    const pending = await getPendingEntityMutations(USER_A)
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
    // T5: 意図的 schema 不整合 (field=number) で coalesce fallback を test。 cast 経由。
    const cardId = newId()
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 42, value: 'non-string field first' },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 42, value: 'non-string field second' },
    } as unknown as EnqueueEntityMutationInput & { user_id: string })

    const pending = await getPendingEntityMutations(USER_A)
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
      user_id: USER_A,
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'synced' },
      edited_at: new Date().toISOString(),
      sync_status: 'synced',
    })
    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'failed' },
      edited_at: new Date().toISOString(),
      sync_status: 'failed',
    })
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'pending' },
    })

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].patch).toEqual({ field: 'title', value: 'pending' })
  })

  it('pending が 0 件なら空配列', async () => {
    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// markEntityMutationsSynced
// ---------------------------------------------------------------------------

describe('markEntityMutationsSynced', () => {
  it('指定 mutation_id を synced に遷移させる', async () => {
    const m1 = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'A' },
    })
    const m2 = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'B' },
    })

    await markEntityMutationsSynced([m1.mutation_id])

    const pending = await getPendingEntityMutations(USER_A)
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
        user_id: USER_A,
        entity_type: 'card', entity_id: newId(),
        op: 'update_field',
        patch: { field: 'title', value: String(i) },
      })
      ids.push(m.mutation_id)
    }

    await markEntityMutationsSynced(ids)

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// markEntityMutationsAttempted
// ---------------------------------------------------------------------------

describe('markEntityMutationsAttempted', () => {
  it('flush 試行時に last_attempted_at が書かれる', async () => {
    const m = await enqueueEntityMutation({
      user_id: USER_A,
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
      user_id: USER_A,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: '1' },
    })
    const m2 = await enqueueEntityMutation({
      user_id: USER_A,
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
      user_id: USER_A,
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
      user_id: USER_A,
      mutation_id: freshId,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'fresh' },
      edited_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      sync_status: 'pending',
    })

    const dropped = await dropStalePendingEntityMutations(USER_A, now, DAY_MS)
    expect(dropped).toEqual(['old-id-1'])

    // 古い行は failed
    const staleRow = await db.entity_mutations
      .where('mutation_id')
      .equals('old-id-1')
      .first()
    expect(staleRow!.sync_status).toBe('failed')

    // 新しい行は pending のまま
    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].mutation_id).toBe(freshId)
  })

  it('境界 (ちょうど maxAge) は drop しない', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()
    const boundaryId = newId()
    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: boundaryId,
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'boundary' },
      edited_at: new Date(now - DAY_MS).toISOString(), // ちょうど 24h (残す)
      sync_status: 'pending',
    })

    const dropped = await dropStalePendingEntityMutations(USER_A, now, DAY_MS)
    expect(dropped).toEqual([])

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].mutation_id).toBe(boundaryId)
  })

  it('pending が 0 件なら空配列を返す', async () => {
    const now = Date.now()
    const dropped = await dropStalePendingEntityMutations(USER_A, now, DAY_MS)
    expect(dropped).toEqual([])
  })

  it('synced / failed 行は走査対象外 (pending のみ drop)', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()
    const oldIso = new Date(now - 48 * 60 * 60 * 1000).toISOString()

    // synced の古い行 — drop 対象外
    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'synced old' },
      edited_at: oldIso,
      sync_status: 'synced',
    })
    // failed の古い行 — drop 対象外 (既に failed)
    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: newId(),
      entity_type: 'card', entity_id: newId(),
      op: 'delete',
      patch: {},
      edited_at: oldIso,
      sync_status: 'failed',
    })

    const dropped = await dropStalePendingEntityMutations(USER_A, now, DAY_MS)
    expect(dropped).toEqual([])
  })

  // T-C1: trigger 側 cap が 24h → 30d に延長された後の汎用 helper 動作確認。
  // 30d cap を渡したとき `now - 31d` の pending が failed 隔離されることを pin する。
  // (helper 自体は maxAge を引数で受ける汎用関数のため、 trigger と独立に挙動を確認する)
  it('30d cap で now - 31d pending が failed に隔離される (T-C1 audit §10.3 (b) #4)', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()

    // 31 日前 (30d cap 超 → drop 対象)
    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: 'stale-31d',
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'stale 31d' },
      edited_at: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
      sync_status: 'pending',
    })
    // 29 日前 (30d cap 内 → 残す)
    const freshId = newId()
    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: freshId,
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'fresh 29d' },
      edited_at: new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString(),
      sync_status: 'pending',
    })

    const dropped = await dropStalePendingEntityMutations(USER_A, now, THIRTY_DAYS_MS)
    expect(dropped).toEqual(['stale-31d'])

    // 31d 前の行は failed に隔離 (隔離機構維持、 撤去ではない)
    const staleRow = await db.entity_mutations
      .where('mutation_id')
      .equals('stale-31d')
      .first()
    expect(staleRow!.sync_status).toBe('failed')

    // 29d 前の行は pending のまま
    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(1)
    expect(pending[0].mutation_id).toBe(freshId)
  })

  it('複数の古い pending を一括 drop できる', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const db = getClientDb()
    const staleIds: string[] = []

    for (let i = 0; i < 3; i++) {
      const mid = newId()
      staleIds.push(mid)
      await db.entity_mutations.add({
        user_id: USER_A,
        mutation_id: mid,
        entity_type: 'card', entity_id: newId(),
        op: 'update_field',
        patch: { field: 'title', value: `stale-${i}` },
        edited_at: new Date(now - (26 + i) * 60 * 60 * 1000).toISOString(),
        sync_status: 'pending',
      })
    }

    const dropped = await dropStalePendingEntityMutations(USER_A, now, DAY_MS)
    expect(dropped.sort()).toEqual(staleIds.sort())

    const pending = await getPendingEntityMutations(USER_A)
    expect(pending).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// owner-scope pin (Sprint B・spec §5.3)
//
// 選別 / coalesce / stale 隔離が `[user_id+sync_status]` に閉じ、 別 owner の pending に
// 一切作用しないことを pin する。 client 側の誤送信防止 (認可境界ではない) の実装が
// 効いていることの検出力を持たせるのが目的。
// ---------------------------------------------------------------------------

describe('owner-scope', () => {
  it('getPendingEntityMutations は自 user の pending だけを返す', async () => {
    await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: 'card-a',
      op: 'update_field',
      patch: { field: 'title', value: 'A' },
    })
    await enqueueEntityMutation({
      user_id: USER_B,
      entity_type: 'card', entity_id: 'card-b',
      op: 'update_field',
      patch: { field: 'title', value: 'B' },
    })

    const pendingA = await getPendingEntityMutations(USER_A)
    expect(pendingA).toHaveLength(1)
    expect(pendingA[0].entity_id).toBe('card-a')

    const pendingB = await getPendingEntityMutations(USER_B)
    expect(pendingB).toHaveLength(1)
    expect(pendingB[0].entity_id).toBe('card-b')
  })

  it('coalesce は owner を跨がない — 同 entity・同 field でも user が違えば別行', async () => {
    // 同一 coalesce key (card:card-1:update_field:title) を 2 owner が enqueue する。
    // owner を跨いで畳むと、 一方の編集がもう一方の outbox 行を上書きしてしまう。
    const a = await enqueueEntityMutation({
      user_id: USER_A,
      entity_type: 'card', entity_id: 'card-1',
      op: 'update_field',
      patch: { field: 'title', value: 'from A' },
    })
    const b = await enqueueEntityMutation({
      user_id: USER_B,
      entity_type: 'card', entity_id: 'card-1',
      op: 'update_field',
      patch: { field: 'title', value: 'from B' },
    })

    expect(b.local_id).not.toBe(a.local_id)

    const all = await getClientDb().entity_mutations.toArray()
    expect(all).toHaveLength(2)

    const pendingA = await getPendingEntityMutations(USER_A)
    expect(pendingA).toHaveLength(1)
    expect(pendingA[0].patch).toEqual({ field: 'title', value: 'from A' })

    const pendingB = await getPendingEntityMutations(USER_B)
    expect(pendingB).toHaveLength(1)
    expect(pendingB[0].patch).toEqual({ field: 'title', value: 'from B' })
  })

  it('stale 隔離は owner を跨がない — 別 user の古い pending は failed 化しない', async () => {
    const now = Date.parse('2026-05-30T12:00:00.000Z')
    const DAY = 24 * 60 * 60 * 1000
    const db = getClientDb()
    const staleIso = new Date(now - 48 * 60 * 60 * 1000).toISOString()

    await db.entity_mutations.add({
      user_id: USER_A,
      mutation_id: 'stale-a',
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'stale A' },
      edited_at: staleIso,
      sync_status: 'pending',
    })
    await db.entity_mutations.add({
      user_id: USER_B,
      mutation_id: 'stale-b',
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'stale B' },
      edited_at: staleIso,
      sync_status: 'pending',
    })

    const dropped = await dropStalePendingEntityMutations(USER_A, now, DAY)
    expect(dropped).toEqual(['stale-a'])

    const a = await db.entity_mutations.where('mutation_id').equals('stale-a').first()
    expect(a!.sync_status).toBe('failed')
    const b = await db.entity_mutations.where('mutation_id').equals('stale-b').first()
    expect(b!.sync_status).toBe('pending')
  })
})
