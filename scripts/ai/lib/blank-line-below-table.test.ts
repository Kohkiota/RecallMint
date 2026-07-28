import { describe, it, expect } from 'vitest'
import { REAL_CARD_A, REAL_CARD_B } from '@/tests/fixtures/md-tables'
import { analyzeTablesBlankLine } from './blank-line-below-table'

describe('analyzeTablesBlankLine', () => {
  it('表なし文章 → 空配列', () => {
    expect(analyzeTablesBlankLine('ただの文章です。本文が続く。')).toEqual([])
  })

  it('表が文章末尾で終わる(後続 segment 無し)→ false (実カード A)', () => {
    expect(analyzeTablesBlankLine(REAL_CARD_A)).toEqual([{ tableIndex: 0, hasBlankLineBelow: false }])
  })

  it('表直後に空行なしで本文が続く(GFM が本文を表セグメントに吸収し後続 segment 自体が無くなる・実カード B)→ false', () => {
    // segmentMdTables の既知挙動(spec §2 実測 3・tests/fixtures/md-tables.ts 参照): 表の後に
    // 空行を挟まない非空行は table セグメントに吸収される。結果として「表直後 text segment」
    // 自体が存在しなくなり、実カード A と同じ経路(後続無し)で false になる。
    expect(analyzeTablesBlankLine(REAL_CARD_B)).toEqual([{ tableIndex: 0, hasBlankLineBelow: false }])
  })

  it('表直後(空行なし)に見出し等の別ブロックが続き独立した text segment が存在する → false (比較ロジック本体の経路)', () => {
    // 見出し(#)は GFM 上テーブルを中断する block なので、吸収されず独立 text segment になる
    // (REAL_CARD_B の「後続 segment 自体が消える」経路とは異なる、regex 比較の分岐を通す)。
    const input = '| a | b |\n|---|---|\n| 1 | 2 |\n# 次の節'
    expect(analyzeTablesBlankLine(input)).toEqual([{ tableIndex: 0, hasBlankLineBelow: false }])
  })

  it('表の直後に空行を挟んで本文 → true', () => {
    const input = '| a | b |\n|---|---|\n| 1 | 2 |\n\nあとがき'
    expect(analyzeTablesBlankLine(input)).toEqual([{ tableIndex: 0, hasBlankLineBelow: true }])
  })

  it('表の直後に \\r\\n\\r\\n(CRLF)で空行を挟んで本文 → true', () => {
    const input = '| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\nあとがき'
    expect(analyzeTablesBlankLine(input)).toEqual([{ tableIndex: 0, hasBlankLineBelow: true }])
  })

  it('空白のみの行(不可視の末尾空白)を挟んだ空行 → true (Markdown は空白/タブのみの行も blank line として扱う。OCR/モデル出力が残しがちな不可視空白を誤検知しないための回帰)', () => {
    const input = '| a | b |\n|---|---|\n| 1 | 2 |\n   \nあとがき'
    expect(analyzeTablesBlankLine(input)).toEqual([{ tableIndex: 0, hasBlankLineBelow: true }])
  })

  it('タブのみの行を挟んだ空行 → true', () => {
    const input = '| a | b |\n|---|---|\n| 1 | 2 |\n\t\nあとがき'
    expect(analyzeTablesBlankLine(input)).toEqual([{ tableIndex: 0, hasBlankLineBelow: true }])
  })

  it('空行に見えて実際は非空白コンテンツを含む行 → false (誤検知しない・水平空白のみ許容で改行/実文字は許容しない)', () => {
    // 4 スペース以上のインデントは GFM 上 indented code block となり table を中断する
    // (独立 text segment として残る = 見出しテストと同じ「比較ロジック本体」の分岐)。
    // "    text" は空白のみの行ではなく実コンテンツを持つため hasBlankLineBelow は false。
    const input = '| a | b |\n|---|---|\n| 1 | 2 |\n    text'
    expect(analyzeTablesBlankLine(input)).toEqual([{ tableIndex: 0, hasBlankLineBelow: false }])
  })

  it('複数の表 → table ごとの結果(1つ目=空行あり/2つ目=文章末尾)', () => {
    const input = '| a |\n|---|\n| 1 |\n\n間の文章\n\n| b |\n|---|\n| 2 |'
    expect(analyzeTablesBlankLine(input)).toEqual([
      { tableIndex: 0, hasBlankLineBelow: true },
      { tableIndex: 1, hasBlankLineBelow: false },
    ])
  })
})
