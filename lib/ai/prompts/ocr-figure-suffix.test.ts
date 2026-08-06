import { describe, it, expect } from 'vitest'
import { buildDiscoverPrompt } from './ocr-extract'
import {
  buildFigureDetectionSuffix,
  buildImageCropExplorationPrompt,
} from './ocr-figure-suffix'

describe('buildImageCropExplorationPrompt', () => {
  it('本番 buildDiscoverPrompt の出力全文を含む (合成は連結のみ、本番文言は不変)', () => {
    const production = buildDiscoverPrompt()
    const exploration = buildImageCropExplorationPrompt()
    expect(exploration).toContain(production)
  })

  it('図版検出 suffix の全文も含む', () => {
    const suffix = buildFigureDetectionSuffix()
    const exploration = buildImageCropExplorationPrompt()
    expect(exploration).toContain(suffix)
  })

  it('production prompt の後ろに suffix が続く構造 (本番部分が壊れていない)', () => {
    const production = buildDiscoverPrompt()
    const suffix = buildFigureDetectionSuffix()
    const exploration = buildImageCropExplorationPrompt()
    expect(exploration.indexOf(production)).toBe(0)
    expect(exploration.indexOf(suffix)).toBeGreaterThan(production.length)
  })

  it('buildDiscoverPrompt() 自体は呼び出しても不変 (side-effect なし)', () => {
    const before = buildDiscoverPrompt()
    buildImageCropExplorationPrompt()
    const after = buildDiscoverPrompt()
    expect(after).toBe(before)
  })
})

describe('buildFigureDetectionSuffix', () => {
  it('source_id ラベルの書き写し指示を含む (spec §5.2)', () => {
    const suffix = buildFigureDetectionSuffix()
    expect(suffix).toContain('source_id')
  })

  it('box_2d の推測禁止・null 契約を明示する (spec §5.1)', () => {
    const suffix = buildFigureDetectionSuffix()
    expect(suffix).toContain('box_2d')
    expect(suffix).toContain('null')
  })

  it('target の語彙 (question / option_{id} / explanation) を明示する', () => {
    const suffix = buildFigureDetectionSuffix()
    expect(suffix).toContain('question')
    expect(suffix).toContain('option_{id}')
    expect(suffix).toContain('explanation')
  })
})

describe('送信 prompt に画像記法テンプレートが無い', () => {
  // 実際に起きた根本原因の直接 pin。本文へ混入していた `![](qNNN-img-N)` は、
  // prompt が持っていた `![](key)` テンプレートと、同 section 内の key 命名規則
  // ("q{sort_key}-img-{連番}") の合成形だった。記法そのものを prompt から消した
  // ので、再び現れないことをここで見る。
  // **語彙全般を禁止する検査には広げない** — 「画像」「Markdown」等を一律で
  // 禁じると、正しい指示(図表参照テキストを残す / images[] に構造化する)まで
  // 書けなくなる。pin するのは混入した記法そのものだけ。
  // 検査対象を **live 経路が実際に送る exploration prompt** にしているのは、
  // discover を verbatim に含む(同 file 冒頭の test で pin 済)ため discover 側の
  // 清浄も含意しつつ、将来 suffix 側へ記法が混入した場合も捕まえられるため。
  it('本文へ埋め込む画像記法テンプレートを含まない', () => {
    expect(buildImageCropExplorationPrompt()).not.toContain('![](')
  })
})
