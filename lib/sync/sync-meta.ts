// sync-meta — Dexie sync_meta table への type-safe な read/write helper
// (S-local-2 Task 1)。 key 文字列タイポ防止 + 将来追加 key の見通し改善。
//
// 役割境界:
// - SYNC_META_KEYS: 既知 key の定数集合。 新規 key 追加はここで型ごと宣言する。
// - getSyncMeta: string value 限定 (本 sprint は ISO8601 cursor のみを想定)。
//   S-local-2 Task 4: 唯一の reader である pull.ts と同時に userId 必須化した。
// - getJsonSyncMeta / setJsonSyncMeta: JSON + zod schema による型付き read/write helper
//   (Grid-1 で導入)。 string helper と共存し、 JSON 値を扱う key 専用。
//   将来 unknown を許す必要が出た場合の「別 helper」 としてここで実現している。
//   S-local-2 Task 3: owner による空間的分離のため userId を必須化し、内部で
//   scopedSyncMetaKey を通す (media cache の /__media/{userId}/{assetId} と同型 —
//   lib/media/cache.ts:10-12)。 遅着 writer が自分の owner 領域にしか書けなくなる。

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

/**
 * string value の read helper。 key は scopedSyncMetaKey で userId 名前空間化する
 * (owner スコープ分離)。 空 userId は builder が throw する。
 */
export async function getSyncMeta(
  key: SyncMetaKey,
  userId: string,
): Promise<string | undefined> {
  const row = await getClientDb().sync_meta.get(scopedSyncMetaKey(key, userId))
  if (!row) return undefined
  return typeof row.value === 'string' ? row.value : undefined
}

// ---------------------------------------------------------------------------
// scopedSyncMetaKey (S-local-2 Task 3)
// ---------------------------------------------------------------------------

/**
 * sync_meta の key を userId で名前空間化する (`${base}:${userId}`)。
 * 遅着した非同期 writer が自分が capture した owner の領域にしか書かないことで、
 * 共有ブラウザのアカウント切替時の race を時間的排他(lock)なしに無害化する
 * (media cache の /__media/{userId}/{assetId} と同型 — lib/media/cache.ts:10-12)。
 * 空 userId は呼出元のバグとして fail-fast する (未認証状態での誤用を早期検出)。
 */
export function scopedSyncMetaKey(base: SyncMetaKey, userId: string): string {
  if (!userId) throw new Error('scopedSyncMetaKey: userId is required')
  return `${base}:${userId}`
}

// ---------------------------------------------------------------------------
// JSON helper (Grid-1 / S-local-2 Task 3: userId 必須化)
// ---------------------------------------------------------------------------

/**
 * JSON + zod schema による型付き read helper。
 * row が存在しない / value が string でない / JSON.parse 失敗 / schema mismatch の
 * いずれかで undefined を返す (caller が存在確認できるよう例外は投げない)。
 * key は scopedSyncMetaKey で userId 名前空間化する (owner スコープ分離)。
 */
