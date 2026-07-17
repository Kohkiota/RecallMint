// @vitest-environment jsdom
// MD 表 read-only 描画の contract snapshot(Sprint T T3・spec §6)。
// raw innerHTML を prettify せず固定する — react-markdown 生成の thead/tbody・空白 text node
// 込みで「表示仕様」を pin する目的。ライブラリ更新で描画が変われば .snap diff が捕まえる。
// .snap の無条件 -u 禁止(diff を読んで意図した変更のみ受理)。

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import { MdTableText } from '@/components/markdown/md-table-text'
import { REAL_CARD_A, REAL_CARD_B } from '@/tests/fixtures/md-tables'

afterEach(cleanup)

describe('MD table render contract', () => {
  it('実カード A(表が末尾で完結)', () => {
    const { container } = render(<MdTableText value={REAL_CARD_A} />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('実カード B(表直後の本文吸収を pin — GFM 挙動を正として固定)', () => {
    const { container } = render(<MdTableText value={REAL_CARD_B} />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('セル内 raw HTML(rehype-raw 不使用 → 要素化されない)', () => {
    const { container } = render(<MdTableText value={'| a |\n|---|\n| <b>強調</b> |'} />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('セル内 autolink(GFM 裸 URL → <a> 不在・テキスト表示)', () => {
    const { container } = render(
      <MdTableText value={'| 参照 |\n|---|\n| https://example.test/drug-a |'} />,
    )
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('セル内 打消し線(singleTilde:false → 単一 ~x~ は素通し・二重 ~~x~~ のみ <del>)', () => {
    // spec §3.4: 単一チルダを打消し線にしない(セル内 ~注意~ の誤変換防止)。
    // 二重チルダは GFM 標準どおり <del> になる挙動も併せて pin する。
    const { container } = render(
      <MdTableText value={'| a |\n|---|\n| ~注意~ と ~~取消~~ |'} />,
    )
    expect(container.innerHTML).toMatchSnapshot()
  })
})
