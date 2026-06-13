// group-mutations-by-entity-key — bulk endpoint で per-mutation tx を順序保証付き
// で選択並列化するための grouping helper (Y-2 T-B3 #1b、 案 X 採用)。
//
// spec §3.2 順序保証契約:
//   - 同一 entity key (= `${entity_type}:${entity_id}`) の mutation 群は **逐次** 適用
//   - 独立 entity key 間は **並列可** (案 X では cascade-like 不在時のみ)
//   - cascade-like / dependent multi-mutation を 1 件でも含む bulk は **全体 serial
//     fallback** で現状経路を丸ごと再利用 (= 並列化リスクを非 cascade に閉じ込める)
//
// 設計判断:
//   - registry を引数で渡す純関数化 (test mock しやすさ、 §4.5)。
//   - Map の挿入順 (ES2015) で「key 初出順 = 入力順」 を保証、 caller は Map iterate
//     順を信頼して結果集約 + response mutation_id 順正規化に使える。
//   - cascade-like 検出時は test 容易性のため **最後まで Map 組み立てた上で**
//     serialFallback を返す (1000 件 max payload では性能差無視可、 §4.5 注)。
//   - 順序破壊 self-guard (`assertSequentialPath`) は同一 group を `Promise.all`
//     で流す違反 path を build/test 時に gate するための export。 通常 path では
//     呼ばれない。 plan 完了条件 3 番目 directly。

import 'server-only'
import { ENTITY_MUTATION_REGISTRY } from '@/lib/sync/server/entity-mutation-registry'
import type { ParsedMutation } from '@/lib/sync/shared/parsed-mutation'

export type GroupResult = {
  groups: Map<string, ParsedMutation[]>
  serialFallback: boolean
}

/**
 * mutations を `${entity_type}:${entity_id}` で group 化し、 cascade-like 1 件でも
 * 検出されたら `serialFallback: true` を返す。
 *
 * - Map の挿入順 = key 初出順 = 入力順 (= response mutation_id 順を入力順に揃える
 *   ための前提)。
 * - 同一 key の value array も入力順を保持 (= 同一 entity 内逐次保証の前提)。
 * - 未知 (entity_type, op) ペアは `cascadeLike: undefined` 扱い = false 同等で通常 path
 *   に落ちる (route 側で per-mutation failed として扱われるため、 serialFallback の
 *   トリガにはしない、 §6 case 4 negative)。
 */
export function groupMutationsByEntityKey(
  mutations: ParsedMutation[],
  registry: typeof ENTITY_MUTATION_REGISTRY,
): GroupResult {
  const groups = new Map<string, ParsedMutation[]>()
  let serialFallback = false

  for (const m of mutations) {
    const key = `${m.entity_type}:${m.entity_id}`
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(m)
    } else {
      groups.set(key, [m])
    }

    // cascade-like 判定。 1 件でも true で全体 serial fallback (案 X)。
    // ?? false で undefined を false に正規化 (未登録 op = 通常 path 維持)。
    const cascadeLike = registry[m.entity_type]?.[m.op]?.cascadeLike ?? false
    if (cascadeLike) {
      serialFallback = true
    }
  }

  return { groups, serialFallback }
}

/**
 * 同一 entity key を持つ mutation 群を `Promise.all` で流す違反 path を gate する
 * dev-time invariant assert (Y-2 T-B3 #1b plan 完了条件 3 番目)。
 *
 * - `executionMode === 'parallel' && group.length > 1` の場合のみ throw する。
 * - serial mode / 単一 mutation は通常 path = no-op で false positive を避ける。
 * - 通常 path では呼ばれない (= group 内 for-of は serial で回す前提)。 caller が
 *   誤って parallel 化する regression のみ throw で検出。
 */
export function assertSequentialPath(
  groupMutations: ParsedMutation[],
  executionMode: 'serial' | 'parallel',
): void {
  if (executionMode === 'parallel' && groupMutations.length > 1) {
    throw new Error('ordering violated')
  }
}
