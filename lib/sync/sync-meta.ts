// sync-meta — Dexie sync_meta table への type-safe な read/write helper
// (S-local-2 Task 1)。 key 文字列タイポ防止 + 将来追加 key の見通し改善。
//
// 役割境界:
// - SYNC_META_KEYS: 既知 key の定数集合。 新規 key 追加はここで型ごと宣言する。
// - getSyncMeta / setSyncMeta: string value 限定 (本 sprint は ISO8601 cursor の
//   みを想定。 将来 unknown を許す必要が出たら別 helper を用意し、 本 helper は
//   string 専用のまま維持して呼出元を狭く保つ)。
// - getJsonSyncMeta / setJsonSyncMeta: JSON + zod schema による型付き read/write helper
//   (Grid-1 で導入)。 string helper と共存し、 JSON 値を扱う key 専用。
//   将来 unknown を許す必要が出た場合の「別 helper」 としてここで実現している。

import { z } from 'zod'
import { getClientDb } from '@/lib/client-db'

export const SYNC_META_KEYS = {
  // 統合 /api/pull 増分 cursor。
  cardsCursor: 'cards_cursor',
  examsCursor: 'exams_cursor',
  tombstoneCursor: 'tombstone_cursor',
  tagCategoriesCursor: 'tag_categories_cursor',
  tagOptionsCursor: 'tag_options_cursor',
  // Tag-2b: card_tags は updated_at を持たない junction なので created_at base の cursor。
  cardTagsCursor: 'card_tags_cursor',
  // Grid-1: 試験一覧 view preference (card / table)。 グローバル / 全試験共通 / 単一 key。
  examViewPrefs: 'exam_view_prefs',
} as const

export type SyncMetaKey = (typeof SYNC_META_KEYS)[keyof typeof SYNC_META_KEYS]

export async function getSyncMeta(
  key: SyncMetaKey,
): Promise<string | undefined> {
  const row = await getClientDb().sync_meta.get(key)
  if (!row) return undefined
  return typeof row.value === 'string' ? row.value : undefined
}

export async function setSyncMeta(
  key: SyncMetaKey,
  value: string,
): Promise<void> {
  await getClientDb().sync_meta.put({ key, value })
}

// ---------------------------------------------------------------------------
// JSON helper (Grid-1)
// ---------------------------------------------------------------------------

/**
 * JSON + zod schema による型付き read helper。
 * row が存在しない / value が string でない / JSON.parse 失敗 / schema mismatch の
 * いずれかで undefined を返す (caller が存在確認できるよう例外は投げない)。
 */
export async function getJsonSyncMeta<T>(
  key: SyncMetaKey,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const row = await getClientDb().sync_meta.get(key)
  if (!row || typeof row.value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    return undefined
  }
  const result = schema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/**
 * JSON + zod schema による型付き write helper。
 * schema.parse で validate してから JSON.stringify して Dexie に put する。
 * invalid な value は schema.parse が throw する (caller のバグとして扱う)。
 */
export async function setJsonSyncMeta<T>(
  key: SyncMetaKey,
  value: T,
  schema: z.ZodType<T>,
): Promise<void> {
  const parsed = schema.parse(value)
  await getClientDb().sync_meta.put({ key, value: JSON.stringify(parsed) })
}

// ---------------------------------------------------------------------------
// ExamViewPrefsV1 schema (Grid-1)
// ---------------------------------------------------------------------------

/** 試験一覧 view preference の zod schema (version: 1)。 */
export const examViewPrefsV1Schema = z
  .object({
    version: z.literal(1),
    view: z.enum(['card', 'table']),
  })
  .strict()

export type ExamViewPrefsV1 = z.infer<typeof examViewPrefsV1Schema>
