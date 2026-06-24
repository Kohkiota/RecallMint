// @vitest-environment jsdom
// AppContainer: 子 render + 既定 class 付与 + className マージ の 3 点を検証する。

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { AppContainer } from './app-container'

afterEach(() => {
  cleanup()
})

describe('AppContainer', () => {
  it('children を描画する', () => {
    render(<AppContainer><span>hello</span></AppContainer>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('wrapper div に既定クラス (max-w-4xl / mx-auto / px-4 / py-8) が付く', () => {
    render(<AppContainer><span>content</span></AppContainer>)
    // children の親要素 (= wrapper div) を取得する
    const wrapper = screen.getByText('content').parentElement as HTMLElement
    expect(wrapper.className).toContain('max-w-4xl')
    expect(wrapper.className).toContain('mx-auto')
    expect(wrapper.className).toContain('px-4')
    expect(wrapper.className).toContain('py-8')
  })

  it('className prop が wrapper div にマージされる', () => {
    render(<AppContainer className="custom-class"><span>content</span></AppContainer>)
    const wrapper = screen.getByText('content').parentElement as HTMLElement
    expect(wrapper.className).toContain('custom-class')
    // 既定クラスも維持される
    expect(wrapper.className).toContain('max-w-4xl')
  })
})
