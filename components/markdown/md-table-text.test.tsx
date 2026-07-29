// @vitest-environment jsdom
// MdTableText — MD 表 read-only renderer(Sprint T T3)の unit test。
// text セグメントは素の text node(要素を足さない)、table セグメントは react-markdown。

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import { MdTableText, MdTableBlock } from './md-table-text'

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

  it('表内画像記法 → <img> も alt も出さない(②-3 契約変更: 本文に画像記法が現れない)', () => {
    // alt は header/body の他セル文字列と衝突しない distinctive な語にする
    // (旧 test は header「薬剤」「画像」連結が alt「薬剤画像」と偶然一致していた)。
    const { container } = render(
      <MdTableText value={'| 名称 | 図 |\n|---|---|\n| A | ![キャプション画像](https://x.test/y.png) |'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    // ②-3: 旧挙動は alt「キャプション画像」を表示していたが、target 単位契約の描画側強制で
    // alt も出さない(inline 画像記法は本文に現れない)。表構造は区切り温存で保持。
    expect(container.textContent).not.toContain('キャプション画像')
    expect(container.querySelector('table')).not.toBeNull()
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

  it('text セグメントの画像記法 → literal も img も出さない(②-3 行ごと除去)', () => {
    const { container } = render(
      <MdTableText value={'問題文は次のとおり。\n\n![下図](q1-img-1)\n続きの本文'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('![')
    expect(container.textContent).not.toContain('q1-img-1')
    expect(container.textContent).toContain('問題文は次のとおり。')
    expect(container.textContent).toContain('続きの本文')
  })

  it('MdTableBlock: 画像除去で表構造が変わっても wrapper 判定と描画が一致(<table> in <p> にしない・Codex r2)', () => {
    // 元は | a | と |---| の間に画像行があり表として無効 → 画像除去で有効な表になる。
    // hasTable 判定と描画を同じ strip 後 segments で行うため、表が出るなら <div> でラップされ
    // <table> が <p> の子にならない(HTML パーサの <p> auto-close による hydration mismatch を防ぐ)。
    const { container } = render(<MdTableBlock value={'| a |\n![x](u)\n|---|\n| 1 |'} />)
    const table = container.querySelector('table')
    // 画像除去で表が有効化する scenario を確実に踏むため table 存在も assert(vacuous 回避)。
    expect(table).not.toBeNull()
    expect(table?.closest('p')).toBeNull()
  })

  it('reference 画像の definition が表を挟んで別セグメントでも除去(complete document parse・Codex P2)', () => {
    // ![x][img] の image 記法と definition [img]: /asset が root-level 表を挟んで別セグメントに
    // 分かれるケース。segment 独立 parse では imageReference が解決されず残るが、whole で strip
    // するため除去される(definition 行そのものは MVP 範囲外で残りうる)。
    const { container } = render(
      <MdTableText value={'前文 ![x][img]\n\n| a |\n|---|\n| 1 |\n\n[img]: /asset'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('![x]')
    expect(container.textContent).toContain('前文')
    expect(container.querySelector('table')).not.toBeNull()
  })
})
