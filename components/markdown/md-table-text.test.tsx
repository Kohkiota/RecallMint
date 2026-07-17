// @vitest-environment jsdom
// MdTableText — MD 表 read-only renderer(Sprint T T3)の unit test。
// text セグメントは素の text node(要素を足さない)、table セグメントは react-markdown。

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import { MdTableText } from './md-table-text'

afterEach(cleanup)

describe('MdTableText', () => {
  it('表 0 個 → text node のみ(textContent 一致・要素を足さない)', () => {
    // OT 修正4: React text node は innerHTML で < → &lt; に serialize されるため
    // textContent 比較 + 子要素ゼロ で「要素を足していない」を検証する。
    const value = 'ただの文章 < & > です\n本文が続く'
    const { container } = render(<MdTableText value={value} />)
    expect(container.textContent).toBe(value)
    expect(container.querySelector('*')).toBeNull()
  })

  it('空文字 → 何も描かない', () => {
    const { container } = render(<MdTableText value="" />)
    expect(container.textContent).toBe('')
    expect(container.querySelector('*')).toBeNull()
  })

  it('画像記法 → <img> 不在・alt テキスト表示', () => {
    const { container } = render(
      <MdTableText value={'| 薬剤 | 画像 |\n|---|---|\n| A | ![薬剤画像](https://x.test/y.png) |'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('薬剤画像')
  })

  it('空 alt 画像 → <img> 不在(表示なし)', () => {
    const { container } = render(
      <MdTableText value={'| a |\n|---|\n| ![](https://x.test/y.png) |'} />,
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('リンク記法 → <a> 不在・テキストのみ表示(URL は落ちる)', () => {
    const { container } = render(
      <MdTableText value={'| a |\n|---|\n| [厚労省](https://mhlw.go.jp) |'} />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('厚労省')
    expect(container.textContent).not.toContain('mhlw.go.jp')
  })

  it('単一チルダ → <del> 不在(singleTilde:false)', () => {
    const { container } = render(<MdTableText value={'| a |\n|---|\n| ~注意~ |'} />)
    expect(container.querySelector('del')).toBeNull()
    expect(container.textContent).toContain('~注意~')
  })

  it('セル内 raw HTML → <script> 要素は DOM に出ない(rehype-raw 不使用)', () => {
    const { container } = render(
      <MdTableText value={'| a |\n|---|\n| <script>alert(1)</script> |'} />,
    )
    expect(container.querySelector('script')).toBeNull()
  })

  it('td/th に overflow-wrap:anywhere が当たる(外側列を押さない・構造 assert)', () => {
    const { container } = render(<MdTableText value={'| h |\n|---|\n| d |'} />)
    const th = container.querySelector('th')
    const td = container.querySelector('td')
    expect(th?.className).toContain('overflow-wrap:anywhere')
    expect(td?.className).toContain('overflow-wrap:anywhere')
  })

  it('末尾改行 → renderer は <br> を足さない(補償は call site 責務)', () => {
    const { container } = render(<MdTableText value={'abc\n'} />)
    expect(container.querySelector('br')).toBeNull()
    expect(container.textContent).toBe('abc\n')
  })

  it('表入り → <table> を描画し、前後の text は保持', () => {
    const { container } = render(
      <MdTableText value={'まえがき\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nあとがき'} />,
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.textContent).toContain('まえがき')
    expect(container.textContent).toContain('あとがき')
  })
})
