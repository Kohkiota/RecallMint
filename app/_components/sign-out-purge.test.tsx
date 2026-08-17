// @vitest-environment jsdom
// SignOutPurge client component の test(tag mirror hygiene sprint Task 4 / spec §4.3)。
// useAuth / purgeAllLocalData は mock し、 配線(発火条件と失敗の握り潰し)のみ verify する。
//
// 観点: signed-out 観測で発火 / signed-in で不発火 / isLoaded 前は不発火 /
// signed-in → signed-out の遷移で発火 / UI なし / purge の失敗が上へ漏れない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const { mockUseAuth, mockPurge } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockPurge: vi.fn(async () => {}),
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: mockUseAuth,
}))

vi.mock('@/lib/sync/local-hygiene', () => ({
  purgeAllLocalData: mockPurge,
}))

import { SignOutPurge } from './sign-out-purge'

beforeEach(() => {
  vi.clearAllMocks()
  mockPurge.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('SignOutPurge', () => {
  it('isLoaded かつ signed-out の観測で purge を発火する', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false })

    render(<SignOutPurge />)

    await waitFor(() => expect(mockPurge).toHaveBeenCalledTimes(1))
  })

  it('signed-in では発火しない', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true })

    render(<SignOutPurge />)

    await new Promise((r) => setTimeout(r, 0))
    expect(mockPurge).not.toHaveBeenCalled()
  })

  it('auth 未初期化(isLoaded=false)では発火しない', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: undefined })

    render(<SignOutPurge />)

    await new Promise((r) => setTimeout(r, 0))
    expect(mockPurge).not.toHaveBeenCalled()
  })

  it('signed-in → signed-out の遷移で発火する', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true })
    const { rerender } = render(<SignOutPurge />)
    await new Promise((r) => setTimeout(r, 0))
    expect(mockPurge).not.toHaveBeenCalled()

    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false })
    rerender(<SignOutPurge />)

    await waitFor(() => expect(mockPurge).toHaveBeenCalledTimes(1))
  })

  it('UI は何も描画しない (null)', () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false })

    const { container } = render(<SignOutPurge />)

    expect(container.firstChild).toBeNull()
  })

  it('purge の失敗は握り潰される(呼出側へ漏れない)', async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false })
    mockPurge.mockRejectedValue(new Error('purge failed'))
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)

    render(<SignOutPurge />)
    await waitFor(() => expect(mockPurge).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))

    expect(onUnhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', onUnhandled)
  })
})

// ---------------------------------------------------------------------------
// root layout への mount pin
// ---------------------------------------------------------------------------
// SignOutPurge の唯一の起動点は app/layout.tsx の mount であり、これを外しても
// component 単体 test / typecheck / lint / build は全 green のまま通る(参照が
// layout.tsx と本 test だけのため)。 起動点そのものを pin する
// (repo 教訓「唯一の caller が未 pin」)。
//
// **これは source-text マッチによる pin**(sync-meta-access-audit.test.ts と同型)。
// RootLayout の RTL render は ClerkProvider / next/font を巻き込むため採らない。
// **判定前に JSX コメント(`{/* ... */}`)を除去する**(修正3): 除去しないと
// `{/* <SignOutPurge /> */}` のようにコメントアウトされた mount も toContain が
// green を返してしまう(表記変更より危険な検出漏れ)。 これによりコメントアウトは
// 検出できる。 依然として JSX の表記(self-closing / 属性追加 / import 経路)を
// 変えると偽陰性になりうるので、 mount の書き方を変えるときは本 pin も更新すること。

const ROOT = path.resolve(import.meta.dirname, '../..')

// JSX コメント `{/* ... */}` を除去した source を返す(コメントアウトされた mount を
// toContain / indexOf が「存在する」と誤判定しないようにする)。
function stripJsxComments(source: string): string {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

describe('app/layout.tsx への mount(source-text pin)', () => {
  const layoutSourceRaw = readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8')
  const layoutSource = stripJsxComments(layoutSourceRaw)

  it('root layout が SignOutPurge を import して mount している', () => {
    expect(layoutSource).toContain(
      "from '@/app/_components/sign-out-purge'",
    )
    expect(layoutSource).toContain('<SignOutPurge />')
  })

  it('mount は ClerkProvider 配下にある(useAuth が context を得られる位置)', () => {
    const providerOpen = layoutSource.indexOf('<ClerkProvider')
    const providerClose = layoutSource.indexOf('</ClerkProvider>')
    const mount = layoutSource.indexOf('<SignOutPurge />')

    expect(providerOpen).toBeGreaterThanOrEqual(0)
    expect(mount).toBeGreaterThan(providerOpen)
    expect(providerClose).toBeGreaterThan(mount)
  })
})
