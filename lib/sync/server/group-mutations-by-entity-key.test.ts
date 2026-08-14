// group-mutations-by-entity-key — helper unit test (Y-2 T-B3 #1b)。
//
// 目的: per-mutation tx 順序保証契約 (spec §3.2) の grouping 経路を helper 単体で
// gate する。 route 側並列化 (commit 2) は本 helper の戻り値 (`serialFallback` /
// `groups`) を信頼するため、 ここで invariant を厚く pin する。
//
// 4 case:
//   1. 同一 entity key 内逐次保証 (同 key 3 件 → 1 group / 入力順保持)
//   2. 独立 entity key 間 grouping (5 件異 key → 5 group / 各 1 件 / serialFallback=false)
//   3. 順序破壊 self-throw regression (= 同一 group を Promise.all 化する違反 path
//      を `assertSequentialPath` で踏ませて throw を捕捉)
//   4. cascade-like 1 件混在 → serialFallback=true (4 件すべて subtest で網羅)
//
// helper は registry 引数を取る純関数 (= test mock しやすさ + 案 X 採用判断 §3.1)。

import { describe, it, expect } from 'vitest'
import {
  groupMutationsByEntityKey,
  assertSequentialPath,
} from '@/lib/sync/server/group-mutations-by-entity-key'
import { ENTITY_MUTATION_REGISTRY } from '@/lib/sync/server/entity-mutation-registry'
import type { ParsedMutation } from '@/lib/sync/shared/parsed-mutation'

// ---------------------------------------------------------------------------
// fixture helper — registry の patch zod を実際に通す必要はない (helper は patch を
// 触らず entity_type / entity_id / op のみ参照する) ため、 構造を満たす最小値で構成。
// uuid は固定値で構わない (helper は値の identity を比較しない)。
// ---------------------------------------------------------------------------

const UUID = (n: number): string =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

function buildMutation(
  overrides: Partial<ParsedMutation> & {
    entity_type: string
    entity_id: string
    op: string
  },
  seq: number,
): ParsedMutation {
  return {
    mutation_id: UUID(seq),
    edited_at: '2026-06-13T00:00:00.000Z',
    patch: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// case 1: 同一 entity key 内逐次
// ---------------------------------------------------------------------------

describe('groupMutationsByEntityKey — 同一 entity key 内逐次', () => {
  it('同一 (card, X) の update_field 3 件 → 1 group / 入力順保持 / serialFallback=false', () => {
    const cardId = UUID(100)
    const mutations: ParsedMutation[] = [
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        1,
      ),
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        2,
      ),
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        3,
      ),
    ]

    const result = groupMutationsByEntityKey(mutations, ENTITY_MUTATION_REGISTRY)

    expect(result.serialFallback).toBe(false)
    expect(result.groups.size).toBe(1)
    const key = `card:${cardId}`
    const group = result.groups.get(key)
    expect(group).toBeDefined()
    expect(group).toHaveLength(3)
    // 入力順保持 = mutation_id 順序が UUID(1), UUID(2), UUID(3) と一致
    expect(group!.map((m) => m.mutation_id)).toEqual([UUID(1), UUID(2), UUID(3)])
  })
})

// ---------------------------------------------------------------------------
// case 2: 独立 entity key 間並列対象
// ---------------------------------------------------------------------------

describe('groupMutationsByEntityKey — 独立 entity key 間 grouping', () => {
  it('5 件異なる (card, X1..X5) → 5 group / 各 array 長 1 / serialFallback=false', () => {
    const mutations: ParsedMutation[] = Array.from({ length: 5 }, (_, i) =>
      buildMutation(
        {
          entity_type: 'card',
          entity_id: UUID(200 + i),
          op: 'update_field',
        },
        i + 1,
      ),
    )

    const result = groupMutationsByEntityKey(mutations, ENTITY_MUTATION_REGISTRY)

    expect(result.serialFallback).toBe(false)
    expect(result.groups.size).toBe(5)
    for (let i = 0; i < 5; i++) {
      const key = `card:${UUID(200 + i)}`
      const group = result.groups.get(key)
      expect(group).toBeDefined()
      expect(group).toHaveLength(1)
      expect(group![0].mutation_id).toBe(UUID(i + 1))
    }
    // Map 挿入順 = 入力順 (key 初出順) の確認
    expect(Array.from(result.groups.keys())).toEqual(
      Array.from({ length: 5 }, (_, i) => `card:${UUID(200 + i)}`),
    )
  })
})