export async function getJsonSyncMeta<T>(
  key: SyncMetaKey,
  userId: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const row = await getClientDb().sync_meta.get(scopedSyncMetaKey(key, userId))
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
 * key は scopedSyncMetaKey で userId 名前空間化する (owner スコープ分離)。
 */
export async function setJsonSyncMeta<T>(
  key: SyncMetaKey,
  userId: string,
  value: T,
  schema: z.ZodType<T>,
): Promise<void> {
  const parsed = schema.parse(value)
  await getClientDb().sync_meta.put({
    key: scopedSyncMetaKey(key, userId),
    value: JSON.stringify(parsed),
  })
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

// ---------------------------------------------------------------------------
// ExamViewPrefsV2 schema (Edit-2 Task 4)
// ---------------------------------------------------------------------------

/**
 * 試験一覧 view preference の zod schema (version: 2)。
 * v1 に hiddenColumns (非表示列 id の配列) を追加。 書込は常に v2。
 */
export const examViewPrefsV2Schema = z
  .object({
    version: z.literal(2),
    view: z.enum(['card', 'table']),
    hiddenColumns: z.array(z.string()),
  })
  .strict()

export type ExamViewPrefsV2 = z.infer<typeof examViewPrefsV2Schema>

// ---------------------------------------------------------------------------
// ExamViewPrefsV3 schema (S5-1)
// ---------------------------------------------------------------------------

/**
 * 試験一覧 view preference の zod schema (version: 3)。
 * v2 に pinnedBoundary (列固定境界の列 id / null) を追加。 書込は常に v3。
 */
export const examViewPrefsV3Schema = z
  .object({
    version: z.literal(3),
    view: z.enum(['card', 'table']),
    hiddenColumns: z.array(z.string()),
    pinnedBoundary: z.string().nullable(),
  })
  .strict()

export type ExamViewPrefsV3 = z.infer<typeof examViewPrefsV3Schema>

// ---------------------------------------------------------------------------
// ExamViewPrefsV4 schema (UI fix C: side peek 幅リサイズ + 永続化)
// ---------------------------------------------------------------------------

/**
 * side peek 幅(vw)の有効域 + 既定値。 UI(ドラッグ/矢印キー、exam-card-side-peek.tsx)と
 * schema 正規化(下記 clampPeekWidthVw)の両方がこの定数を SSoT として共有する
 * (範囲の二重管理を避ける)。
 */
export const PEEK_WIDTH_MIN_VW = 25
export const PEEK_WIDTH_MAX_VW = 70
export const PEEK_WIDTH_DEFAULT_VW = 40

/**
 * peekWidthVw を PEEK_WIDTH_MIN_VW〜PEEK_WIDTH_MAX_VW にクランプする。
 *
 * 決定 (UI fix C): 範囲外の値は reject でなく clamp する。 examViewPrefs は 1 record に
 * view/hiddenColumns/pinnedBoundary/peekWidthVw を同居させる単一 JSON blob なので、
 * peekWidthVw だけが範囲外(将来の仕様変更・手動編集等)でも union 読みで record 全体を
 * 捨てて他 3 フィールドの設定まで失わせたくない(reject は他フィールドへの巻き添え損失が
 * 大きく、clamp は無害に丸めるだけで実害がない)。 型として不正な値(非数値・NaN・Infinity)は
 * examViewPrefsV4Schema の z.number() が引き続き reject する(zod 4 は z.number() が既定で
 * NaN/Infinity を弾く。 fix round 1: 旧来の `.finite()` は zod 4.4.1 では no-op — installed
 * 版で実証済 — なので付けない。 構造的不正は既存 V1〜V3 と同じ「union 読みで undefined」扱い)。
 */
export function clampPeekWidthVw(vw: number): number {
  return Math.min(PEEK_WIDTH_MAX_VW, Math.max(PEEK_WIDTH_MIN_VW, vw))
}

/**
 * 試験一覧 view preference の zod schema (version: 4)。
 * v3 に peekWidthVw (side peek 幅・vw 単位) を追加。 書込は常に v4。
 * peekWidthVw は number であることのみ構造検証し、 25〜70 の範囲検証はしない
 * (範囲外は examViewPrefsToV4 が clamp する — 上記 clampPeekWidthVw のコメント参照)。
 * fix round 1: z.number() は zod 4 で既定 NaN/Infinity を reject するため `.finite()` は
 * 付けない(付けても no-op — 上記 clampPeekWidthVw のコメント参照)。
 */
export const examViewPrefsV4Schema = z
  .object({
    version: z.literal(4),
    view: z.enum(['card', 'table']),
    hiddenColumns: z.array(z.string()),
    pinnedBoundary: z.string().nullable(),
    peekWidthVw: z.number(),
  })
  .strict()

export type ExamViewPrefsV4 = z.infer<typeof examViewPrefsV4Schema>

/**
 * 読み取り用 union schema。 v1 / v2 / v3 / v4 の全 record を accept する
 * (version discriminator で分岐)。 書込は examViewPrefsV4Schema を使うこと。
 */
export const examViewPrefsSchema = z.discriminatedUnion('version', [
  examViewPrefsV1Schema,
  examViewPrefsV2Schema,
  examViewPrefsV3Schema,
  examViewPrefsV4Schema,
])

export type ExamViewPrefs = z.infer<typeof examViewPrefsSchema>

/**
 * v1 / v2 / v3 / v4 いずれの record も v4 working shape に正規化する (UI fix C)。
 * v1 → hiddenColumns: [], pinnedBoundary: null, peekWidthVw: PEEK_WIDTH_DEFAULT_VW
 * v2 → hiddenColumns を引き継ぎ, pinnedBoundary: null, peekWidthVw: PEEK_WIDTH_DEFAULT_VW
 * v3 → hiddenColumns/pinnedBoundary を引き継ぎ, peekWidthVw: PEEK_WIDTH_DEFAULT_VW
 * v4 → そのまま passthrough (peekWidthVw は clampPeekWidthVw で防御的に再クランプ)
 */
export function examViewPrefsToV4(
  prefs: ExamViewPrefs,
): {
  view: 'card' | 'table'
  hiddenColumns: string[]
  pinnedBoundary: string | null
  peekWidthVw: number
} {
  if (prefs.version === 4) {
    return {
      view: prefs.view,
      hiddenColumns: prefs.hiddenColumns,
      pinnedBoundary: prefs.pinnedBoundary,
      peekWidthVw: clampPeekWidthVw(prefs.peekWidthVw),
    }
  }
  if (prefs.version === 3) {
    return {
      view: prefs.view,
      hiddenColumns: prefs.hiddenColumns,
      pinnedBoundary: prefs.pinnedBoundary,
      peekWidthVw: PEEK_WIDTH_DEFAULT_VW,
    }
  }
  if (prefs.version === 2) {
    return {
      view: prefs.view,
      hiddenColumns: prefs.hiddenColumns,
      pinnedBoundary: null,
      peekWidthVw: PEEK_WIDTH_DEFAULT_VW,
    }
  }
  // version === 1: hiddenColumns なし
  return { view: prefs.view, hiddenColumns: [], pinnedBoundary: null, peekWidthVw: PEEK_WIDTH_DEFAULT_VW }
}
