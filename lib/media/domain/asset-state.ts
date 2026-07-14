// asset-state — asset ライフサイクル状態機械を集約する純粋 domain module。
// 画像 GC v2 Task G2 (DDD 監査 D-1 是正)。DB に CHECK 制約が無い status 列の
// 語彙 SSoT はこの module (assets.status は text 列・migration 0023 時点で
// CHECK なし)。状態遷移: reserved → ready → deleting → deleted。
//
// PURE 制約 (lib/cards/domain/card-rules.ts 前例に厳密に倣う): Dexie / React /
// 'use client' / drizzle / @/lib/db / @/lib/logger / server-only / zod / next
// を runtime import しない (許可は `import type` のみ)。入力のみに依存し
// 副作用を持たない。
//
// 利用側 (R1/G5/W2 で配線・本 task では runtime import ゼロ):
// - asset-actions.ts: finalize 遷移 (canFinalize) / 冪等判定 (isFinalized)
// - reconciler (scripts/gc-image-assets.ts): mark/promote (isSweepEligible /
//   canPromoteToDeleting) / collect (canSweepDelete)
// - handle-clerk-event.ts: user 削除の deleting 遷移 (canPromoteToDeleting)
//
// 詳細: docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md §4.9

export type AssetStatus = 'reserved' | 'ready' | 'deleting' | 'deleted'

// ---------------------------------------------------------------------------
// isSweepEligible — promote (reserved|ready → deleting) の適格判定。
// unreferencedAt が null (未マーク = 参照ありまたは mark 未実行) なら false。
// spec §4.4 の SQL は `unreferenced_at < now() - interval 'N days'` = strict
// older (ちょうど grace 日は含まない)。ここもその意味論に揃え、境界一致は
// false とする (「ちょうど grace は未満扱い」= まだ 1ms でも猶予がある側)。
// ---------------------------------------------------------------------------
export function isSweepEligible(
  unreferencedAt: Date | null,
  graceDays: number,
  now: Date,
): boolean {
  if (unreferencedAt === null) return false
  const graceMs = graceDays * 24 * 60 * 60 * 1000
  const thresholdMs = now.getTime() - graceMs
  return unreferencedAt.getTime() < thresholdMs
}

// ---------------------------------------------------------------------------
// shouldMarkUnreferenced — mark run の set 判定 (orphaned_at をセットするか)。
// mark-eligible status (reserved | ready) + 参照ゼロ + 未マーク
// (unreferencedAt === null) の三条件を満たす時のみ true。spec §4.4 mark set の
// SQL `UPDATE assets SET unreferenced_at=now() WHERE status IN ('reserved','ready')
// AND unreferenced_at IS NULL AND NOT EXISTS(refs)` を pure に写したもの
// (G5 reconciler が消費)。deleting/deleted は promote 済ゆえ mark 対象外。
// ---------------------------------------------------------------------------
export function shouldMarkUnreferenced(
  status: AssetStatus,
  hasRefs: boolean,
  unreferencedAt: Date | null,
): boolean {
  return (
    (status === 'reserved' || status === 'ready') &&
    !hasRefs &&
    unreferencedAt === null
  )
}

// ---------------------------------------------------------------------------
// shouldClearUnreferenced — mark run の clear 判定 (self-heal: 再参照された
// マーク済み asset の orphaned_at を NULL に戻すか)。参照が戻り
// (hasRefs === true) + 現在マーク済み (unreferencedAt !== null) の時のみ true。
// spec §4.4 mark clear の SQL `UPDATE assets SET unreferenced_at=NULL WHERE
// unreferenced_at IS NOT NULL AND EXISTS(refs)` を pure に写したもの。clear は
// status 非依存 (どの status でもマーク済みが再参照されたら解除)。G5 の collect
// 再確認 (deleting → ready 戻し) はこの判定と別に status 遷移を伴うため、本関数は
// orphaned_at の解除可否のみを表す。
// ---------------------------------------------------------------------------
export function shouldClearUnreferenced(
  hasRefs: boolean,
  unreferencedAt: Date | null,
): boolean {
  return hasRefs && unreferencedAt !== null
}

// ---------------------------------------------------------------------------
// isFinalized — status が ready かどうか (R1 の finalize 冪等判定が使う:
// 既に ready なら finalize は no-op として扱う)。
// ---------------------------------------------------------------------------
export function isFinalized(status: AssetStatus): boolean {
  return status === 'ready'
}

// ---------------------------------------------------------------------------
// canFinalize — reserved からのみ ready への遷移 (finalize) を許可する。
// ready からの finalize 再呼び出しは遷移として拒否 (呼び出し側は isFinalized
// で冪等 no-op を先に判定する — canFinalize は「新規に遷移させてよいか」のみ)。
// ---------------------------------------------------------------------------
export function canFinalize(status: AssetStatus): boolean {
  return status === 'reserved'
}

// ---------------------------------------------------------------------------
// canPromoteToDeleting — reserved|ready から deleting への遷移 (sweep の
// promote / user 削除の優先 sweep lane) を許可する。deleting = 回収確定
// (取得権限失効・新規参照不可)。deleting/deleted からの再 promote は不可
// (既に promote 済み・二重遷移を防ぐ)。
// ---------------------------------------------------------------------------
export function canPromoteToDeleting(status: AssetStatus): boolean {
  return status === 'reserved' || status === 'ready'
}

// ---------------------------------------------------------------------------
// canSweepDelete — sweep の collect フェーズが処理対象とする status
// (deleting = R2 削除 + 行 DELETE 未完了 / deleted = R2 済・行 DELETE のみ
// 残る crash マーカー)。reserved/ready は promote を経ていないため対象外。
// ---------------------------------------------------------------------------
export function canSweepDelete(status: AssetStatus): boolean {
  return status === 'deleting' || status === 'deleted'
}

// ---------------------------------------------------------------------------
// allowsNewReference — 新規参照 (handleImages 等) を許すか。ready のみ true。
// 実際の gate は既存 SQL の `eq(assets.status, 'ready')`
// (lib/cards/card-field-handlers.ts) が担うが、その意味論をここに co-locate
// する (SSoT)。reserved はアップロード直後で未 finalize (実体不完全の可能性)、
// deleting/deleted は回収確定後で取得権限が失効している。
// ---------------------------------------------------------------------------
export function allowsNewReference(status: AssetStatus): boolean {
  return status === 'ready'
}
