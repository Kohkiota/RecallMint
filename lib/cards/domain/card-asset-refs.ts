// card-asset-refs — cards.images 配列 → card_asset_refs 行への純粋射影。
// Task 11 (②-4a): handleImages (card-field-handlers.ts) と
// scripts/backfill-card-asset-refs.ts が独立に持っていた同一 projection を
// 1 定義へ統合する (drift 防止・rule of three = handleImages + backfill +
// 将来の T12 publisher)。
//
// PURE 制約 (lib/cards domain 前例): Dexie / React / 'use client' を持ち込まない。
// I/O・tx を持たない。 zod / drizzle / next も import しない (許可は `import type` の
// み。 isAssetKey は @/lib/validation/card の関数を runtime import するが、 同
// module 自体は zod schema 定義のみで I/O を持たない)。
//
// 契約: 呼出側は「対象の UUID key が ready + 自 user 所有かどうか」の検証責務を
// 持つ (本関数はそれを検証しない)。
// - handleImages: 呼出前に別 query で全 UUID key の ready+owned を確認済み
//   (確認に失敗すれば本関数を呼ばず 'failed' で return する)。
// - backfill (projectCardRefs): 本関数の出力 (全 UUID key を「ready 前提」で
//   射影した候補 refs) を assetInfos で後段フィルタし、missing/nonReady を分類
//   する。ordinal は「全 UUID key (ready/owned 問わず)」を対象に採番されるため、
//   フィルタ後の refs にはこの ordinal の欠番が生じ得る (旧実装と同じ挙動。この
//   欠番保存契約は scripts/backfill-card-asset-refs.test.ts の「ordinal gap 保存」
//   test で pin 済み — Task 11 fix round 1 Important #1)。
//
// domain purity トレードオフ (Task 11 fix round 1 Important #2・意図的に残す):
// 本 file は lib/cards/domain/** で最初に「実 runtime import」を持つ (兄弟の
// card-rules.ts / card-tag-constraint.ts は import type のみ)。 isAssetKey の
// 実体は `z.uuid({version:'v4'}).safeParse(key).success` であり zod に間接的に
// 結合するが、 domain purity lint (eslint.config.mjs の
// CARD_DOMAIN_NO_INFRA_IMPORTS) はリテラル `'zod'` specifier のみを禁止するため
// 機械的には抵触しない。 これは lint の抜け穴ではなく意図的な判断: UUIDv4 判定は
// 既に isAssetKey が SSoT であり (imageEntrySchema と handleImages が共有し
// drift を防止している)、 本 file がこれを再実装すると SSoT が 2 箇所に分裂し
// drift risk を新たに持ち込む。 本 file は「境界検証」ではなく「既に検証済みの
// データを分類する」だけ (呼出側が ready/owned を検証済み・上記契約参照) なので、
// isAssetKey を import して既存 SSoT に乗ることは domain purity の意図
// (境界検証ロジックを domain に持ち込まない) と矛盾しない。 file 移動 / ローカル
// 再実装 / eslint-disable のいずれも行わない。

import type { CardImage, NewCardAssetRef } from '@/lib/db/schema'
import { isAssetKey } from '@/lib/validation/card'

/**
 * card 1 件の images 配列を card_asset_refs 行に射影する。
 * - UUIDv4 key (isAssetKey) の entry のみ対象。legacy 非 UUID key は対象外
 *   (refs に入らない = images 配列内の二重持ちは意図的な非対称)。
 * - ordinal は同一 field_key (= target) 内で images 配列の出現順に 0-based で
 *   採番する (target 横断の元配列全体順は保存しない)。
 */
export function projectCardAssetRefs(
  cardId: string,
  userId: string,
  images: readonly CardImage[],
): NewCardAssetRef[] {
  const ordinalByField = new Map<string, number>()
  const refs: NewCardAssetRef[] = []
  for (const entry of images) {
    if (!isAssetKey(entry.key)) continue
    const ordinal = ordinalByField.get(entry.target) ?? 0
    ordinalByField.set(entry.target, ordinal + 1)
    refs.push({
      cardId,
      assetId: entry.key,
      userId,
      fieldKey: entry.target,
      ordinal,
    })
  }
  return refs
}
