// lib/sync/shared/parsed-mutation.ts — bulk endpoint の payload 1 件分 envelope schema
// と派生型 `ParsedMutation` を集約する共有 module。
//
// 経緯 (Y-2 T-B3 #1b):
// - 以前は `app/api/entity-mutations/bulk/route.ts` 内 private で `mutationSchema` を
//   定義し、 `type ParsedMutation = z.infer<typeof mutationSchema>` も同 file に閉じて
//   いた。 T-B3 で group helper (`lib/sync/server/group-mutations-by-entity-key.ts`)
//   から型/schema を参照する必要が生じたため、 server-only 不付の shared module に
//   切り出した (helper は server 側だが、 共有 schema は client / test も再利用可能な
//   慣習を `mutation-schemas.ts` precedent に揃える)。
// - `mutationSchema` (本 file) は **bulk-payload-specific envelope** で、 mutation_id /
//   edited_at の metadata を含む。 一方で `lib/sync/shared/mutation-schemas.ts` の
//   `entityMutationEnvelopeSchema` は apply-dispatch 視点の envelope (= patch 型
//   narrowing 用) で metadata を含まない。 2 つは sink が異なるため module を分けた
//   (drift 防止 = 用途を file 名で表す)。
//
// validator 詳細:
// - `mutation_id` / `entity_id` は uuid (bulk endpoint の wire 契約)。
// - `entity_type` / `op` は ここでは `z.string().min(1)` で緩めに通し、 個別の
//   許容組合せは registry (`lib/sync/server/entity-mutation-registry.ts`) 引きで
//   per-mutation failed に倒す既存設計を維持。
// - `patch` も generic record で受け、 内側検証は registry の patch zod に委ねる。

import { z } from 'zod'

export const parsedMutationSchema = z.object({
  mutation_id: z.uuid(),
  entity_type: z.string().min(1),
  entity_id: z.uuid(),
  op: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
  edited_at: z.iso.datetime(),
})

export type ParsedMutation = z.infer<typeof parsedMutationSchema>
