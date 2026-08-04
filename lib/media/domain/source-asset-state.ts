// source-asset-state — source_assets の GC 適格判定を集約する純粋 domain module。
//
// ②-4a Task 14b′(2026-08-03・OT 確定で軸反転): source(OCR 元画像)は著作物の
// 疑いゆえ R2 に残さない。**risk 軸 = provenance(asset_derivations)消失は許容 /
// source が R2 に消え残ることは受容しない(最優先)**。旧 T14b(retention GC・
// この module の前バージョン)は逆方向(source を残す)に最適化されていた
// (hasDerivations 保護・completed retain・30 日 retention grace)。本改訂で
// それらを全て撤去し、eligibility を「purge してよいか」だけを問う形へ反転する。
//
// 二層構成(詳細は task-14b-prime-brief.md):
//   層1(主経路) = 呼出元(lib/media/source-purge.ts)が op terminal 遷移の
//     commit 直後に同期 purge する。この module の判定は経由しない(主経路は
//     「この sourceDocument の reserved|ready 全部」を無条件 mark するだけで、
//     grace も op 種別判定も要らない — 呼出元が「まさに今 terminal になった」
//     ことを既に知っているため)。
//   層2(網・二次防御)がこの module の判定を使う: 主経路の取りこぼし
//     (process 中断・claim-lost 放置 op 等)だけを拾う。
//
// PURE 制約(lib/cards/domain/card-rules.ts / asset-state.ts に厳密に倣う): Dexie /
// React / 'use client' / drizzle / @/lib/db / @/lib/logger / server-only / zod / next
// を runtime import しない(許可は import type のみ)。入力のみに依存し副作用を持たない。
//
// live-op 判定の再実装はしない: `op.isLive` は呼出側(scripts/gc-image-assets.ts)が
// SQL `isLiveUploadOperationCondition()`(lib/exams/source-doc-status.ts・T14a が
// NULL-safe 化した共有述語)で計算した結果を注入する opaque boolean として扱う。
//
// 詳細: .superpowers/sdd/2026-07-30-ocr-2-4a-image-figure-crop/task-14b-prime-brief.md

export type SourceAssetStatus = 'reserved' | 'ready' | 'deleting'

// upload_operations の全 status(source lane が参照する範囲)。
export type OwningOperationStatus =
  | 'awaiting_sources'
  | 'claimed'
  | 'prepared'
  | 'completed'
  | 'terminal_failed'

// 所有 operation の情報。null = 該当 source_document を指す upload_operations 行が
// 存在しない(source_document_id が SET NULL 済、または元々 join できない)。
export type OwningOpInfo = {
  status: OwningOperationStatus
  // isLiveUploadOperationCondition() の評価結果。呼出側の SQL が計算した値を
  // そのまま注入する(ここで isLive をゼロから再計算しない)。
  isLive: boolean
} | null

// ---------------------------------------------------------------------------
// isPastGrace — created_at が margin(ミリ秒)より古いか。strict older(ちょうど
// margin は「未満」扱い = まだ猶予がある側で非適格)。
//
// 単位が ms である理由: 旧軸の 30 日 retention grace(日単位)を撤去し、網の
// reserved-not-live promote 専用の分単位 margin(source-purge.ts の
// SOURCE_RESERVED_NET_GRACE_MS)に置き換えたため(brief「grace 新値」節)。
// ---------------------------------------------------------------------------
export function isPastGrace(createdAt: Date, marginMs: number, now: Date): boolean {
  return createdAt.getTime() < now.getTime() - marginMs
}

// ---------------------------------------------------------------------------
// isStaleReservedEligible — Class A(網専用・reserved-not-live):
// status='reserved' AND 所有 op が live でない AND created_at が margin 超。
// op 不在(source_document_id が SET NULL 等)は abandoned 扱いで eligible とする
// (防御既定: 「op 不在の防御既定: reserved は eligible」— 消す方向が新軸)。
//
// 旧軸で存在した completed op の明示 RETAIN(review fix round Finding 2)は撤去。
// completed は isLiveUploadOperationCondition() の対象 status 集合
// (awaiting_sources/claimed/prepared)に含まれないため isLive は元々 false —
// 明示除外しなくても "!op.isLive" だけで completed は当然 eligible 側になる
// (新軸が望む方向)。撤去しても挙動は変わらない(旧ガードは redundant だった)。
//
// hasDerivations パラメータは撤去(旧 Finding 1)。asset_derivations の生存有無に
// 関わらず purge する — provenance 消失は新軸で許容(brief 冒頭「新軸」節)。
// ---------------------------------------------------------------------------
export function isStaleReservedEligible(
  createdAt: Date,
  marginMs: number,
  now: Date,
  op: OwningOpInfo,
): boolean {
  if (!isPastGrace(createdAt, marginMs, now)) return false
  if (op === null) return true
  return !op.isLive
}

// ---------------------------------------------------------------------------
// isTerminalOpReadyEligible — Class B(網専用・terminal-op ready):
// status='ready' AND op.status が completed または terminal_failed。
//
// **grace なし**(brief「grace 新値」: 「ready+op terminal→ deleting・grace なし
// (op terminal = 処理完了ゆえ即時)」)。op terminal は「もう処理しない」の確定
// 事実であり、created_at からの経過時間は無関係 — createdAt/now 引数は持たない。
//
// completed を含める(旧軸は terminal_failed 限定で completed を明示 RETAIN —
// review fix round「completed-retain」)。新軸はこれを撤回: 正常完走した source
// も同じく purge 対象(brief「新軸」冒頭 = 最重要違反だった旧軸の裏返し)。
//
// op 不在は非適格のまま維持(防御既定: positive な terminal 証拠なしに消さない)。
//
// hasDerivations パラメータは撤去(旧 Finding 1 と同じ理由)。
// ---------------------------------------------------------------------------
export function isTerminalOpReadyEligible(op: OwningOpInfo): boolean {
  if (op === null) return false
  return op.status === 'completed' || op.status === 'terminal_failed'
}

// ---------------------------------------------------------------------------
// isSourceAssetGcEligible — status に応じて Class A/B へ dispatch する統合判定
// (網の dry-run preview が使う単一入口)。'deleting' は既に promote 済で「これから
// promote してよいか」の対象外ゆえ常に false(collect 対象かどうかは
// canSweepDeleteSource が別途判定する)。
//
// reservedMarginMs は Class A(reserved)専用(brief「網の reserved-not-live
// promote にのみ margin」)。Class B(ready)は常に grace 無し。
// ---------------------------------------------------------------------------
export function isSourceAssetGcEligible(
  status: SourceAssetStatus,
  createdAt: Date,
  reservedMarginMs: number,
  now: Date,
  op: OwningOpInfo,
): boolean {
  if (status === 'reserved') {
    return isStaleReservedEligible(createdAt, reservedMarginMs, now, op)
  }
  if (status === 'ready') {
    return isTerminalOpReadyEligible(op)
  }
  return false
}

// ---------------------------------------------------------------------------
// canSweepDeleteSource — collect フェーズが処理対象とする status。source_assets に
// asset-state.ts の 'deleted'(crash-marker)相当の state は無い(schema 上
// reserved|ready|deleting のみ)ため、deleting のみが対象。
// ---------------------------------------------------------------------------
export function canSweepDeleteSource(status: SourceAssetStatus): boolean {
  return status === 'deleting'
}
