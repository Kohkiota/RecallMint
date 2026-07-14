import { getTableConfig, type IndexColumn } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { assets, cardAssetRefs, cards, users } from '@/lib/db/schema'

// Task G1: card_asset_refs — 画像参照の正規化テーブル。
// spec: docs/superpowers/specs/2026-07-13-image-gc-normalized-refs-design.md §4.1
describe('card_asset_refs schema', () => {
  it('has the expected columns', () => {
    const cfg = getTableConfig(cardAssetRefs)
    const columnNames = cfg.columns.map((c) => c.name).sort()
    expect(columnNames).toEqual(
      ['card_id', 'asset_id', 'user_id', 'field_key', 'ordinal'].sort(),
    )
  })

  it('has a composite primary key on (card_id, field_key, ordinal)', () => {
    const cfg = getTableConfig(cardAssetRefs)
    expect(cfg.primaryKeys).toHaveLength(1)
    const pkColumnNames = cfg.primaryKeys[0].columns.map((c) => c.name)
    expect(pkColumnNames).toEqual(['card_id', 'field_key', 'ordinal'])
  })

  it('has an index on asset_id', () => {
    const cfg = getTableConfig(cardAssetRefs)
    const assetIdx = cfg.indexes.find((i) => i.config.name === 'card_asset_refs_asset_idx')
    expect(assetIdx).toBeDefined()
    const idxColumnNames = assetIdx!.config.columns.map((c) => (c as IndexColumn).name)
    expect(idxColumnNames).toEqual(['asset_id'])
  })

  it('card_id references cards.id with onDelete cascade', () => {
    const cfg = getTableConfig(cardAssetRefs)
    const fk = cfg.foreignKeys.find((f) => {
      const ref = f.reference()
      return ref.foreignColumns[0]?.table === cards && ref.foreignColumns[0]?.name === 'id'
    })
    expect(fk).toBeDefined()
    expect(fk!.onDelete).toBe('cascade')
  })

  it('asset_id references assets.id with onDelete restrict', () => {
    const cfg = getTableConfig(cardAssetRefs)
    const fk = cfg.foreignKeys.find((f) => {
      const ref = f.reference()
      return ref.foreignColumns[0]?.table === assets && ref.foreignColumns[0]?.name === 'id'
    })
    expect(fk).toBeDefined()
    expect(fk!.onDelete).toBe('restrict')
  })

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(cardAssetRefs)
    const fk = cfg.foreignKeys.find((f) => {
      const ref = f.reference()
      return ref.foreignColumns[0]?.table === users && ref.foreignColumns[0]?.name === 'id'
    })
    expect(fk).toBeDefined()
    expect(fk!.onDelete).toBe('cascade')
  })
})
