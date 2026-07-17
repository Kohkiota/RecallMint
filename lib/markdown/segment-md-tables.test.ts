import { describe, it, expect } from 'vitest'

import {
  REAL_CARD_A,
  REAL_CARD_B,
  SURROGATE,
  TABLE_BLOCK,
  SURROGATE_BEFORE,
  SURROGATE_IN_CELL,
  SURROGATE_AFTER,
  SURROGATE_ALL,
} from '@/tests/fixtures/md-tables'
import { segmentMdTables, type MdSegment } from './segment-md-tables'

// 連結復元: segments の value を順に連結すると入力と string 完全一致する(offset ずれ =
// テキスト重複/消失の検出。spec §4 不変条件②)。
const reconstruct = (segments: MdSegment[]) => segments.map((s) => s.value).join('')

describe('segmentMdTables', () => {
  describe('連結復元 property(全 fixture で入力と === 一致)', () => {
    const cases: Array<[string, string]> = [
      ['実カード A(表末尾)', REAL_CARD_A],
      ['実カード B(表直後に本文吸収)', REAL_CARD_B],
      ['サロゲート: 表より前', SURROGATE_BEFORE],
      ['サロゲート: 表内セル', SURROGATE_IN_CELL],
      ['サロゲート: 表より後', SURROGATE_AFTER],
      ['サロゲート: 3 箇所', SURROGATE_ALL],
      ['表なし文章', 'ただの文章です。\n1. リスト風の行\n    インデント行'],
      ['空文字列', ''],
      ['表のみ', '| a | b |\n|---|---|\n| 1 | 2 |'],
      ['前後に文章 + 表', 'まえがき\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nあとがき'],
    ]
    it.each(cases)('%s', (_label, input) => {
      expect(reconstruct(segmentMdTables(input))).toBe(input)
    })
  })

  describe('サロゲートペア: offset が UTF-16 code unit である証明(境界 assert・唯一の危険経路)', () => {
    // whole-branch review Minor#1: 連結復元(concat===input)は「任意の連続分割」で常に成立
    // するため、offset が code point 単位でも通ってしまう(= 危険経路を検出しない)。真に
    // load-bearing にするには **セグメント境界** を assert する。code point 単位 offset なら、
    // 表より前のサロゲートペア 1 個につき境界が 1 UTF-16 単位ズレ、table セグメント値が
    // 先頭に余分な文字を含む/欠く形で崩れる。以下は UTF-16 offset のときだけ通る。
    it('表より前のペア: text=ペア込み前置き / table=表ちょうど(境界がズレない)', () => {
      const segs = segmentMdTables(SURROGATE_BEFORE)
      expect(segs).toEqual([
        { type: 'text', value: `${SURROGATE}責の注意\n` },
        { type: 'table', value: TABLE_BLOCK },
      ])
    })
    it('表内セルのペア: 表全体が 1 table セグメント(セル内容が保たれる)', () => {
      const segs = segmentMdTables(SURROGATE_IN_CELL)
      expect(segs).toEqual([{ type: 'table', value: SURROGATE_IN_CELL }])
    })
    it('表より後のペア: table=表ちょうど / text=ペア込み後書き', () => {
      const segs = segmentMdTables(SURROGATE_AFTER)
      expect(segs).toEqual([
        { type: 'table', value: TABLE_BLOCK },
        { type: 'text', value: `\n\n${SURROGATE}責の後書き` },
      ])
    })
    it('3 箇所すべて: 各境界がサロゲート数だけズレず正確', () => {
      const segs = segmentMdTables(SURROGATE_ALL)
      expect(segs).toEqual([
        { type: 'text', value: `${SURROGATE}前\n` },
        { type: 'table', value: `| ${SURROGATE} | b |\n|---|---|\n| 1 | ${SURROGATE} |` },
        { type: 'text', value: `\n\n${SURROGATE}後` },
      ])
    })
  })

  describe('表 0 個 → text 1 個(現状と同一・空文字含む)', () => {
    it('表なし文章 → [{text}] のみ', () => {
      const input = 'ただの文章です。\n本文が続く。'
      expect(segmentMdTables(input)).toEqual([{ type: 'text', value: input }])
    })
    it('空文字列 → [{text:""}]', () => {
      expect(segmentMdTables('')).toEqual([{ type: 'text', value: '' }])
    })
    it('区切り行なし → 表にならない(生記号のまま text)', () => {
      const input = '| a | b |\n| 1 | 2 |'
      expect(segmentMdTables(input)).toEqual([{ type: 'text', value: input }])
    })
    it('ヘッダーと区切り行の列数不一致 → 表にならない', () => {
      const input = '| a | b |\n|---|\n| 1 | 2 |'
      expect(segmentMdTables(input)).toEqual([{ type: 'text', value: input }])
    })
  })

  describe('root 直下の table のみ(入れ子は現状維持)', () => {
    it('blockquote 内の表は table セグメント化しない', () => {
      const input = '> 前置き\n> | a | b |\n> |---|---|\n> | 1 | 2 |'
      const segs = segmentMdTables(input)
      expect(segs.every((s) => s.type === 'text')).toBe(true)
      expect(reconstruct(segs)).toBe(input)
    })
    it('list 内の表は table セグメント化しない', () => {
      const input = '- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |'
      const segs = segmentMdTables(input)
      expect(segs.every((s) => s.type === 'text')).toBe(true)
      expect(reconstruct(segs)).toBe(input)
    })
  })

  describe('位置ごとの table セグメント化', () => {
    it('先頭の表(前に空 text を作らない)', () => {
      const input = '| a | b |\n|---|---|\n| 1 | 2 |\n\nあとがき'
      const segs = segmentMdTables(input)
      expect(segs[0].type).toBe('table')
      expect(segs.filter((s) => s.value === '')).toHaveLength(0)
      expect(reconstruct(segs)).toBe(input)
    })
    it('末尾の表(実カード A: 後に空 text を作らない)', () => {
      const segs = segmentMdTables(REAL_CARD_A)
      expect(segs).toHaveLength(2)
      expect(segs[0].type).toBe('text')
      expect(segs[1].type).toBe('table')
      expect(segs[1].value.startsWith('| 基礎疾患等')).toBe(true)
      expect(reconstruct(segs)).toBe(REAL_CARD_A)
    })
    it('表直後の本文吸収(実カード B: 後続非空行が table に取り込まれる = GFM 挙動を正として pin)', () => {
      const segs = segmentMdTables(REAL_CARD_B)
      // 先頭パラグラフ(text)+ 表(後続本文を吸収)の 2 セグメント
      expect(segs).toHaveLength(2)
      expect(segs[0].type).toBe('text')
      expect(segs[0].value.startsWith('次の表は、')).toBe(true)
      expect(segs[1].type).toBe('table')
      // 吸収の確証: 後続の選択肢行(d てんかん)が table セグメントに含まれる
      expect(segs[1].value.includes('d てんかん')).toBe(true)
      expect(reconstruct(segs)).toBe(REAL_CARD_B)
    })
    it('複数の表(間の text を保持)', () => {
      const input = '| a |\n|---|\n| 1 |\n\n間の文章\n\n| b |\n|---|\n| 2 |'
      const segs = segmentMdTables(input)
      expect(segs.filter((s) => s.type === 'table')).toHaveLength(2)
      expect(segs.some((s) => s.type === 'text' && s.value.includes('間の文章'))).toBe(true)
      expect(reconstruct(segs)).toBe(input)
    })
    it('連続する表(間の blank 行 text を保持し空セグメントは作らない)', () => {
      // GFM 上、2 表は blank 行区切り必須。間の "\n\n" は text セグメントとして保持され、
      // 空文字 value のセグメントは生じない。
      const input = '| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |'
      const segs = segmentMdTables(input)
      expect(segs.filter((s) => s.type === 'table')).toHaveLength(2)
      expect(segs.some((s) => s.type === 'text' && s.value === '\n\n')).toBe(true)
      expect(segs.filter((s) => s.value === '')).toHaveLength(0)
      expect(reconstruct(segs)).toBe(input)
    })
  })
})
