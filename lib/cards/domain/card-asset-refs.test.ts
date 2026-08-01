// card-asset-refs.test.ts — Task 11 (②-4a): 抽出した projectCardAssetRefs 単体の
// 直接 equivalence test。
//
// 目的: handleImages (card-field-handlers.ts) / backfill
// (scripts/backfill-card-asset-refs.ts) が抽出前に独立に持っていた射影ロジックと
// 挙動が完全一致することを、代表的な入力 (UUID/legacy 混在・空・10 件境界) で
// pin する。 期待値は抽出前の実装 (旧 handleImages の refRows ループ / 旧
// projectCardRefs の ordinal 採番) をトレースして得た値であり、
// card-field-handlers.test.ts の「refs 書込」group と
// backfill-card-asset-refs.test.ts の `projectCardRefs` group 双方が抽出後も
// 無変更で green であることが、両 consumer 側からの drift 不在の裏取りになる
// (本ファイルは共有関数そのものの直接 pin)。
import { describe, it, expect } from 'vitest'
import { projectCardAssetRefs } from './card-asset-refs'
import type { CardImage } from '@/lib/db/schema'

const CARD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UUID_1 = '11111111-1111-4111-8111-111111111111'
const UUID_2 = '22222222-2222-4222-8222-222222222222'
const UUID_3 = '33333333-3333-4333-8333-333333333333'

function img(entry: { key: string; target: string; url?: string }): CardImage {
  return { alt: '', ...entry }
}

describe('projectCardAssetRefs', () => {
  it('空配列 → 空配列', () => {
    expect(projectCardAssetRefs(CARD_ID, USER_ID, [])).toEqual([])
  })

  it('単一 UUID entry → ordinal 0 の 1 行', () => {
    const images: CardImage[] = [img({ key: UUID_1, target: 'question_text' })]
    expect(projectCardAssetRefs(CARD_ID, USER_ID, images)).toEqual([
      {
        cardId: CARD_ID,
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
    ])
  })

  it('同一 target 複数 UUID → 配列順に 0-based 連番', () => {
    const images: CardImage[] = [
      img({ key: UUID_1, target: 'question_text' }),
      img({ key: UUID_2, target: 'question_text' }),
      img({ key: UUID_3, target: 'question_text' }),
    ]
    expect(projectCardAssetRefs(CARD_ID, USER_ID, images)).toEqual([
      { cardId: CARD_ID, assetId: UUID_1, userId: USER_ID, fieldKey: 'question_text', ordinal: 0 },
      { cardId: CARD_ID, assetId: UUID_2, userId: USER_ID, fieldKey: 'question_text', ordinal: 1 },
      { cardId: CARD_ID, assetId: UUID_3, userId: USER_ID, fieldKey: 'question_text', ordinal: 2 },
    ])
  })

  it('target 混在 → target 毎に独立採番', () => {
    const images: CardImage[] = [
      img({ key: UUID_1, target: 'question_text' }),
      img({ key: UUID_2, target: 'option:a' }),
      img({ key: UUID_3, target: 'question_text' }),
    ]
    expect(projectCardAssetRefs(CARD_ID, USER_ID, images)).toEqual([
      { cardId: CARD_ID, assetId: UUID_1, userId: USER_ID, fieldKey: 'question_text', ordinal: 0 },
      { cardId: CARD_ID, assetId: UUID_2, userId: USER_ID, fieldKey: 'option:a', ordinal: 0 },
      { cardId: CARD_ID, assetId: UUID_3, userId: USER_ID, fieldKey: 'question_text', ordinal: 1 },
    ])
  })

  it('legacy 非 UUID key (URL 風 key 含む) は除外され、UUID entry の ordinal にも影響しない', () => {
    const images: CardImage[] = [
      img({ key: 'legacy-ocr-ref-1', target: 'question_text' }),
      img({ key: UUID_1, target: 'question_text' }),
      // URL 風 legacy key (非 UUID) — isAssetKey は形式のみで判別するため対象外
      img({ key: 'https://example.com/legacy.png', target: 'question_text' }),
      // 非 v4 UUID (v1) も legacy 扱い (isAssetKey は v4 限定・spec §2.2)
      img({ key: '11111111-1111-1111-8111-111111111111', target: 'question_text' }),
    ]
    expect(projectCardAssetRefs(CARD_ID, USER_ID, images)).toEqual([
      {
        cardId: CARD_ID,
        assetId: UUID_1,
        userId: USER_ID,
        fieldKey: 'question_text',
        ordinal: 0,
      },
    ])
  })

  it('境界: 10 件 (imagesSchema の上限) でも全件が独立 target で正しく射影される', () => {
    const ids = Array.from(
      { length: 10 },
      (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
    )
    const images: CardImage[] = ids.map((key, i) =>
      img({ key, target: `option:opt-${i}` }),
    )
    const result = projectCardAssetRefs(CARD_ID, USER_ID, images)
    expect(result).toHaveLength(10)
    expect(
      result.every(
        (r, i) =>
          r.assetId === ids[i] &&
          r.ordinal === 0 &&
          r.fieldKey === `option:opt-${i}` &&
          r.cardId === CARD_ID &&
          r.userId === USER_ID,
      ),
    ).toBe(true)
  })
})
