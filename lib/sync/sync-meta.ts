// sync-meta — Dexie sync_meta table への type-safe な read/write helper
// (S-local-2 Task 1)。 key 文字列タイポ防止 + 将来追加 key の見通し改善。
//
// 役割境界:
// - SYNC_META_KEYS: 既知 key の定数集合。 新規 key 追加はここで型ごと宣言する。
// - getSyncMeta / setSyncMeta: string value 限定 (本 sprint は ISO8601 cursor の
//   みを想定。 将来 unknown を許す必要が出たら別 helper を用意し、 本 helper は
//   string 専用のまま維持して呼出元を狭く保つ)。

import { getClientDb } from '@/lib/client-db'

export const SYNC_META_KEYS = {
  // 統合 /api/pull 増分 cursor。
  cardsCursor: 'cards_cursor',
  examsCursor: 'exams_cursor',
  tombstoneCursor: 'tombstone_cursor',
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
