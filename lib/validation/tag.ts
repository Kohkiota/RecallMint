// lib/validation/tag.ts — tag_category / tag_option mutation envelope の値検証に
// 共有される field schema 群。 server-only 不付 (= no `import 'server-only'`)、
// `lib/validation/card.ts` の precedent に倣う。
//
// 利用元:
//   - lib/sync/server/entity-mutation-registry.ts (create patch zod)
//   - lib/tags/apply-tag-mutation.ts (update_field dispatch の値検証)
//
// 集約理由: 両 file で inline 化していた `z.string().trim().min(1).max(100)` 等が
// drift する余地を構造的に消す (audit #10)。 message は内部経路のみで surface しないため
// 既定 zod message に委ねる。

import { z } from 'zod'

export const tagNameSchema = z.string().trim().min(1).max(100)
export const tagColorSchema = z.string().max(50).nullable()
export const tagSortKeySchema = z.string().max(100).nullable()
export const tagCategoryIdSchema = z.uuid()
