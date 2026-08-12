// client-db の versioned upgrade (v10 → v12) を fake-indexeddb 上で実走する pin。
//
// なぜ必要か: 既存 DB への upgrade path は通常の test で走らない (test は毎回まっさらな
// IDB に最新 schema を作るだけ) ため、 v11 の store drop / v12 の再作成が実際に効くか、
// 無関係 store のデータが巻き添えで消えないかを検証する経路が存在しなかった (spec §5.3)。
//
// 手順: 素の Dexie で v1〜v10 を宣言して DB 名 'recallmint' を構築 → user_settings 行 /
// 旧 shape (user_id 無し) の entity_mutations pending 行 / exams 行を seed → close →
// 実 `ClientDb` (v1〜v12) を open して upgrade を実走させ、 post-condition を assert する。
//
// v10 fixture は過去 version = 不変の歴史的事実なので client-db.ts から一度きり転記して
// 凍結する (v13 以降が足されても本 fixture は変えない・spec §5.3)。
//
// DB 名は実 `ClientDb` と同じ 'recallmint' を使う (upgrade 対象そのものを開くため)。
// fake-indexeddb の registry は worker process 生存中は残るので、 各 test の前後で
// 明示 delete して他 test への version state 漏れを断つ (Task 1 spike の指摘)。
// close は `openedDbs` + afterEach に集約する — assertion が throw した時に handle が
// 開いたままだと afterEach の delete が接続待ちで hang し、 最初の失敗が原因ごと
// 隠れてしまうため (close を assertion の後ろに直書きしない)。

import Dexie from 'dexie'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ClientDb } from '@/lib/client-db'

const DB_NAME = 'recallmint'

// client-db.ts の v1〜v10 宣言からの転記 (凍結 fixture)。
function declareV1toV10(db: Dexie): void {
  db.version(1).stores({
    exams: 'id, user_id, updated_at, content_version',
    cards:
      'id, exam_id, user_id, due, updated_at, content_version, sync_status',
    user_settings: 'user_id',
    study_sessions: 'session_id, exam_id, mode, status, sync_status',
    answer_events: '++local_id, event_id, session_id, card_id, sync_status',
    card_mutations: '++local_id, mutation_id, card_id, sync_status',
    sync_meta: 'key',
  })
  db.version(2).stores({
    study_days: '[user_id+day], user_id, day',
  })
  db.version(3).stores({
    card_mutations: null,
    entity_mutations:
      '++local_id, mutation_id, [entity_type+entity_id], sync_status',
  })
  db.version(4).stores({
    tag_categories: 'id, user_id, updated_at',
    tag_options: 'id, user_id, category_id, updated_at',
  })
  db.version(5).stores({
    card_tags: '[card_id+option_id], card_id, option_id, user_id',
  })
  db.version(6).stores({
    cards:
      'id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id]',
  })
  db.version(7).stores({
    cards:
      'id, exam_id, user_id, due, updated_at, content_version, sync_status, [user_id+exam_id], [user_id+due]',
  })
  db.version(8).stores({
    media_assets: 'id, user_id, [user_id+hash], status',
    media_download_jobs: '[user_id+exam_id], user_id, status',
  })
  db.version(9).stores({
    study_sessions: null,
    answer_events: null,
  })
  db.version(10).stores({
    answer_events: '++local_id, &event_id, [user_id+sync_status]',
  })
}

// 各 test が open した handle。 afterEach で必ず close してから DB を消す。
const openedDbs: Dexie[] = []

function track<T extends Dexie>(db: T): T {
  openedDbs.push(db)
  return db
}

async function deleteDb(): Promise<void> {
  await new Dexie(DB_NAME).delete()
}

beforeEach(async () => {
  openedDbs.length = 0
  await deleteDb()
})

afterEach(async () => {
  for (const db of openedDbs) db.close()
  openedDbs.length = 0
  await deleteDb()
})

describe('ClientDb upgrade v10 → v12 (spec §5.3)', () => {
  it('v10 の実データを持つ DB を open すると user_settings が消え entity_mutations が新 index の空 store になり、無関係 store は残る', async () => {
    // --- v10 の DB を構築して seed する ---
    const v10 = track(new Dexie(DB_NAME))
    declareV1toV10(v10)
    await v10.open()
    expect(v10.verno).toBe(10)

    await v10.table('user_settings').put({
      user_id: 'user-1',
      session_limit: 20,
      fsrs_mode: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    // 旧 shape の pending 行 (user_id を持たない = owner-scope 化前の形)。
    await v10.table('entity_mutations').put({
      mutation_id: 'mut-1',
      entity_type: 'card',
      entity_id: 'card-1',
      op: 'update_field',
      patch: { field: 'title', value: 'Old' },
      edited_at: '2026-01-01T00:00:00.000Z',
      sync_status: 'pending',
    })
    await v10.table('exams').put({
      id: 'exam-1',
      user_id: 'user-1',
      name: 'Sample Exam',
      content_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    expect(await v10.table('entity_mutations').count()).toBe(1)
    v10.close()

    // --- 実 ClientDb を open して v11/v12 upgrade を実走させる ---
    const db = track(new ClientDb())
    await db.open()
    expect(db.verno).toBe(12)

    // user_settings store は消える。
    expect(db.tables.map((t) => t.name)).not.toContain('user_settings')

    // entity_mutations は存在するが空 (v11 drop → v12 再作成で旧行は持ち越さない)。
    expect(db.tables.map((t) => t.name)).toContain('entity_mutations')
    expect(await db.entity_mutations.count()).toBe(0)

    // index 集合が v12 宣言どおり。
    const schema = db.table('entity_mutations').schema
    expect(schema.primKey.src).toBe('++local_id')
    expect(schema.indexes.map((i) => i.src).sort()).toEqual(
      ['&mutation_id', '[user_id+sync_status]'].sort(),
    )

    // 無関係 store (exams) の seed 行は残る。
    const exams = await db.exams.toArray()
    expect(exams).toHaveLength(1)
    expect(exams[0]).toMatchObject({ id: 'exam-1', name: 'Sample Exam' })

  })

  it('まっさらな DB は最終 schema (v12) で直接作成される', async () => {
    const db = track(new ClientDb())
    await db.open()

    expect(db.verno).toBe(12)
    expect(db.tables.map((t) => t.name)).not.toContain('user_settings')
    expect(await db.entity_mutations.count()).toBe(0)

    const schema = db.table('entity_mutations').schema
    expect(schema.primKey.src).toBe('++local_id')
    expect(schema.indexes.map((i) => i.src).sort()).toEqual(
      ['&mutation_id', '[user_id+sync_status]'].sort(),
    )

  })

  it('新 store は &mutation_id が unique index として宣言されている', async () => {
    const db = track(new ClientDb())
    await db.open()

    const mutationIdIndex = db
      .table('entity_mutations')
      .schema.indexes.find((i) => i.name === 'mutation_id')
    expect(mutationIdIndex?.unique).toBe(true)

  })
})