// ---------------------------------------------------------------------------
// case 3: 順序破壊 regression (= self-throw path)
// 同一 entity key の group を内部で Promise.all 化する違反 path を invariant assert
// で踏ませる。 通常 path では到達しないが、 将来 caller が誤って parallel mode で
// 同一 group を流す regression を gate する (plan 完了条件 3 番目 directly)。
// ---------------------------------------------------------------------------

describe('groupMutationsByEntityKey — 順序破壊 regression self-guard', () => {
  it('assertSequentialPath: 同一 group を parallel で流すと "ordering violated" を throw', () => {
    const cardId = UUID(300)
    const group: ParsedMutation[] = [
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        1,
      ),
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        2,
      ),
    ]

    expect(() => assertSequentialPath(group, 'parallel')).toThrow(
      'ordering violated',
    )
  })

  it('assertSequentialPath: serial mode / 単一 mutation は throw しない (false positive 防止)', () => {
    const cardId = UUID(301)
    const multi: ParsedMutation[] = [
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        1,
      ),
      buildMutation(
        { entity_type: 'card', entity_id: cardId, op: 'update_field' },
        2,
      ),
    ]
    const single: ParsedMutation[] = [
      buildMutation(
        { entity_type: 'card', entity_id: UUID(302), op: 'update_field' },
        3,
      ),
    ]

    expect(() => assertSequentialPath(multi, 'serial')).not.toThrow()
    expect(() => assertSequentialPath(single, 'parallel')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// case 4: cascade-like 入力 → serial fallback (5 件 subtest)
// 5 件すべて (`card.create` / `card.delete` / `tag_category.delete` /
// `tag_option.delete` / `card_move.move`) を 1 ケースずつ網羅 = flag 立て忘れ
// regression を物理的に塞ぐ。
// ---------------------------------------------------------------------------

describe('groupMutationsByEntityKey — cascade-like 入力 → serial fallback', () => {
  const cascadeOps: Array<{ entity_type: string; op: string }> = [
    { entity_type: 'card', op: 'create' },
    { entity_type: 'card', op: 'delete' },
    { entity_type: 'tag_category', op: 'delete' },
    { entity_type: 'tag_option', op: 'delete' },
    // Grid-3: 1 mutation が N 枚の card 行を書く集約 op。 group key
    // (`card_move:<op instance uuid>`) は対象 card を表現しないため、 同 batch 内の
    // per-card update_field と並走させてはいけない (spec §2.6)。
    { entity_type: 'card_move', op: 'move' },
  ]

  for (const { entity_type, op } of cascadeOps) {
    it(`${entity_type}.${op} を 1 件含む 11 件 mixed → serialFallback=true`, () => {
      // 10 件の非 cascade update_field + 1 件の cascade-like を混在
      const mutations: ParsedMutation[] = []
      for (let i = 0; i < 10; i++) {
        mutations.push(
          buildMutation(
            {
              entity_type: 'card',
              entity_id: UUID(400 + i),
              op: 'update_field',
            },
            i + 1,
          ),
        )
      }
      mutations.push(
        buildMutation(
          {
            entity_type,
            entity_id: UUID(500),
            op,
          },
          11,
        ),
      )

      const result = groupMutationsByEntityKey(
        mutations,
        ENTITY_MUTATION_REGISTRY,
      )

      expect(result.serialFallback).toBe(true)
    })
  }

  it('非 cascade のみ 11 件 → serialFallback=false (negative control)', () => {
    const mutations: ParsedMutation[] = Array.from({ length: 11 }, (_, i) =>
      buildMutation(
        {
          entity_type: 'card',
          entity_id: UUID(600 + i),
          op: 'update_field',
        },
        i + 1,
      ),
    )

    const result = groupMutationsByEntityKey(mutations, ENTITY_MUTATION_REGISTRY)

    expect(result.serialFallback).toBe(false)
  })

  it('未知 (entity_type, op) ペア → cascade トリガにはしない (serialFallback=false 維持)', () => {
    // §4.3 of step 0 design: 未知ペアは registry undefined = cascadeLike false 同等
    // 扱い。 route 側で per-mutation failed に倒れる経路を奪わない。
    const mutations: ParsedMutation[] = [
      buildMutation(
        {
          entity_type: 'unknown_entity',
          entity_id: UUID(700),
          op: 'noop',
        },
        1,
      ),
    ]
    const result = groupMutationsByEntityKey(mutations, ENTITY_MUTATION_REGISTRY)
    expect(result.serialFallback).toBe(false)
  })
})
