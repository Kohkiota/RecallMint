import { z } from 'zod'

import type { R2ObjectMeta } from './r2'

// `src/` prefix age-based sweeper — 選定 pure 関数(②-4b spec §3.2/§3.3/§3.6:
// docs/superpowers/specs/2026-08-09-ocr-2-4b-s3-src-sweeper-design.md)。
// I/O なし(listing 結果を受け取り「何を消す候補にするか」を計算するだけ)。
// 実削除・live-op 除外・予算管理・台帳記録は lane orchestration(Task 4)の領分 —
// この file の後半に追記される。domain aggregate ではなく infra 層の GC ロジック
// のため `lib/<context>/domain/` でなく `lib/storage/` に置く(spec §12)。

// 候補化する age 閾値(既定 cutoff・cron 発火時はこの値。手動 GET の
// `?cutoffMinutes=` override はこの定数を差し替えて呼び出す側 — lane 層の責務)。
export const SWEEP_CUTOFF_MS = 6 * 60 * 60 * 1000

// overdue alert の閾値。**cutoffMs パラメータから独立**(OT 裁定・spec §3.6):
// override で cutoff を縮めても、この値は動かない。selectSweepTargets が
// cutoffMs でなくこの定数を直接参照することで機械的に保証する。
export const ALERT_AGE_MS = 72 * 60 * 60 * 1000

// 削除候補の key 規約(spec §3.2): `src/{userId}/{uploadSessionId}/{fileId}.pdf`
// (`lib/media/source-object-key.ts` `sourcePdfObjectKey` の生成規則と一致)。
// uuid 3 セグメントは z.uuid({version:'v4'}) で判定する — 既存慣習と同一判定域
// (`lib/validation/card.ts` isAssetKey / `lib/ocr/prepared-schema.ts`
// uuidV4Schema / `lib/media/source-object-key.ts` と同じ、file ごとに local 定義
// する既存パターンを踏襲。共有 util 化は対象 3 箇所目でも rule of three の範囲外
// = このpin用途だけの新規4本目を追加する判断は本 task の scope 外)。
// z.uuid は大文字 hex を通す(A6 OT 裁定): client 供給の uploadSessionId/fileId
// 由来で大文字を含む正規 key が存在しうるため、uuid セグメントの照合は
// case-insensitive でなければならない。拡張子 `.pdf` と prefix `src/` は生成側が
// 常に固定文字列で埋め込む(サーバー生成・大文字化されない)ため、こちらは
// 意図的に case-sensitive のまま(`.PDF` は不一致として扱う)。
const uuidV4Schema = z.uuid({ version: 'v4' })
// この regex が保証するのは「/」区切りでちょうど 3 セグメントに割れること(境界)
// だけで、各セグメントが uuid の形をしているかは見ていない — 実際の内容 gate は
// 下の z.uuid() 側であり、2 段は冗長ではない。ただし境界の厳格さ自体
// (`[^/]+` を `.+` に緩めても)は zod 側が embedded `/` や不正な形を弾くため
// 現行 test では検出できない(mutation red 検証で確認済み・test は増やさない)。
const SRC_KEY_SEGMENTS_PATTERN = /^src\/([^/]+)\/([^/]+)\/([^/]+)\.pdf$/

/**
 * key が `src/{uuid}/{uuid}/{uuid}.pdf` 規約に一致するか判定し、一致すれば
 * userId(1 セグメント目)を返す。不一致は null。
 */
function matchSrcKeyUserId(key: string): string | null {
  const match = SRC_KEY_SEGMENTS_PATTERN.exec(key)
  if (!match) return null
  const [, userId, uploadSessionId, fileId] = match
  if (
    !uuidV4Schema.safeParse(userId).success ||
    !uuidV4Schema.safeParse(uploadSessionId).success ||
    !uuidV4Schema.safeParse(fileId).success
  ) {
    return null
  }
  return userId
}

export type SweepSelection = {
  // oldest 昇順(最古候補を持つ user が先)— deadline 打ち切り時に最古 garbage を優先し、
  // 毎回同じ後半 user が打ち切られる形にしない(Codex 論点採用)
  candidates: { userId: string; keys: string[]; oldestMs: number }[]
  patternMismatch: string[] // age > cutoff だが key 規約非一致(削除しない・記録のみ)
  overdue: { count: number; oldestKey: string; oldestAgeHours: number } | null
}

/**
 * listing snapshot(spec §3.6「DELETE 実行前の snapshot」)から選定を計算する
 * pure 関数。
 *
 * - candidates: age > cutoffMs かつ key 規約一致の object を userId でグルーピング
 * - patternMismatch: age > cutoffMs だが key 規約不一致(削除しない・記録のみ。
 *   spec §3.2「lifecycle に委ねる」)
 * - overdue: **entries 全体**(pattern 一致/不一致を問わない)に対して
 *   age > ALERT_AGE_MS を評価する。cutoff 未満で候補化されない object も含む
 *   — overdue は「候補選定」でなく「lifecycle 全体が回収し損ねているか」の
 *   独立した監視軸のため(spec §3.6「listing snapshot に対して」)。
 */
export function selectSweepTargets(
  entries: R2ObjectMeta[],
  nowMs: number,
  cutoffMs: number,
): SweepSelection {
  const candidatesByUser = new Map<string, { keys: string[]; oldestMs: number }>()
  const patternMismatch: string[] = []

  for (const entry of entries) {
    const age = nowMs - entry.lastModifiedMs
    if (age <= cutoffMs) continue // ちょうど cutoff は候補外(`>` 比較・spec §3.2)

    const userId = matchSrcKeyUserId(entry.key)
    if (userId === null) {
      patternMismatch.push(entry.key)
      continue
    }

    const bucket = candidatesByUser.get(userId)
    if (bucket) {
      bucket.keys.push(entry.key)
      bucket.oldestMs = Math.min(bucket.oldestMs, entry.lastModifiedMs)
    } else {
      candidatesByUser.set(userId, { keys: [entry.key], oldestMs: entry.lastModifiedMs })
    }
  }

  const candidates = Array.from(candidatesByUser.entries())
    .map(([userId, { keys, oldestMs }]) => ({ userId, keys, oldestMs }))
    .sort((a, b) => a.oldestMs - b.oldestMs)

  let overdueCount = 0
  let oldestOverdueMs: number | null = null
  let oldestOverdueKey = ''
  for (const entry of entries) {
    if (nowMs - entry.lastModifiedMs <= ALERT_AGE_MS) continue // `>` 比較(candidates と同じ規約)
    overdueCount += 1
    if (oldestOverdueMs === null || entry.lastModifiedMs < oldestOverdueMs) {
      oldestOverdueMs = entry.lastModifiedMs
      oldestOverdueKey = entry.key
    }
  }
  const overdue =
    overdueCount === 0 || oldestOverdueMs === null
      ? null
      : {
          count: overdueCount,
          oldestKey: oldestOverdueKey,
          // 整数時間へ丸める(alert 表示・Discord 通知用の値 — 分オーダーの精度は
          // operator の判断に寄与しないため丸める。厳密な ms は必要なら
          // context.objectKey の lastModified を別途読める)。
          oldestAgeHours: Math.round((nowMs - oldestOverdueMs) / (60 * 60 * 1000)),
        }

  return { candidates, patternMismatch, overdue }
}
